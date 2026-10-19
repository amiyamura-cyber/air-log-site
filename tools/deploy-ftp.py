# 組み立てたサイト（build-static.mjs の出力）を、会社のサーバー（さくら）の airlog フォルダへ上げる
#
# 使い方（GitHub Actions から）：
#   FTP_HOST=... FTP_USER=... FTP_PASS=... python3 tools/deploy-ftp.py _site_rc
#
# 決まり：
#   ・書き込み・削除は REMOTE_DIR（airlog フォルダ）の中だけ。外を指すパスは止める
#   ・サーバーに .deploy-manifest.json（上げたファイルと中身のハッシュ）を置き、中身が変わったファイルだけ上げる
#   ・前回上げたのに今回ないファイル（自分が上げたものだけ）は消す。自分が上げていないファイルには触らない
#   ・通信は暗号化（FTPS）
import ftplib, hashlib, io, json, os, posixpath, sys, unicodedata

REMOTE_DIR = '/home/rc-group/www/rc-group/airlog'
MANIFEST = '.deploy-manifest.json'

def inside(p):
    p = posixpath.normpath(p)
    if not (p == REMOTE_DIR or p.startswith(REMOTE_DIR + '/')):
        raise SystemExit(f'airlog フォルダの外には書かない: {p}')
    return p

def main():
    src = sys.argv[1]
    local = {}
    paths = {}   # そろえた名前 → 手元の実際のファイル
    for root, _, files in os.walk(src):
        for name in files:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, src).replace(os.sep, '/')
            # Mac は「ブ」を「フ＋゛」に分けた名前（NFD）で持つことがある。ブラウザは1文字（NFC）で探すのでそろえる
            rel = unicodedata.normalize('NFC', rel)
            with open(full, 'rb') as fh:
                local[rel] = hashlib.sha256(fh.read()).hexdigest()
            paths[rel] = full
    if 'index.html' not in local or 'data/index.json' not in local:
        raise SystemExit('index.html か data/index.json が無いので止めました（壊れたサイトを上げない）')

    f = ftplib.FTP_TLS(os.environ['FTP_HOST'], timeout=60)
    f.login(os.environ['FTP_USER'], os.environ['FTP_PASS'])
    f.prot_p()

    remote = {}
    buf = io.BytesIO()
    try:
        f.retrbinary('RETR ' + inside(f'{REMOTE_DIR}/{MANIFEST}'), buf.write)
        remote = json.loads(buf.getvalue() or b'{}')
    except ftplib.error_perm:
        remote = {}

    made = set()
    def ensure_dir(d):
        d = inside(d)
        if d in made or d == REMOTE_DIR:
            return
        ensure_dir(posixpath.dirname(d))
        try:
            f.mkd(d)
        except ftplib.error_perm:
            pass
        made.add(d)

    up = [p for p, h in local.items() if remote.get(p) != h]
    gone = [p for p in remote if p not in local]
    print(f'全 {len(local)} ファイル ／ 上げる {len(up)} ／ 消す {len(gone)}（前回上げて今回ないもの）')

    # 先に記事や画像を上げ、目録（data/index.json）と index.html は最後に上げる（途中で見た人に壊れた状態を見せない）
    last = {'data/index.json', 'data/version.json', 'index.html'}
    for p in sorted(up, key=lambda x: x in last):
        dest = inside(f'{REMOTE_DIR}/{p}')
        ensure_dir(posixpath.dirname(dest))
        with open(paths[p], 'rb') as fh:
            f.storbinary('STOR ' + dest, fh)
    for p in gone:
        try:
            f.delete(inside(f'{REMOTE_DIR}/{p}'))
        except ftplib.error_perm as e:
            print('消せなかった:', p, e)

    f.storbinary('STOR ' + inside(f'{REMOTE_DIR}/{MANIFEST}'), io.BytesIO(json.dumps(local).encode()))
    f.quit()
    print('上げ終わりました')

if __name__ == '__main__':
    main()
