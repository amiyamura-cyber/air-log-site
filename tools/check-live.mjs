// 本番（https://rc-group.co.jp/airlog/）が「つながっているはずのもの全部」とつながっているかを確かめる
//
// 使い方：
//   node tools/check-live.mjs            … 本番を確かめる（tools/deploy-rc.sh が上げたあとに必ず動かす）
//   node tools/check-live.mjs --local    … 手元の admin.html を確かめる（本番の代わりに。上げる前の点検用）
//
// 結果は tools/.check-live.json に残す（いつ・どちらを・何が OK／NG だったか。git には入れない）
// 叩くのは十数回だけ（1回10秒ほど）。記事を1本ずつ叩くことはしない
//
// なぜあるか（2026-11-13）：
//   1か所の決まりを変えたのに、それに頼っているほかの場所を確かめず、同じ形の不具合を何度も出した。
//     ・Firestore のルールを変えた（10/30）→ 管理画面がログイン前に読みに行って一覧が空（11/13）
//     ・APIキーの許可サイトをかけ直した → 本番のアドレスが入っておらずログインできない（11/13）
//     ・「読めなかった」を「0件」として先へ進む作り → 記事がありません／食い違い0 と嘘を出す
//   ここは不具合の名前ではなく「つながり」を1つずつ叩く。1つでも合わなければ失敗で終わる（exit 1）
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LIVE = 'https://rc-group.co.jp/airlog/';
const LIVE_HOST = 'rc-group.co.jp';
const PROJECT = 'air-log-db';
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const LOCAL = process.argv.includes('--local');
const RESULT_FILE = path.join(ROOT, 'tools/.check-live.json');

const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); };
const text = async (url, opt) => { const r = await fetch(url, opt); return { status: r.status, body: await r.text() }; };
const PUBLIC_ONLY = { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'public' } } };

// ---- 管理画面の中身（本番 or 手元） ----
const admin = LOCAL ? fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8') : (await text(LIVE + 'admin.html?check=' + Date.now())).body;
const key = (admin.match(/apiKey:\s*"([^"]+)"/) || [])[1];
ok('管理画面に Firebase の設定がある', !!key, 'apiKey が見つからない');

// 1. APIキーの許可サイト：本番のアドレスから Google のログインの口が通ること／関係ないサイトは通らないこと
if (key) {
  const idt = ref => text(`https://identitytoolkit.googleapis.com/v1/projects?key=${key}`, { headers: { Referer: ref } });
  const live = await idt(LIVE + 'admin.html');
  ok('APIキー：本番のアドレスからログインの口が通る', live.status === 200, `HTTP ${live.status}（403 なら Cloud Console の認証情報 → Browser key → ウェブサイトの制限に https://${LIVE_HOST}/* を足す）`);
  const domains = live.status === 200 ? (JSON.parse(live.body).authorizedDomains || []) : [];
  ok('Firebase のログイン：承認済みドメインに本番がある', domains.includes(LIVE_HOST), `承認済み：${domains.join(', ') || '（読めなかった）'}`);
  const authDomain = (admin.match(/authDomain:\s*"([^"]+)"/) || [])[1];
  const mid = await idt(`https://${authDomain}/`);
  ok('APIキー：ログインの中継ページ（authDomain）から通る', mid.status === 200, `${authDomain} → HTTP ${mid.status}`);
  const other = await idt('https://example.com/');
  ok('APIキー：関係ないサイトからは通らない（制限が効いている）', other.status === 403, `example.com → HTTP ${other.status}`);
}

// 2. Firestore のルールと、それに頼っている読み方
const post = (url, body) => text(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const all = await text(`${FS}/posts?pageSize=1`);
ok('Firestore：ログインなしでは全件を読めない（非公開の記事を守る）', all.status === 403, `HTTP ${all.status}`);
const settings = await text(`${FS}/settings/authors`);
ok('Firestore：ログインなしでは設定を読めない', settings.status === 403, `HTTP ${settings.status}`);
const cnt = await post(`${FS}:runAggregationQuery`, { structuredAggregationQuery: { structuredQuery: { from: [{ collectionId: 'posts' }], where: PUBLIC_ONLY }, aggregations: [{ alias: 'n', count: {} }] } });
const publicCount = cnt.status === 200 ? Number(JSON.parse(cnt.body)[0]?.result?.aggregateFields?.n?.integerValue) : NaN;
ok('Firestore：公開の記事はログインなしで数えられる（公開ページが使う読み方）', Number.isFinite(publicCount) && publicCount > 0, `HTTP ${cnt.status}・公開 ${publicCount} 本`);

// 3. 管理画面の作り：ログイン前は読めない前提で作ってあるか（読めなかったを 0件 にしない）
const has = (name, re, why) => ok(name, re.test(admin), why);
has('管理画面：ログインできた時点で記事一覧を読み直す', /airlogLoadAuthors\s*=\s*async function\s*\(\)\s*\{[^}]*renderGrid\(\)/, 'ログインの直後に一覧が空になる（ページを開いた時点ではログイン前で読めない）');
has('管理画面：記事を読めなかったら「記事がありません」と出さない', /if \(loadDataError\) \{[\s\S]{0,300}読み込めませんでした/, '読めなかったのに 0件 と出る');
has('管理画面：作成者の一覧を読めなかったら保存しない', /if \(authorsLoadError\) throw/, '読めていない空の一覧で上書きして、登録済みの作成者を消す');
// ばらつき：記事を読む loadData() を呼ぶ場所は、どこも「読めなかった」を見ていること（描く・保存・編集・削除）
const calls = [...admin.matchAll(/await loadData\(\);([\s\S]{0,260})/g)];
const blind = calls.filter(m => !/loadDataError/.test(m[1])).length;
ok('管理画面：記事を読む場所は全部「読めなかった」を見ている', calls.length > 0 && blind === 0, `読む場所 ${calls.length} か所のうち、見ていない ${blind} か所`);

// 4. 本番のファイルどうしの食い違い（本番を見るときだけ）
if (!LOCAL) {
  const top = await text(LIVE);
  ok('本番：トップが開く', top.status === 200, `HTTP ${top.status}`);
  ok('本番：トップに検索よけ（noindex）が無い', !/<meta name="robots"/i.test(top.body), 'noindex が入っていると検索に出ない');
  const idx = await text(LIVE + 'data/index.json?check=' + Date.now());
  const index = idx.status === 200 ? JSON.parse(idx.body) : [];
  ok('本番：記事の目録が読める', index.length > 0, `HTTP ${idx.status}・${index.length} 本`);
  const sm = await text(LIVE + 'sitemap.xml?check=' + Date.now());
  const locs = [...sm.body.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].replace(/&amp;/g, '&'));
  const smIds = new Set(locs.filter(l => l.includes('?id=')).map(l => decodeURIComponent(l.split('?id=')[1])));
  const ids = new Set(index.map(p => p.id));
  const extra = [...smIds].filter(i => !ids.has(i));
  // 目録にあってサイトマップに無いのは、公開日がまだ・掲載終了の記事だけのはず
  const missing = index.filter(p => !smIds.has(p.id) && !p.startDate && !p.endDate).map(p => p.id);
  ok('本番：サイトマップが読める', sm.status === 200 && locs.length > 0, `HTTP ${sm.status}・${locs.length} 件`);
  ok('本番：サイトマップと目録が食い違わない', extra.length === 0 && missing.length === 0, `目録に無いのに載っている ${extra.length}・期間の指定が無いのに載っていない ${missing.length}`);
  // html を上げ直したらすぐ新しい版が出ること（.htaccess の Cache-Control: no-cache。無いと古い版が控えから出続ける）
  for (const f of ['', 'admin.html', 'thanks.html']) {
    const cc = (await fetch(LIVE + f, { method: 'HEAD' })).headers.get('cache-control') || '';
    ok(`本番：${f || 'トップ'} は控えを使う前にサーバーへ聞く`, /no-cache/.test(cc), `Cache-Control: ${cc || '（無し）'}。上げ直しても古い版が出続ける`);
  }
  const thanks = await text(LIVE + 'thanks.html');
  ok('本番：管理画面・サンクスページは検索よけのまま', /<meta name="robots"[^>]*noindex/i.test(admin) && /<meta name="robots"[^>]*noindex/i.test(thanks.body), 'noindex が外れている');
}

const bad = results.filter(r => !r.pass);
for (const r of results) console.log(`${r.pass ? 'OK ' : 'NG '} ${r.name}${r.pass ? '' : ' … ' + r.detail}`);
console.log(`${LOCAL ? '手元' : '本番'}の点検：${results.length} 件中 OK ${results.length - bad.length}・NG ${bad.length}`);
fs.writeFileSync(RESULT_FILE, JSON.stringify({ at: new Date().toISOString(), target: LOCAL ? '手元' : '本番', ok: results.length - bad.length, ng: bad.length, results }, null, 1));
if (bad.length) process.exit(1);
