#!/bin/bash
# 会社のサーバー（https://rc-group.co.jp/airlog/）へ上げる。push したあとに、このMacで動かす
#
#   bash tools/deploy-rc.sh
#
# ・コードを変えたときは push のあとに手で動かす。それとは別に、毎日の定期タスク airlog-daily-deploy がこれを動かす
#   （管理画面で足した・直した記事を、本番の控えのファイル data/ とサイトマップに入れるため。2026-11-17）
# ・さくらは国外IPからのFTPを拒否するので、GitHub Actions ではなくこのMac（国内）から上げる
# ・FTPのパスワードは macOS のキーチェーン（サービス名 airlog-ftp・アカウント rc-group）から読む。ファイルには書かない
# ・main と GitHub が一致していないときは止める（上げた版と GitHub の版がずれないように）
# ・上げる前に手元を、上げたあとに本番を tools/check-live.mjs で点検する（NG なら失敗で終わる）
# ・組み立てたあと・上げる前に tools/guard-shrink.mjs が公開の本数を本番と比べる（大きく減っていたら止める）
# ・組み立ては一時フォルダで行い、上げるのは airlog フォルダの中の変わったファイルだけ（tools/deploy-ftp.py）
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch -q origin main
if [ -n "$(git status --porcelain)" ] || [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "止めました：手元に未コミットの変更があるか、GitHub の main と一致していません（push してから動かしてください）"
  exit 1
fi

# 上げる前に手元の版を点検する（NG なら上げない）
node tools/check-live.mjs --local

PASS="$(security find-generic-password -s airlog-ftp -a rc-group -w)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/airlog-rc.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT

node tools/build-static.mjs --out "$OUT" --allow-index
# 公開の本数が本番より1割を超えて減っていたら、上げる前に止める（減ったぶんの記事ファイルを本番から消してしまうため）
node tools/guard-shrink.mjs --new "$OUT/data/version.json"
FTP_HOST=rc-group.sakura.ne.jp FTP_USER=rc-group FTP_PASS="$PASS" python3 tools/deploy-ftp.py "$OUT"
echo "上げた版: $(git rev-parse --short HEAD) → https://rc-group.co.jp/airlog/"
# 上げたあとに本番を点検する（APIキーの許可サイト・Firestore のルール・管理画面の作り・サイトマップ）。NG ならここで失敗で終わる
node tools/check-live.mjs
