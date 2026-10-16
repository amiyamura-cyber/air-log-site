// クマオカマツコから移した記事（id が kuma- で始まるもの）を、まとめて公開／非公開にする
//
// 使い方：
//   node tools/kuma-publish.mjs                 … 数えるだけ（何も書かない）
//   node tools/kuma-publish.mjs --public --yes  … 非公開の移行記事を全部「公開」にする
//   node tools/kuma-publish.mjs --private --yes … 公開中の移行記事を全部「非公開」に戻す
//   node tools/kuma-publish.mjs --private --yes --only kuma-human-resource-a69 … 1本だけ
//
// 決まり：
//   ・触るのは kuma- の記事だけ。手で書いた記事には触らない
//   ・管理画面で人が直した記事（最後の更新者が kuma-import / kuma-publish 以外）は触らず、件数を出す
//   ・変えるのは status と updatedAt / updatedBy だけ（本文などは書き換えない）
//   ・本番に出るのは、10分おきの自動処理（.github/workflows/publish.yml）が次に動いたとき
//   ・結果は tools/.kuma-cache/publish-last-run.json に残す
// LONG-RUN-OK：記事の一覧は1回読むだけ。書き込みは対象の本数ぶん
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, 'tools/.kuma-cache');
const PROJECT = 'air-log-db';
const args = process.argv.slice(2);
const to = args.includes('--public') ? 'public' : args.includes('--private') ? 'private' : null;
const YES = args.includes('--yes');
const MINE = new Set(['kuma-import', 'kuma-publish']);

async function client() {
  const FT = '/opt/homebrew/lib/node_modules/firebase-tools/lib/';
  const { requireAuth } = require(FT + 'requireAuth');
  const { getGlobalDefaultAccount } = require(FT + 'auth');
  const { Client } = require(FT + 'apiv2');
  const a = getGlobalDefaultAccount();
  if (!a) throw new Error('firebase login が必要です');
  await requireAuth({ user: a.user, tokens: a.tokens });
  console.log('Firestore に書くアカウント:', a.user.email);
  return new Client({ urlPrefix: 'https://firestore.googleapis.com', auth: true, apiVersion: 'v1' });
}

async function main() {
  const c = await client();
  const docs = [];
  let token = '';
  do {
    const r = await c.request({ method: 'GET', path: `/projects/${PROJECT}/databases/(default)/documents/posts`, queryParams: { pageSize: '300', ...(token ? { pageToken: token } : {}) } });
    docs.push(...(r.body.documents || []));
    token = r.body.nextPageToken || '';
  } while (token);

  const kuma = docs.filter(d => d.name.split('/').pop().startsWith('kuma-'));
  const st = d => d.fields?.status?.stringValue;
  const by = d => d.fields?.updatedBy?.stringValue;
  const handEdited = kuma.filter(d => !MINE.has(by(d)));
  const count = s => kuma.filter(d => st(d) === s).length;
  console.log(`移行記事 ${kuma.length} 本 ／ 公開 ${count('public')} 本 ／ 非公開 ${count('private')} 本 ／ 管理画面で直された記事 ${handEdited.length} 本（触らない）`);

  if (!to) { console.log('数えただけです。公開するときは --public --yes、非公開に戻すときは --private --yes'); return; }
  // --only <id>：その1本だけ（状態が同じでも書く。書き込みの確かめ用）
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const targets = only
    ? kuma.filter(d => d.name.endsWith('/' + only) && MINE.has(by(d)))
    : kuma.filter(d => MINE.has(by(d)) && st(d) !== to);
  console.log(`${to === 'public' ? '公開' : '非公開'}にする対象 ${targets.length} 本`);
  if (!YES) { console.log('--yes が無いので書いていません'); return; }

  const now = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const at = `${now.getFullYear()}/${p2(now.getMonth() + 1)}/${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
  let ok = 0; const problems = [];
  for (const d of targets) {
    try {
      await c.request({
        method: 'PATCH',
        path: `/${d.name}`,
        queryParams: new URLSearchParams([['updateMask.fieldPaths', 'status'], ['updateMask.fieldPaths', 'updatedAt'], ['updateMask.fieldPaths', 'updatedBy']]),
        body: { fields: { status: { stringValue: to }, updatedAt: { stringValue: at }, updatedBy: { stringValue: 'kuma-publish' } } },
      });
      ok++;
    } catch (e) { problems.push(`${d.name.split('/').pop()} … ${e.message}`); }
  }
  console.log(`${ok} / ${targets.length} 本を${to === 'public' ? '公開' : '非公開'}にしました。本番には10分おきの自動処理で出ます`);
  problems.forEach(p => console.log(' ・' + p));
  fs.writeFileSync(path.join(CACHE, 'publish-last-run.json'), JSON.stringify({ at: now.toISOString(), to, targets: targets.length, ok, problems }, null, 2));
  if (problems.length) process.exitCode = 1;
}
main().catch(e => { console.error('失敗:', e.message); process.exit(1); });
