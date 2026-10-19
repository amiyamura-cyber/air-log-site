#!/bin/bash
# 会社のサーバー（https://rc-group.co.jp/airlog/）へ上げる。push したあとに、このMacで動かす
#
#   bash tools/deploy-rc.sh
#
# ・さくらは国外IPからのFTPを拒否するので、GitHub Actions ではなくこのMac（国内）から上げる
# ・FTPのパスワードは macOS のキーチェーン（サービス名 airlog-ftp・アカウント rc-group）から読む。ファイルには書かない
# ・main と GitHub が一致していないときは止める（上げた版と GitHub の版がずれないように）
# ・組み立ては一時フォルダで行い、上げるのは airlog フォルダの中の変わったファイルだけ（tools/deploy-ftp.py）
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch -q origin main
if [ -n "$(git status --porcelain)" ] || [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "止めました：手元に未コミットの変更があるか、GitHub の main と一致していません（push してから動かしてください）"
  exit 1
fi

PASS="$(security find-generic-password -s airlog-ftp -a rc-group -w)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/airlog-rc.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT

node tools/build-static.mjs --out "$OUT" --allow-index
FTP_HOST=rc-group.sakura.ne.jp FTP_USER=rc-group FTP_PASS="$PASS" python3 tools/deploy-ftp.py "$OUT"
echo "上げた版: $(git rev-parse --short HEAD) → https://rc-group.co.jp/airlog/"
