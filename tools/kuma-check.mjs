// クマオカマツコから移した記事を、元の記事と突き合わせる（読むだけ。何も書かない）
//
// 使い方： node tools/kuma-check.mjs
//
// 数えるもの：
//   ・サイトマップの記事数 と Firestore の kuma- 記事数
//   ・状態（非公開のはず）
//   ・元の記事の CTA 画像の数 と 移した記事の印（kuma-cta）の数
//   ・元の記事の本文画像の数 と 移した記事の画像の数、その画像ファイルがリポジトリにあるか
//   ・元サイトを指したまま残っているリンク・画像
//   ・本文の文字数（元の記事と1文字でも違えば食い違い）
// 元の記事は tools/.kuma-cache/pages/ の保存分を読む（元サイトは叩かない）
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, 'tools/.kuma-cache');
const strip = s => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, '');

const posts = [];
let token = '';
do {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/air-log-db/databases/(default)/documents/posts?pageSize=300${token ? '&pageToken=' + encodeURIComponent(token) : ''}`);
  const j = await r.json();
  for (const d of j.documents || []) posts.push({ id: d.name.split('/').pop(), f: d.fields });
  token = j.nextPageToken || '';
} while (token);

const kuma = posts.filter(p => p.id.startsWith('kuma-'));
const pages = fs.readdirSync(path.join(CACHE, 'pages')).filter(f => f.startsWith('blog_'));
const issues = [];
const count = { status: {}, cta: [0, 0], img: [0, 0], missingFile: 0, kumaLeft: 0 };

for (const p of kuma) {
  const s = k => p.f[k]?.stringValue ?? '';
  count.status[s('status')] = (count.status[s('status')] || 0) + 1;
  const src = s('migratedFrom').replace('https://www.kumaoka-matsuko.com/', '');
  const pageFile = path.join(CACHE, 'pages', src.replace(/\//g, '_') + '.html');
  if (!fs.existsSync(pageFile)) { issues.push(`元の記事の保存が無い: ${p.id}`); continue; }
  const html = fs.readFileSync(pageFile, 'utf8');
  const body = (html.match(/<div id="articledetail">([\s\S]*?)<!--キュレーション時 リンク-->/) || [])[1] || '';
  const mine = s('toc') + s('content');

  const ctaSrc = (body.match(/<img[^>]*src="[^"]*CTA_[^"]*"/g) || []).length;
  const ctaMine = (mine.match(/<!-- kuma-cta /g) || []).length;
  count.cta[0] += ctaSrc; count.cta[1] += ctaMine;
  if (ctaSrc !== ctaMine) issues.push(`CTAの数が違う: ${p.id} 元${ctaSrc} → 印${ctaMine}`);

  const imgSrc = (body.match(/<img[^>]*src="[^"]*"/g) || []).filter(x => !x.includes('CTA_')).length;
  const imgs = [...mine.matchAll(/<img[^>]*src="([^"]*)"/g)].map(m => m[1]);
  count.img[0] += imgSrc; count.img[1] += imgs.length;
  if (imgSrc !== imgs.length) issues.push(`本文画像の数が違う: ${p.id} 元${imgSrc} → ${imgs.length}`);
  for (const i of [...imgs, s('coverImage')].filter(Boolean)) {
    if (!fs.existsSync(path.join(ROOT, i))) { count.missingFile++; issues.push(`画像ファイルが無い: ${p.id} ${i}`); }
  }

  const left = (mine.match(/(src|href)="(https?:\/\/(www\.)?kumaoka-matsuko\.com|\/dcms_media|\/(contact|download|blog)[^"]*)"/g) || []);
  count.kumaLeft += left.length;
  if (left.length) issues.push(`元サイトを指したまま: ${p.id} ${left.slice(0, 2).join(' ')}`);

  const a = strip(body).length, b = strip(mine).length;
  if (a !== b) issues.push(`本文の文字数が違う: ${p.id} 元${a}字 → ${b}字`);
}

console.log(`サイトマップの記事 ${pages.length ? '' : '(保存なし)'}／保存済みページ ${pages.length} 本`);
console.log(`Firestore の kuma- 記事 ${kuma.length} 本 ／ 状態 ${JSON.stringify(count.status)}`);
console.log(`CTA：元 ${count.cta[0]} 枚 → 印 ${count.cta[1]} 個`);
console.log(`本文画像：元 ${count.img[0]} 枚 → 移した記事 ${count.img[1]} 枚 ／ 画像ファイルが無い ${count.missingFile} 件`);
console.log(`元サイトを指したまま残ったリンク・画像 ${count.kumaLeft} 件`);
console.log(`食い違い ${issues.length} 件`);
issues.slice(0, 30).forEach(i => console.log(' ・' + i));
fs.writeFileSync(path.join(CACHE, 'check-result.json'), JSON.stringify({ at: new Date().toISOString(), kuma: kuma.length, count, issues }, null, 2));
if (issues.length) process.exitCode = 1;
