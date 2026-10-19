// 本番サイトを「Firebaseを読まない形」で組み立てる
//
// 使い方：
//   node tools/build-static.mjs --out _site
//
// やること：
//   1. Firestore の posts を全部読む（読むのはこの道具だけ。見に来た人は Firebase を読まない）
//   2. 公開の記事だけを
//        data/index.json        … 一覧に使う項目だけの目録（本文は入れない）
//        data/posts/<id>.json   … 1本ずつ、目次と本文を含めた記事ファイル
//      に書き出す。非公開の記事はどちらにも入れない
//   3. 記事のデータに埋め込まれた表紙画像（data:image/...）は media/covers/ に画像ファイルとして書き出す
//   4. リポジトリのファイル（index.html・admin.html・media など）を一緒に --out へ写す
//
// 決まり：
//   ・Firestore から1本も読めなかったら失敗で止める（空のサイトを出して記事を全部消さない）
//   ・data/version.json に中身のハッシュを書く。10分おきの自動処理は、前回と同じなら公開し直さない
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PROJECT = 'air-log-db';
const outArg = process.argv.indexOf('--out');
if (outArg < 0) throw new Error('--out <出力先> を指定してください');
const OUT = path.resolve(process.argv[outArg + 1]);

// 写さないもの（サイトに要らない・公開しない）
const SKIP = new Set(['.git', '.github', 'tools', 'node_modules', '_site', '.firebase', '.vercel', '.claude', '.gitignore', 'firebase.json', 'firestore.rules']);

function copyRepo(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.env')) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (path.resolve(s) === OUT) continue;
    if (e.isDirectory()) copyRepo(s, d); else fs.copyFileSync(s, d);
  }
}

// Firestore の値を普通の値に直す
function plain(v) {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(plain);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, plain(x)]));
  return undefined;
}

async function readPosts() {
  const posts = [];
  let token = '';
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/posts?pageSize=300${token ? '&pageToken=' + encodeURIComponent(token) : ''}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Firestore を読めなかった: HTTP ${r.status} ${await r.text()}`);
    const j = await r.json();
    for (const d of j.documents || []) {
      const p = Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, plain(v)]));
      p.id = d.name.split('/').pop();
      posts.push(p);
    }
    token = j.nextPageToken || '';
  } while (token);
  return posts;
}

// index.html の isPublicStatus と同じ判定（非公開は出さない）
const isPublicStatus = p => p.status === 'public' || p.status === '公開' || p.status === undefined;

// 一覧に使う項目（index.html の一覧・スライダー・期間判定で使うものだけ）
const LIST_KEYS = ['id', 'title', 'genre', 'displayDate', 'date', 'coverImage', 'coverPositionX', 'coverPositionY', 'status', 'startDate', 'endDate'];
const pick = (p, keys) => Object.fromEntries(keys.filter(k => p[k] !== undefined).map(k => [k, p[k]]));

function writeCover(p) {
  const m = typeof p.coverImage === 'string' && p.coverImage.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return p.coverImage;
  const buf = Buffer.from(m[2], 'base64');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = `${p.id}-${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8)}.${ext}`;
  fs.mkdirSync(path.join(OUT, 'media/covers'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'media/covers', name), buf);
  return `media/covers/${name}`;
}

// 管理画面の updatedAt と同じ形（日本時間の "YYYY/MM/DD HH:MM"）
function jstStamp(d) {
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}/${p(j.getUTCMonth() + 1)}/${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
}

async function main() {
  // 読み始める1分前を「ここから後に更新された記事は本番のページがFirebaseに聞く」の境目にする
  const since = jstStamp(new Date(Date.now() - 60 * 1000));
  const all = await readPosts();
  if (!all.length) throw new Error('Firestore から記事が1本も読めなかったので止めました（空のサイトは出さない）');

  fs.rmSync(OUT, { recursive: true, force: true });
  copyRepo(ROOT, OUT);
  // --allow-index：会社のドメイン（rc-group.co.jp/airlog/）向け。トップページだけ検索よけ（noindex）を外す。
  // 管理画面・サンクスページは検索に出さないまま。github.io 向けは付けたまま
  if (process.argv.includes('--allow-index')) {
    const f = path.join(OUT, 'index.html');
    const before = fs.readFileSync(f, 'utf8');
    const after = before.replace(/<meta name="robots"[^>]*>(<!--[^>]*-->)?\n?/, '');
    if (after === before) throw new Error('--allow-index：index.html に noindex の行が見つからない');
    fs.writeFileSync(f, after);
  }
  // --redirect-to <URL>：旧アドレス（github.io）向け。各ページを「新しいアドレスの同じページへ移る」だけのページにする。
  // ?id=… や #… は引き継ぐ。存在しないページ（404.html）はトップへ。GitHub Pages は 301 を出せないので、ブラウザ側で移す
  const ri = process.argv.indexOf('--redirect-to');
  if (ri >= 0) {
    const base = process.argv[ri + 1].replace(/\/?$/, '/');
    const page = file => {
      const target = base + (file === 'index.html' || file === '404.html' ? '' : file);
      return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="robots" content="noindex">
<link rel="canonical" href="${target}">
<meta http-equiv="refresh" content="0; url=${target}">
<title>エアログは移転しました</title>
<script>location.replace(${JSON.stringify(target)} + ${file === '404.html' ? "''" : 'location.search + location.hash'});</script>
</head><body style="font-family:sans-serif;padding:40px;text-align:center">
<p>エアログは <a href="${target}">${base}</a> に移転しました。自動で移動しない場合はリンクを押してください。</p>
</body></html>
`;
    };
    const htmls = fs.readdirSync(OUT).filter(n => n.endsWith('.html'));
    for (const n of [...new Set([...htmls, '404.html'])]) fs.writeFileSync(path.join(OUT, n), page(n));
    console.log(`旧アドレス向け：${htmls.length + 1} ページを ${base} への転送にしました`);
  }
  fs.mkdirSync(path.join(OUT, 'data/posts'), { recursive: true });

  const pub = all.filter(isPublicStatus);
  const index = [];
  for (const p of pub) {
    const cover = writeCover(p);
    const full = { ...p, coverImage: cover };
    index.push(pick(full, LIST_KEYS));
    fs.writeFileSync(path.join(OUT, 'data/posts', encodeURIComponent(p.id) + '.json'), JSON.stringify(pick(full, [...LIST_KEYS, 'toc', 'content'])));
  }
  const indexJson = JSON.stringify(index);
  fs.writeFileSync(path.join(OUT, 'data/index.json'), indexJson);

  // 中身のハッシュ（記事と、写したファイル全部）
  const h = crypto.createHash('sha256');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach(e => {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else if (!f.endsWith('version.json')) { h.update(path.relative(OUT, f)); h.update(fs.readFileSync(f)); }
  });
  walk(OUT);
  const hash = h.digest('hex');
  // since と ids は本番のページが使う（since より後に更新された記事と、削除された記事を Firebase に聞く）
  fs.writeFileSync(path.join(OUT, 'data/version.json'), JSON.stringify({ hash, builtAt: new Date().toISOString(), since, posts: pub.length, ids: all.map(p => p.id) }));

  console.log(`記事 ${all.length} 本を読み、公開 ${pub.length} 本を書き出しました（非公開 ${all.length - pub.length} 本は出していません）`);
  console.log(`目録 ${Math.round(indexJson.length / 1024)}KB ／ ハッシュ ${hash.slice(0, 12)}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `hash=${hash}\n`);
}
main().catch(e => { console.error('失敗:', e.message); process.exit(1); });
