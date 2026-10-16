// クマオカマツコ（www.kumaoka-matsuko.com）の記事をエアログへ移す
//
// 使い方：
//   node tools/kuma-import.mjs blog/human-resource/a69          … 指定した記事だけ
//   node tools/kuma-import.mjs --all                             … サイトマップの全記事
//   node tools/kuma-import.mjs --all --dry                       … 書き込まずに変換だけ
//
// やること：
//   1. 記事ページを取って tools/.kuma-cache/ に保存（2回目からは保存分を使う）
//   2. 表紙と本文の画像を縮めて media/kuma/ に置く（幅1200pxまで・JPEG）
//   3. 本文と目次をエアログの形に直し、Firestore の posts に「非公開」で書く
//
// 決まり：
//   ・書くのは id が kuma- で始まる記事だけ。既存の記事には触らない
//   ・どの記事も migratedFrom に元のURLを持つ
//   ・お問い合わせ／資料DLなど元サイトへのリンクは href="#" にし、data-kuma-link に種類を残す
//     （行き先が決まったら、この印を頼りに差し替える）
//   ・元サイトの記事同士のリンクは、エアログの ?id=kuma-… に書き換える
//   ・取れなかった画像・記事は黙って捨てず、最後に件数と理由を出す
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, 'tools/.kuma-cache');
const MEDIA = path.join(ROOT, 'media/kuma');
const BASE = 'https://www.kumaoka-matsuko.com/';
const PROJECT = 'air-log-db';
const MAX_W = 1200;

// 元サイトのカテゴリ → エアログのジャンル（2026-10-16 宮村さん確認）
const GENRE = {
  'human-resource': '採用支援',
  'sns': '集客支援',
  'news': '採用支援',
  'download': 'お役立ち資料',
};

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const problems = [];

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

async function cached(url, file, binary = false) {
  const f = path.join(CACHE, file);
  if (fs.existsSync(f)) return binary ? fs.readFileSync(f) : fs.readFileSync(f, 'utf8');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const body = binary ? Buffer.from(await r.arrayBuffer()) : await r.text();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  return body;
}

async function articleList() {
  const xml = await cached(BASE + 'sitemap.xml', 'sitemap.xml');
  return [...xml.matchAll(/<loc>https:\/\/www\.kumaoka-matsuko\.com\/(blog\/[^/<]+\/[^/<]+)<\/loc>/g)]
    .map(m => m[1])
    .filter(u => !u.startsWith('blog/tag/'));
}

const idOf = u => 'kuma-' + u.replace(/^blog\//, '').replace(/\//g, '-');

// 画像を取って縮め、media/kuma/ に置く。戻り値はサイトから見た相対パス
const imageMemo = new Map();
async function localImage(src, dir) {
  const abs = new URL(src, BASE).href;
  if (imageMemo.has(abs)) return imageMemo.get(abs);
  const name = decodeURIComponent(abs.split('/').pop()).replace(/\.[^.]+$/, '');
  const safe = name.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80) || 'img';
  const outRel = `media/kuma/${dir}/${safe}.jpg`;
  const out = path.join(ROOT, outRel);
  if (!fs.existsSync(out)) {
    const raw = await cached(encodeURI(decodeURI(abs)), 'img/' + Buffer.from(abs).toString('base64url').slice(-120), true);
    const tmp = path.join(CACHE, 'tmp-' + process.pid);
    fs.writeFileSync(tmp, raw);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const w = Number((execFileSync('sips', ['-g', 'pixelWidth', tmp]).toString().match(/pixelWidth: (\d+)/) || [])[1] || 0);
    const sipsArgs = ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80'];
    if (w > MAX_W) sipsArgs.push('--resampleWidth', String(MAX_W));
    execFileSync('sips', [...sipsArgs, tmp, '--out', out], { stdio: 'ignore' });
    fs.unlinkSync(tmp);
  }
  imageMemo.set(abs, outRel);
  return outRel;
}

function linkKind(href) {
  const h = href.replace(/^https?:\/\/www\.kumaoka-matsuko\.com/, '').replace(/^\//, '');
  if (/^contact/.test(h)) return 'contact';
  if (/^download/.test(h)) return 'download';
  if (/^seminarform/.test(h)) return 'seminar';
  return 'other';
}

// 本文・目次の中のリンクと画像を書き換える
async function rewrite(html, dir) {
  // 画像
  const srcs = [...new Set([...html.matchAll(/<img[^>]*?src="([^"]+)"/g)].map(m => m[1]))];
  for (const s of srcs) {
    if (!/^(\/|https?:\/\/www\.kumaoka-matsuko\.com\/)dcms_media\//.test(s)) continue;
    try {
      const local = await localImage(s, /CTA_/.test(s) ? 'common' : dir);
      html = html.split(`src="${s}"`).join(`src="${local}"`);
    } catch (e) {
      problems.push(`画像を取れなかった（${dir}）: ${s} … ${e.message}`);
    }
  }
  // リンク
  html = html.replace(/href="([^"]+)"/g, (all, href) => {
    if (href.startsWith('#')) return all;                       // ページ内の見出しへのリンク
    const isKuma = href.startsWith('/') || href.startsWith(BASE) || href.startsWith('https://kumaoka-matsuko.com');
    if (!isKuma) return all;                                    // 外部サイトはそのまま
    const p = href.replace(/^https?:\/\/(www\.)?kumaoka-matsuko\.com/, '').replace(/^\//, '').replace(/[#?].*$/, '').replace(/\/$/, '');
    if (/^blog\/[^/]+\/[^/]+$/.test(p) && !p.startsWith('blog/tag/')) return `href="?id=${idOf(p)}"`;
    return `href="#" data-kuma-link="${linkKind(href)}" data-kuma-href="${href}"`;
  });
  return html;
}

function text(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();
}

async function convert(u) {
  const [, cat, slug] = u.split('/');
  const dir = `${cat}-${slug}`;
  const html = await cached(BASE + u, 'pages/' + u.replace(/\//g, '_') + '.html');

  const title = text((html.match(/<h1 class="p-hero__dtitle">([\s\S]*?)<\/h1>/) || [])[1] || '');
  if (!title) throw new Error('タイトルが見つからない');
  const pub = (html.match(/記事公開日[^0-9]*(\d{4})\/(\d{2})\/(\d{2})/) || []);
  if (!pub[1]) throw new Error('公開日が見つからない');
  const tagBlock = (html.match(/<div class="article-tag">([\s\S]*?)<\/div>/) || [])[1] || '';
  const tags = [...tagBlock.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map(m => text(m[1]));
  const coverSrc = (html.match(/<figure class="cover">\s*<img src="([^"]+)"/) || [])[1];

  const detail = (html.match(/<div id="articledetail">([\s\S]*)<!-- parts end -->/) || [])[1];
  if (!detail) throw new Error('本文（articledetail）が見つからない');
  const blocks = (detail + '<!-- parts end -->').split(/(?=<!-- parts start -->)/).map(b => b.trim()).filter(b => b.startsWith('<!-- parts start -->'));
  const tocBlocks = blocks.filter(b => b.includes('p-media-parts__toc'));
  const bodyBlocks = blocks.filter(b => !b.includes('p-media-parts__toc'));

  // 目次の部品に付いている CTA 画像は、本文の先頭側（目次の直後の位置）へ移す
  let toc = tocBlocks.join('\n');
  const ctaInToc = toc.match(/<br \/>\s*<a href="[^"]*"><img[^>]*CTA_[^>]*><\/a>/g) || [];
  for (const c of ctaInToc) toc = toc.replace(c, '');
  const tocIdx = blocks.indexOf(tocBlocks[0]);
  const before = blocks.slice(0, tocIdx).filter(b => !b.includes('p-media-parts__toc'));
  const after = blocks.slice(tocIdx + 1);
  let content = tocBlocks.length
    ? [...before, ...(ctaInToc.length ? [`<!-- parts start -->\n${ctaInToc.join('\n')}\n<!-- parts end -->`] : []), ...after.filter(b => !b.includes('p-media-parts__toc'))].join('\n')
    : bodyBlocks.join('\n');

  toc = await rewrite(toc, dir);
  content = await rewrite(content, dir);
  const coverImage = coverSrc ? await localImage(coverSrc, dir) : '';

  const now = new Date();
  const p2 = n => String(n).padStart(2, '0');
  return {
    id: idOf(u),
    title,
    genre: GENRE[cat] || '採用支援',
    tags,
    keyword: tags.join(' '),
    toc,
    content,
    coverImage,
    coverPositionX: '50',
    coverPositionY: '50',
    status: 'private',
    startDate: '',
    endDate: '',
    date: `${pub[1]}-${pub[2]}-${pub[3]}T00:00:00.000+09:00`,
    displayDate: `${pub[1]}.${pub[2]}.${pub[3]}`,
    author: '',
    updatedBy: 'kuma-import',
    updatedAt: `${now.getFullYear()}/${p2(now.getMonth() + 1)}/${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`,
    migratedFrom: BASE + u,
  };
}

// Firestore の値の形に直す
function fsValue(v) {
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsValue) } };
  return { stringValue: String(v) };
}

async function firestoreClient() {
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
  const targets = args.includes('--all') ? await articleList() : args.filter(a => !a.startsWith('--'));
  if (!targets.length) throw new Error('記事を指定してください（例：blog/human-resource/a69 か --all）');
  const client = DRY ? null : await firestoreClient();
  let ok = 0;
  for (const u of targets) {
    try {
      const doc = await convert(u);
      if (!doc.id.startsWith('kuma-')) throw new Error('kuma- 以外の id には書かない');
      fs.writeFileSync(path.join(CACHE, doc.id + '.json'), JSON.stringify(doc, null, 2));
      if (!DRY) {
        const fields = Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, fsValue(v)]));
        await client.request({ method: 'PATCH', path: `/projects/${PROJECT}/databases/(default)/documents/posts/${doc.id}`, body: { fields } });
      }
      ok++;
      console.log(`${DRY ? '変換' : '書き込み'} ${doc.id} ｜ ${doc.genre} ｜ ${doc.title}`);
    } catch (e) {
      problems.push(`記事を移せなかった: ${u} … ${e.message}`);
    }
  }
  console.log(`\n${ok} / ${targets.length} 本 ${DRY ? '変換' : '書き込み'}しました`);
  if (problems.length) {
    console.log(`問題 ${problems.length} 件:`);
    problems.forEach(p => console.log(' ・' + p));
    process.exitCode = 1;
  }
}
main().catch(e => { console.error('失敗:', e.message); process.exit(1); });
