// 上げる前の関門：公開の記事の本数が、いまの本番より大きく減っていたら止める
//
// 使い方（tools/deploy-rc.sh が、組み立てたあと・上げる前に動かす）：
//   node tools/guard-shrink.mjs --new <組み立てた data/version.json>
//   node tools/guard-shrink.mjs --new <…> --live 383     … 本番の本数を手で渡す（試すとき用。本番を読みに行かない）
//
// なぜあるか（2026-11-17）：
//   上げる道具（deploy-ftp.py）は「前回上げて今回ないファイル」を本番から消す。非公開にした記事のファイルを残さないための作りだが、
//   何かの間違い（まとめて非公開にした・Firestore の読み取りが途中で切れた など）で公開の本数が大きく減ったまま上げると、
//   本番の記事ファイルと予備のサイトマップからまとめて消える。上げる人が気づかなくても、ここで止める。
//
// 決まり：
//   ・今回の本数が本番の9割未満なら止める（exit 1）。1日に1割を超えて記事を非公開にすることは、ふだんの運用では無いという前提
//     本当に減らしたいときは、宮村さんに確かめたうえで AIRLOG_ALLOW_SHRINK=1 を付けて動かす
//   ・本番の本数を読めなかったら止める（比べられないことを「問題なし」と読まない）
//   ・増えた・同じ・少し減った は通す。結果は tools/.guard-shrink.json に残す（git には入れない）
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LIVE_VERSION = 'https://rc-group.co.jp/airlog/data/version.json';
const KEEP = 0.9;
const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const stop = (reason, extra = {}) => {
  console.error('止めました：' + reason);
  fs.writeFileSync(path.join(ROOT, 'tools/.guard-shrink.json'), JSON.stringify({ at: new Date().toISOString(), passed: false, reason, ...extra }, null, 1));
  process.exit(1);
};

const newPath = arg('--new');
if (!newPath) stop('--new <組み立てた data/version.json> を指定してください');
let next;
try { next = JSON.parse(fs.readFileSync(newPath, 'utf8')).posts; } catch (e) { stop(`組み立てた version.json を読めなかった（${e.message}）`); }
if (!Number.isInteger(next) || next <= 0) stop(`組み立てた公開の本数が数になっていない（${next}）`);

let live;
if (arg('--live') !== undefined) {
  live = Number(arg('--live'));
} else {
  try {
    const r = await fetch(LIVE_VERSION + '?guard=' + Date.now());
    if (!r.ok) stop(`本番の本数を読めなかったので比べられません（HTTP ${r.status}）`, { next });
    live = (await r.json()).posts;
  } catch (e) { stop(`本番の本数を読めなかったので比べられません（${e.message}）`, { next }); }
}
if (!Number.isInteger(live) || live <= 0) stop(`本番の公開の本数が数になっていない（${live}）ので比べられません`, { next });

const diff = next - live;
const line = `公開の本数：本番 ${live} 本 → 今回 ${next} 本（${diff > 0 ? '+' : ''}${diff}）`;
if (next < live * KEEP) {
  if (process.env.AIRLOG_ALLOW_SHRINK === '1') {
    console.log(line + '　※1割を超えて減っていますが、AIRLOG_ALLOW_SHRINK=1 が付いているので通します');
  } else {
    stop(`${line}。1割を超えて減っています。このまま上げると、減ったぶんの記事ファイルが本番から消えます。管理画面で記事がまとめて非公開になっていないかを確かめてください（本当に減らすなら AIRLOG_ALLOW_SHRINK=1 を付けて動かす）`, { live, next });
  }
} else {
  console.log(line);
}
fs.writeFileSync(path.join(ROOT, 'tools/.guard-shrink.json'), JSON.stringify({ at: new Date().toISOString(), passed: true, live, next }, null, 1));
