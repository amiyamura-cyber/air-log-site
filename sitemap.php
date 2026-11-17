<?php
// エアログのサイトマップを、開かれたときに Firestore から作る（2026-11-17・案②）
//
// なぜあるか：
//   管理画面で記事を保存しても Firestore に書くだけで、sitemap.xml（この Mac で作って FTP で上げるファイル）は
//   次に tools/deploy-rc.sh を動かすまで古いままだった。ここで作れば、上げ直さなくても新しい記事が載る。
//
// 仕組み：
//   ・.htaccess で sitemap.xml へのアクセスをこのファイルに回す（?static=1 のときは回さない＝予備をそのまま見る）
//   ・載せるものは tools/build-static.mjs の writeSitemap と同じ（トップ・一覧ページ・今出ている記事）。判定を変えるときは両方直す
//   ・作ったものはサーバーに取っておく（.sitemap-cache.xml と、数などの控え .sitemap-cache.json）。Firestore は無料プランで、
//     読み取りは1日5万回まで（2026-10-19 に一度使い切った）。全件読むと約400回かかるので、なるべく読まない：
//       10 分以内に作ったもの → そのまま返す（読み取り 0）
//       10 分を過ぎたら公開の記事の数だけ聞く（読み取り 1）。数が同じ・公開日／掲載終了日の境目をまだ過ぎていない・作って 6 時間以内なら、
//       取っておいたものを返して時計だけ戻す。どれかに当たったら全件読んで作り直す
//     つまり記事を公開・非公開にしたら、遅くとも 10 分後の次のアクセスで載る／消える。
//     数の変わらない入れ替え（1本公開して同時に別の1本を非公開）だけは、最大 6 時間前のものが出る
//   ・Firestore を読めない・0 本だったときは、予備の sitemap.xml（deploy-rc.sh が上げたもの）をそのまま返す。空のサイトマップは出さない
//   ・どこから返したかを X-Sitemap-Source（live／cache／static）に、公開の記事の数を X-Sitemap-Public に、載せなかった記事（公開日がまだ・掲載終了）の数を
//     X-Sitemap-Hidden に、作ってからの秒数を X-Sitemap-Age に書く。tools/check-live.mjs と tools/watch-sitemap.mjs（GitHub の見張り）がこれを見る

const LIVE = 'https://rc-group.co.jp/airlog/';
const PROJECT = 'air-log-db';
const LISTS = ['?cat=new', '?cat=sns', '?cat=news', '?cat=hrd', '?page=download'];
const CACHE_FILE = __DIR__ . '/.sitemap-cache.xml';
const CACHE_SEC = 600;          // これより新しいものは何も聞かずに返す
const META_FILE = __DIR__ . '/.sitemap-cache.json';
const MAX_SEC = 6 * 3600;        // 数が同じでも、これを過ぎたら全件読み直す

function send_xml($xml, $source, $meta = null) {
  header('Content-Type: application/xml; charset=UTF-8');
  header('Cache-Control: public, max-age=' . CACHE_SEC);
  header('X-Sitemap-Source: ' . $source);
  if ($meta) {
    header('X-Sitemap-Public: ' . $meta['public']);
    header('X-Sitemap-Hidden: ' . $meta['hidden']);
    header('X-Sitemap-Age: ' . max(0, time() - $meta['checked']));
  }
  echo $xml;
  exit;
}
function firestore_post($path, $body) {
  $ctx = stream_context_create(['http' => [
    'method' => 'POST', 'header' => "Content-Type: application/json\r\n", 'content' => json_encode($body), 'timeout' => 15, 'ignore_errors' => true,
  ]]);
  $r = @file_get_contents('https://firestore.googleapis.com/v1/projects/' . PROJECT . '/databases/(default)/documents' . $path, false, $ctx);
  $status = isset($http_response_header[0]) ? $http_response_header[0] : '';
  if ($r === false || strpos($status, ' 200') === false) return null;
  $j = json_decode($r, true);
  return is_array($j) ? $j : null;
}
function public_filter() {
  return ['fieldFilter' => ['field' => ['fieldPath' => 'status'], 'op' => 'EQUAL', 'value' => ['stringValue' => 'public']]];
}
// 公開の記事の数（読み取り 1 回）。読めなければ null
function public_count() {
  $j = firestore_post(':runAggregationQuery', ['structuredAggregationQuery' => [
    'structuredQuery' => ['from' => [['collectionId' => 'posts']], 'where' => public_filter()],
    'aggregations' => [['alias' => 'n', 'count' => new stdClass()]],
  ]]);
  if (!$j || !isset($j[0]['result']['aggregateFields']['n']['integerValue'])) return null;
  return (int)$j[0]['result']['aggregateFields']['n']['integerValue'];
}

function send_static() {
  $f = __DIR__ . '/sitemap.xml';
  if (!is_readable($f)) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=UTF-8');
    header('X-Sitemap-Source: none');
    echo "sitemap unavailable\n";
    exit;
  }
  send_xml(file_get_contents($f), 'static');
}

// 取っておいたものを返せるか（上の「なるべく読まない」の決まり）
$meta = is_readable(META_FILE) ? json_decode(file_get_contents(META_FILE), true) : null;
$cached = is_readable(CACHE_FILE) ? file_get_contents(CACHE_FILE) : false;
if (is_array($meta) && isset($meta['public'], $meta['hidden'], $meta['built'], $meta['checked'], $meta['next']) && $cached !== false && strpos($cached, '<urlset') !== false) {
  $t = time();
  if ($t - $meta['checked'] < CACHE_SEC) send_xml($cached, 'cache', $meta);
  if ($t - $meta['built'] < MAX_SEC && ($meta['next'] === 0 || $t < $meta['next'])) {
    $n = public_count();
    if ($n !== null && $n === $meta['public']) {
      $meta['checked'] = $t;
      @file_put_contents(META_FILE, json_encode($meta));
      send_xml($cached, 'cache', $meta);
    }
  }
}

// 公開（status == 'public'）の記事を、公開日・掲載終了日だけ読む（build-static.mjs の readPosts と同じ聞き方）
$rows = firestore_post(':runQuery', ['structuredQuery' => [
  'from' => [['collectionId' => 'posts']],
  'where' => public_filter(),
  'select' => ['fields' => [['fieldPath' => 'startDate'], ['fieldPath' => 'endDate']]],
]]);
if ($rows === null) send_static();

// 日付の読み方は build-static.mjs の parseWhenJst と同じ：時刻が無ければ開始＝0時・終了＝23:59:59、時差が無ければ日本時間
function field_value($fields, $name) {
  if (!isset($fields[$name]) || !is_array($fields[$name])) return null;
  $v = $fields[$name];
  if (isset($v['stringValue'])) return $v['stringValue'];
  if (isset($v['timestampValue'])) return $v['timestampValue'];
  return null;
}
function parse_when_jst($v, $is_end) {
  if ($v === null || $v === '') return null;
  $s = (string)$v;
  if (strpos($s, 'T') === false) $s .= $is_end ? 'T23:59:59' : 'T00:00:00';
  if (!preg_match('/(Z|[+-]\d\d:?\d\d)$/', $s)) $s .= '+09:00';
  try { return new DateTime($s); } catch (Exception $e) { return null; }
}
// JavaScript の encodeURIComponent と同じ形にする（! ' ( ) * はそのまま）
function enc($s) {
  return strtr(rawurlencode($s), ['%21' => '!', '%27' => "'", '%28' => '(', '%29' => ')', '%2A' => '*']);
}
function esc($s) {
  return str_replace(['&', '<', '>'], ['&amp;', '&lt;', '&gt;'], $s);
}

$now = new DateTime('now');
$urls = [LIVE];
foreach (LISTS as $l) $urls[] = LIVE . $l;
$posts = 0;
$hidden = 0;
$next = 0; // 次に「載る／消える」が変わる時刻（公開日がまだの記事の公開日・載っている記事の掲載終了日のうち、いちばん早いもの）
$soonest = function ($d) use (&$next) { $ts = $d->getTimestamp(); if ($next === 0 || $ts < $next) $next = $ts; };
foreach ($rows as $row) {
  if (!isset($row['document']['name'])) continue;
  $posts++;
  $f = isset($row['document']['fields']) ? $row['document']['fields'] : [];
  $sd = field_value($f, 'startDate');
  $ed = field_value($f, 'endDate');
  $s = parse_when_jst($sd, false);
  $e = parse_when_jst($ed, true);
  if ($e && $now > $e) { $hidden++; continue; }                                  // 掲載終了
  if ($sd !== null && $sd !== '' && !($s && $now >= $s)) { $hidden++; if ($s) $soonest($s); continue; } // 公開日がまだ
  if ($e) $soonest($e);
  $parts = explode('/', $row['document']['name']);
  $urls[] = LIVE . '?id=' . enc(end($parts));
}
if ($posts === 0) send_static(); // 0 本は「読めなかった」とみなす

$xml = '<?xml version="1.0" encoding="UTF-8"?>' . "\n" . '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' . "\n";
foreach ($urls as $u) $xml .= '<url><loc>' . esc($u) . "</loc></url>\n";
$xml .= "</urlset>\n";

$t = time();
$meta = ['public' => $posts, 'hidden' => $hidden, 'built' => $t, 'checked' => $t, 'next' => $next];
$tmp = CACHE_FILE . '.' . getmypid();
if (@file_put_contents($tmp, $xml) !== false && @rename($tmp, CACHE_FILE)) @file_put_contents(META_FILE, json_encode($meta));
send_xml($xml, 'live', $meta);
