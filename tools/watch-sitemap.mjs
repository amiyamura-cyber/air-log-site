// 見張り：記事を公開・非公開にしたら、10 分以内に本番のサイトマップに反映されているか（GitHub の watch-sitemap.yml が定期的に動かす）
//
// 使い方： node tools/watch-sitemap.mjs
//
// 見るもの（読み取りは Firestore 1 回＋ sitemap.php が読む分だけ。全件は読まない。Firestore は無料プランで1日5万回まで）：
//   1. Firestore の公開の記事の数（数えるだけ・読み取り 1 回）
//   2. 本番の sitemap.xml が返す X-Sitemap-Public（sitemap.php が作ったときの公開の数）
//   3. 2 つが合わないときは、sitemap.php が取っておいたもの（最大 10 分前）を返している途中かもしれないので、
//      その 10 分が過ぎるまで待ってもう一度取る。それでも合わなければ NG（＝10 分以内に載っていない）
//   ほかに：Firestore からその場で作っている（X-Sitemap-Source が live か cache。static は Firestore を読めず予備を返している）／
//           載っている記事の数 ＝ 公開の数 − 載せない記事（公開日がまだ・掲載終了）の数
//
// NG なら exit 1（GitHub が失敗のメールを送る）。結果は GitHub の実行結果のまとめ（GITHUB_STEP_SUMMARY）にも書く
// LONG-RUN-OK：合わないときだけ最大 10 分待つ（GitHub の上で動く。この Mac では待たない）
import fs from 'fs';

const LIVE = 'https://rc-group.co.jp/airlog/';
const FS = 'https://firestore.googleapis.com/v1/projects/air-log-db/databases/(default)/documents';
const LISTS = 6; // トップ1・一覧5（sitemap.php の LISTS と build-static.mjs の SITEMAP_LISTS）
const CACHE_SEC = 600;

const lines = [];
const say = s => { console.log(s); lines.push(s); };
const finish = (pass, why) => {
  say(pass ? '結果：OK' : `結果：NG … ${why}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## サイトマップの見張り\n\n' + lines.map(l => '- ' + l).join('\n') + '\n');
  process.exit(pass ? 0 : 1);
};

async function publicCount() {
  const r = await fetch(`${FS}:runAggregationQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    structuredAggregationQuery: { structuredQuery: { from: [{ collectionId: 'posts' }], where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'public' } } } }, aggregations: [{ alias: 'n', count: {} }] },
  }) });
  const body = await r.text();
  if (!r.ok) return { error: `HTTP ${r.status} ${body.slice(0, 200)}` };
  const n = Number(JSON.parse(body)[0]?.result?.aggregateFields?.n?.integerValue);
  return Number.isFinite(n) ? { n } : { error: '数が読めない: ' + body.slice(0, 200) };
}

async function sitemap() {
  const r = await fetch(LIVE + 'sitemap.xml?watch=' + Date.now());
  const body = await r.text();
  const h = k => r.headers.get(k);
  return {
    status: r.status, source: h('x-sitemap-source') || '', public: Number(h('x-sitemap-public')), hidden: Number(h('x-sitemap-hidden')),
    age: Number(h('x-sitemap-age')), articles: (body.match(/<loc>[^<]*\?id=/g) || []).length, all: (body.match(/<loc>/g) || []).length,
  };
}

const show = s => `HTTP ${s.status}・${s.source || '（返し元の印なし）'}・作ってから ${s.age} 秒・公開 ${s.public}・載せない ${s.hidden}・載っている記事 ${s.articles}`;

const c1 = await publicCount();
if (c1.error) finish(false, `Firestore の公開の数を読めない（無料枠切れなら RESOURCE_EXHAUSTED。管理画面も止まっている）：${c1.error}`);
say(`Firestore の公開の記事：${c1.n} 本`);
let s = await sitemap();
say(`サイトマップ：${show(s)}`);
if (s.status !== 200) finish(false, 'サイトマップが開けない');
if (!/^(live|cache)$/.test(s.source)) finish(false, s.source === 'static'
  ? 'sitemap.php が Firestore を読めず、予備の sitemap.xml（最後に deploy-rc.sh で上げたもの）を返している'
  : '.htaccess の振り分けか sitemap.php が効いていない（予備のファイルがそのまま出ている）');

if (s.public !== c1.n) {
  if (!(s.source === 'cache' && s.age < CACHE_SEC)) finish(false, `作り直したはずなのに公開の数が合わない（Firestore ${c1.n}・サイトマップ ${s.public}）`);
  const wait = CACHE_SEC - s.age + 5;
  say(`公開の数が合わない（Firestore ${c1.n}・サイトマップ ${s.public}）。取っておいたものが ${s.age} 秒前なので、${wait} 秒待ってもう一度取る`);
  await new Promise(r => setTimeout(r, wait * 1000));
  const c2 = await publicCount();
  if (c2.error) finish(false, `2 回目に Firestore を読めない：${c2.error}`);
  s = await sitemap();
  say(`2 回目：Firestore ${c2.n} 本／サイトマップ：${show(s)}`);
  if (s.public !== c2.n) finish(false, `10 分を過ぎても公開の数が合わない（Firestore ${c2.n}・サイトマップ ${s.public}）＝新しく公開した記事が10分以内に載っていない`);
}
if (s.articles !== s.public - s.hidden || s.all !== s.articles + LISTS) finish(false, `載っている数が合わない（記事 ${s.articles}＝公開 ${s.public}−載せない ${s.hidden} のはず・全体 ${s.all}＝記事＋${LISTS} のはず）`);
finish(true);
