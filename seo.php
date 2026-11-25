<?php
// 管理画面の「キーワードを探す」の裏側（2026-11-25。Streamlit 版エアログ統合システムの「SEOキーワード抽出」を移したもの）
//
// なぜあるか：
//   Google の検索候補とニュースは、ほかのサイトのページ（管理画面）から直接は読めない（読む許可を出していない）。
//   さくらのサーバーで代わりに読んで、管理画面へ JSON で返す。
//
// 返すもの（GET ?q=キーワード）：
//   phrases  … Google の検索候補（みんなが実際に検索している言い方）。q そのものと、q＋「あ〜」「課題」などで聞いて集める
//   articles … Google ニュースの関連記事（最大10本・同じサイトは1本まで）
//   errors   … 読めなかったもの。読めなかったときに空の一覧を「候補なし」と見せないため
//   Streamlit 版は足りない分をコードに書いた決まった言葉・記事・「単語14」で埋めていた。ここでは埋めない（Google から取れたものだけ）
//
// 控え：同じ q は 1 時間、サーバーに取っておいたものを返す（Google を何度も叩かない）。.seo-cache/ に置く

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

const CACHE_SEC = 3600;
const HINTS = ['', 'あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ', 'とは', '方法', '課題', '対策', '事例', 'ポイント', 'コツ', '費用', '比較'];

function out($a, $code = 200) { http_response_code($code); echo json_encode($a, JSON_UNESCAPED_UNICODE); exit; }

$q = isset($_GET['q']) ? trim(preg_replace('/\s+/u', ' ', (string)$_GET['q'])) : '';
if ($q === '') out(['error' => 'キーワードが空です'], 400);
if (mb_strlen($q) > 60) out(['error' => 'キーワードは60字までにしてください'], 400);

$dir = __DIR__ . '/.seo-cache';
if (!is_dir($dir)) @mkdir($dir, 0755);
$cacheFile = $dir . '/' . md5($q) . '.json';
if (is_file($cacheFile) && time() - filemtime($cacheFile) < CACHE_SEC && !isset($_GET['fresh'])) {
  $c = json_decode(file_get_contents($cacheFile), true);
  if (is_array($c)) { $c['cached'] = true; out($c); }
}

function get_url($url, $timeout = 5) {
  $ctx = stream_context_create(['http' => ['method' => 'GET', 'header' => "User-Agent: Mozilla/5.0\r\nAccept-Language: ja\r\n", 'timeout' => $timeout, 'ignore_errors' => true]]);
  $r = @file_get_contents($url, false, $ctx);
  $status = isset($http_response_header[0]) ? $http_response_header[0] : '';
  if ($r === false || strpos($status, ' 200') === false) return null;
  return $r;
}

$errors = [];

// 1. 検索候補
$phrases = [];
$okHints = 0;
foreach (HINTS as $h) {
  $sq = trim($q . ' ' . $h);
  $xml = get_url('https://suggestqueries.google.com/complete/search?output=toolbar&hl=ja&q=' . rawurlencode($sq), 4);
  if ($xml === null) continue;
  // 検索候補は Shift_JIS で返ることがある
  if (!mb_check_encoding($xml, 'UTF-8')) $xml = mb_convert_encoding($xml, 'UTF-8', 'SJIS-win');
  $xml = preg_replace('/encoding="[^"]*"/', 'encoding="UTF-8"', $xml, 1);
  $x = @simplexml_load_string($xml);
  if ($x === false) continue;
  $okHints++;
  foreach ($x->xpath('//suggestion') as $s) {
    $p = trim(preg_replace('/\s+/u', ' ', (string)$s['data']));
    if ($p === '' || $p === $q || in_array($p, $phrases, true)) continue;
    $phrases[] = $p;
  }
}
if ($okHints === 0) $errors[] = 'Google の検索候補を読めませんでした';

// 2. ニュース
$articles = [];
$rss = get_url('https://news.google.com/rss/search?q=' . rawurlencode($q) . '&hl=ja&gl=JP&ceid=JP:ja', 6);
if ($rss === null || ($x = @simplexml_load_string($rss)) === false) {
  $errors[] = 'Google ニュースを読めませんでした';
} else {
  $seen = [];
  foreach ($x->channel->item as $it) {
    if (count($articles) >= 10) break;
    $title = (string)$it->title;
    $source = (string)$it->source;
    $srcUrl = (string)$it->source['url'];
    $key = $srcUrl !== '' ? $srcUrl : $source;
    if ($key !== '' && isset($seen[$key])) continue;
    $seen[$key] = true;
    // 題の末尾の「 - 媒体名」は媒体名として別に出す
    if ($source !== '' && mb_substr($title, -mb_strlen(' - ' . $source)) === ' - ' . $source) $title = mb_substr($title, 0, mb_strlen($title) - mb_strlen(' - ' . $source));
    $ts = strtotime((string)$it->pubDate);
    $articles[] = ['title' => $title, 'url' => (string)$it->link, 'source' => $source, 'date' => $ts ? date('Y/m/d', $ts) : ''];
  }
}

$res = ['q' => $q, 'phrases' => $phrases, 'articles' => $articles, 'errors' => $errors, 'fetchedAt' => date('Y/m/d H:i'), 'cached' => false];
// 両方読めたときだけ取っておく（読めなかった結果を1時間出し続けない）
if (!$errors) @file_put_contents($cacheFile, json_encode($res, JSON_UNESCAPED_UNICODE));
out($res);
