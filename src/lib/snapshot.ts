/**
 * Wayback 快照取回與解析層。
 *
 * Internet Archive 的 `tweets-*` crawl 把推文以 JSON 存在
 * `twitter.com/<user>/status/<id>`，取回方式是
 * `https://web.archive.org/web/<timestamp>id_/<originalUrl>`（`id_` 表示不做 Wayback 改寫）。
 *
 * JSON 有兩種 schema 世代，以「頂層有沒有 `data` 鍵」分派：
 * - v2（約 2026）：`{ data, includes }`，Twitter API v2 形狀。
 * - v1（約 2018）：頂層直接是 Twitter API v1.1 的 status 物件。
 *
 * 沒有 JSON 存檔的推文只剩 HTML 快照，只能從 `og:` meta 抽出有限資訊（降級路徑，
 * source 標為 `'html'`）；2022 年之後的快照多半是 React 空殼，抽不到就回 null。
 */

import { cdxTimestampToISO, fetchFromWayback, type ArchiveFetchOptions } from '@/lib/cdx';
import type {
  ArchivedTweet,
  ArchivedTweetRef,
  TweetAuthor,
  TweetMedia,
  TweetMetrics,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// 防禦性取值工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 取非空字串；數字型別的 id 也一併轉成字串。 */
function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** 移除物件中值為 undefined 的鍵，讓輸出的 JSON 乾淨一點。 */
function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

// ---------------------------------------------------------------------------
// 時間
// ---------------------------------------------------------------------------

/**
 * 解析推文的 created_at。
 * v2 是 ISO 8601（`2026-09-12T12:40:42.000Z`）；
 * v1 是 Twitter 的舊格式（`Sat Jun 09 02:06:34 +0000 2018`），JS 的 Date 可直接解析。
 * 解析失敗回 undefined，交給呼叫端用 CDX 時間戳補。
 */
export function parseTweetDate(raw: unknown): string | undefined {
  const text = asString(raw);
  if (!text) return undefined;
  const time = Date.parse(text);
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString();
}

function fallbackCreatedAt(timestamp: string): string {
  try {
    return cdxTimestampToISO(timestamp);
  } catch {
    return new Date(0).toISOString();
  }
}

// ---------------------------------------------------------------------------
// 共用小工具
// ---------------------------------------------------------------------------

export type SnapshotContext = {
  tweetId: string;
  timestamp: string;
  /** 原始推文 URL；沒有時會用 tweetId 組一個合理的預設值。 */
  originalUrl?: string;
};

/** 組出人類可點的 Wayback 快照網址（不含 `id_`）。 */
export function buildSnapshotUrl(timestamp: string, originalUrl: string): string {
  return `https://web.archive.org/web/${timestamp}/${originalUrl}`;
}

/** 組出取回原始位元組用的網址（含 `id_`，Wayback 不會改寫內容）。 */
export function buildRawSnapshotUrl(timestamp: string, originalUrl: string): string {
  return `https://web.archive.org/web/${timestamp}id_/${originalUrl}`;
}

function resolveOriginalUrl(ctx: SnapshotContext, username?: string): string {
  if (ctx.originalUrl) return ctx.originalUrl;
  return `https://twitter.com/${username ?? 'i'}/status/${ctx.tweetId}`;
}

/** 從一組影片 variants 中挑出 bitrate 最高的 mp4。 */
function pickBestVideoVariant(variants: unknown): string | undefined {
  let bestUrl: string | undefined;
  let bestRate = -1;
  for (const raw of asArray(variants)) {
    const variant = asRecord(raw);
    if (!variant) continue;
    const url = asString(variant.url);
    if (!url) continue;
    const contentType = asString(variant.content_type) ?? '';
    if (contentType && !/mp4/i.test(contentType)) continue;
    // v1 用 `bitrate`，v2 用 `bit_rate`。
    const rate = asNumber(variant.bitrate) ?? asNumber(variant.bit_rate) ?? 0;
    if (rate > bestRate) {
      bestRate = rate;
      bestUrl = url;
    }
  }
  return bestUrl;
}

// ---------------------------------------------------------------------------
// v2 解析（API v2 形狀：頂層 data + includes）
// ---------------------------------------------------------------------------

function parseV2Metrics(raw: unknown): TweetMetrics {
  const m = asRecord(raw);
  if (!m) return {};
  return compact({
    like: asNumber(m.like_count),
    retweet: asNumber(m.retweet_count),
    reply: asNumber(m.reply_count),
    quote: asNumber(m.quote_count),
    bookmark: asNumber(m.bookmark_count),
    impression: asNumber(m.impression_count),
  });
}

function parseV2Author(raw: unknown): TweetAuthor {
  const u = asRecord(raw);
  if (!u) return {};
  return compact({
    id: asString(u.id),
    username: asString(u.username),
    name: asString(u.name),
    profileImageUrl: asString(u.profile_image_url),
    verified: asBoolean(u.verified),
  });
}

function parseV2Media(includesMedia: unknown, mediaKeys: Set<string>): TweetMedia[] {
  const out: TweetMedia[] = [];
  for (const raw of asArray(includesMedia)) {
    const m = asRecord(raw);
    if (!m) continue;
    const key = asString(m.media_key);
    // 有 attachments.media_keys 時只取屬於這則推文的媒體。
    if (mediaKeys.size > 0 && key && !mediaKeys.has(key)) continue;
    const type = asString(m.type) ?? 'unknown';
    out.push(
      compact({
        type,
        url: asString(m.url) ?? pickBestVideoVariant(m.variants),
        previewUrl: asString(m.preview_image_url),
        expandedUrl: asString(m.expanded_url) ?? asString(m.display_url),
      }),
    );
  }
  return out;
}

function parseV2(root: Record<string, unknown>, ctx: SnapshotContext): ArchivedTweet | null {
  const data = asRecord(root.data);
  if (!data) return null;

  const includes = asRecord(root.includes) ?? {};
  const users = asArray(includes.users);
  const includedTweets = asArray(includes.tweets);

  const tweetId = asString(data.id) ?? ctx.tweetId;
  const authorId = asString(data.author_id);

  // 長推文全文優先於截斷過的 text。
  const noteText = asString(asRecord(data.note_tweet)?.text);
  const text = noteText ?? asString(data.text) ?? '';

  const authorRecord =
    users.find((u) => {
      const rec = asRecord(u);
      return rec !== undefined && asString(rec.id) === authorId;
    }) ?? users[0];
  const author = parseV2Author(authorRecord);

  // referenced_tweets 標示轉推 / 引用 / 回覆對象。
  let retweetId: string | undefined;
  let quotedId: string | undefined;
  let repliedToId: string | undefined;
  for (const raw of asArray(data.referenced_tweets)) {
    const ref = asRecord(raw);
    if (!ref) continue;
    const id = asString(ref.id);
    if (!id) continue;
    switch (asString(ref.type)) {
      case 'retweeted':
        retweetId = id;
        break;
      case 'quoted':
        quotedId = id;
        break;
      case 'replied_to':
        repliedToId = id;
        break;
      default:
        break;
    }
  }

  const findIncludedTweet = (id: string): Record<string, unknown> | undefined => {
    for (const raw of includedTweets) {
      const rec = asRecord(raw);
      if (rec && asString(rec.id) === id) return rec;
    }
    return undefined;
  };

  const findUsername = (userId: string | undefined): string | undefined => {
    if (!userId) return undefined;
    for (const raw of users) {
      const rec = asRecord(raw);
      if (rec && asString(rec.id) === userId) return asString(rec.username);
    }
    return undefined;
  };

  let retweetOf: ArchivedTweet['retweetOf'] = null;
  if (retweetId) {
    const source = findIncludedTweet(retweetId);
    retweetOf = compact({
      tweetId: retweetId,
      username: findUsername(asString(source?.author_id)),
      text: asString(asRecord(source?.note_tweet)?.text) ?? asString(source?.text),
    });
  }

  const mediaKeys = new Set<string>();
  for (const key of asArray(asRecord(data.attachments)?.media_keys)) {
    const k = asString(key);
    if (k) mediaKeys.add(k);
  }

  const inReplyToUsername =
    asString(data.in_reply_to_username) ?? findUsername(asString(data.in_reply_to_user_id)) ?? null;

  const originalUrl = resolveOriginalUrl(ctx, author.username);

  return compact({
    tweetId,
    text,
    createdAt: parseTweetDate(data.created_at) ?? fallbackCreatedAt(ctx.timestamp),
    lang: asString(data.lang),
    author,
    metrics: parseV2Metrics(data.public_metrics),
    media: parseV2Media(includes.media, mediaKeys),
    inReplyToStatusId: repliedToId ?? null,
    inReplyToUsername,
    isRetweet: retweetId !== undefined,
    retweetOf,
    quotedStatusId: quotedId ?? null,
    conversationId: asString(data.conversation_id),
    source: 'v2',
    snapshotUrl: buildSnapshotUrl(ctx.timestamp, originalUrl),
    snapshotTimestamp: ctx.timestamp,
  } satisfies ArchivedTweet);
}

// ---------------------------------------------------------------------------
// v1 解析（Twitter API v1.1 status 物件）
// ---------------------------------------------------------------------------

function parseV1Metrics(status: Record<string, unknown>): TweetMetrics {
  return compact({
    like: asNumber(status.favorite_count),
    retweet: asNumber(status.retweet_count),
    reply: asNumber(status.reply_count),
    quote: asNumber(status.quote_count),
  });
}

function parseV1Author(raw: unknown): TweetAuthor {
  const u = asRecord(raw);
  if (!u) return {};
  return compact({
    id: asString(u.id_str) ?? asString(u.id),
    username: asString(u.screen_name),
    name: asString(u.name),
    profileImageUrl: asString(u.profile_image_url_https) ?? asString(u.profile_image_url),
    verified: asBoolean(u.verified),
  });
}

/** v1 的媒體在 extended_entities.media，退而求其次才用 entities.media。 */
function parseV1Media(status: Record<string, unknown>): TweetMedia[] {
  const extended = asArray(asRecord(status.extended_entities)?.media);
  const list = extended.length > 0 ? extended : asArray(asRecord(status.entities)?.media);
  const out: TweetMedia[] = [];
  for (const raw of list) {
    const m = asRecord(raw);
    if (!m) continue;
    const type = asString(m.type) ?? 'photo';
    const preview = asString(m.media_url_https) ?? asString(m.media_url);
    const videoUrl = pickBestVideoVariant(asRecord(m.video_info)?.variants);
    out.push(
      compact({
        type,
        url: type === 'photo' ? preview : (videoUrl ?? preview),
        previewUrl: preview,
        expandedUrl: asString(m.expanded_url),
      }),
    );
  }
  return out;
}

/** v1 的推文全文：extended_tweet.full_text > full_text > text。 */
function v1Text(status: Record<string, unknown>): string {
  return (
    asString(asRecord(status.extended_tweet)?.full_text) ??
    asString(status.full_text) ??
    asString(status.text) ??
    ''
  );
}

function parseV1(status: Record<string, unknown>, ctx: SnapshotContext): ArchivedTweet | null {
  const tweetId = asString(status.id_str) ?? asString(status.id) ?? ctx.tweetId;
  const author = parseV1Author(status.user);
  const retweeted = asRecord(status.retweeted_status);

  let retweetOf: ArchivedTweet['retweetOf'] = null;
  if (retweeted) {
    const sourceId = asString(retweeted.id_str) ?? asString(retweeted.id);
    if (sourceId) {
      retweetOf = compact({
        tweetId: sourceId,
        username: asString(asRecord(retweeted.user)?.screen_name),
        text: v1Text(retweeted),
      });
    }
  }

  // 轉推時本體的 text 常被截斷成 `RT @user: ...`，改用來源推文的全文重組。
  let text = v1Text(status);
  if (retweetOf && retweetOf.text && /^RT @\w+:/.test(text)) {
    text = `RT @${retweetOf.username ?? ''}: ${retweetOf.text}`;
  }

  const originalUrl = resolveOriginalUrl(ctx, author.username);

  return compact({
    tweetId,
    text,
    createdAt: parseTweetDate(status.created_at) ?? fallbackCreatedAt(ctx.timestamp),
    lang: asString(status.lang),
    author,
    metrics: parseV1Metrics(status),
    media: parseV1Media(retweeted ?? status),
    inReplyToStatusId: asString(status.in_reply_to_status_id_str) ?? null,
    inReplyToUsername: asString(status.in_reply_to_screen_name) ?? null,
    isRetweet: retweeted !== undefined,
    retweetOf,
    quotedStatusId: asString(status.quoted_status_id_str) ?? null,
    conversationId: undefined,
    source: 'v1',
    snapshotUrl: buildSnapshotUrl(ctx.timestamp, originalUrl),
    snapshotTimestamp: ctx.timestamp,
  } satisfies ArchivedTweet);
}

// ---------------------------------------------------------------------------
// JSON 入口（純函式，方便單元測試）
// ---------------------------------------------------------------------------

/**
 * 解析結構化 JSON 存檔。用「頂層有沒有 `data` 鍵」分派 v2 / v1。
 * 認不出來或缺少必要欄位時回 null，不會 throw。
 */
export function parseArchivedTweetJson(
  json: unknown,
  ctx: SnapshotContext,
): ArchivedTweet | null {
  const root = asRecord(json);
  if (!root) return null;

  try {
    if (isRecord(root.data)) return parseV2(root, ctx);

    // v1：頂層直接就是 status 物件。至少要有 id 或文字才視為有效。
    const looksLikeV1 =
      root.id_str !== undefined ||
      root.id !== undefined ||
      root.full_text !== undefined ||
      root.text !== undefined;
    if (looksLikeV1) return parseV1(root, ctx);
  } catch (error) {
    console.warn(`[snapshot] 解析 JSON 失敗（tweetId=${ctx.tweetId}）：`, error);
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// HTML 降級解析
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** HTML entity 反跳脫（具名 + 十進位 + 十六進位）。 */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 用正則抽出 `<meta property="..." content="...">`（兩種屬性順序都支援）。 */
export function extractMetaContent(html: string, property: string): string | undefined {
  const key = escapeRegExp(property);
  const patterns = [
    new RegExp(
      `<meta[^>]*?(?:property|name)\\s*=\\s*["']${key}["'][^>]*?content\\s*=\\s*["']([\\s\\S]*?)["']`,
      'i',
    ),
    new RegExp(
      `<meta[^>]*?content\\s*=\\s*["']([\\s\\S]*?)["'][^>]*?(?:property|name)\\s*=\\s*["']${key}["']`,
      'i',
    ),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) {
      const value = decodeHtmlEntities(match[1]).trim();
      if (value.length > 0) return value;
    }
  }
  return undefined;
}

/** Twitter 的 og:description 常被前後包上引號（含全形引號），去掉它。 */
function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  const pairs: [string, string][] = [
    ['“', '”'],
    ['"', '"'],
    ['「', '」'],
  ];
  for (const [open, close] of pairs) {
    if (trimmed.length >= 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/** 把 HTML 片段的標籤去掉，只留純文字。 */
function stripTags(fragment: string): string {
  return decodeHtmlEntities(
    fragment.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 早期 Twitter 頁面把推文正文放在 `<div class="desc">`。 */
const LEGACY_DESC_RE =
  /<(div|span|p)[^>]*\bclass\s*=\s*["'][^"']*\bdesc\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i;
/** 早期頁面的標題形如 `Twitter / 顯示名稱: 被截斷的內文…`。 */
const LEGACY_TITLE_RE = /<title>\s*Twitter\s*\/\s*([^<:]+?)\s*:\s*[\s\S]*?<\/title>/i;

/**
 * 解析 2007–2009 年的 Twitter 狀態頁。
 *
 * 那個年代早於 Open Graph（2010 年才出現），整頁沒有任何 `og:` meta，
 * 正文在 `<div class="desc">` 裡，`<title>` 只有被截斷的版本。
 */
function parseLegacyStatusHtml(html: string): { text: string; name?: string } | null {
  const desc = LEGACY_DESC_RE.exec(html);
  if (!desc) return null;
  const text = stripTags(desc[2]);
  if (text.length === 0) return null;
  const name = LEGACY_TITLE_RE.exec(html)?.[1]?.trim();
  return { text, name: name && name.length > 0 ? name : undefined };
}

const HTML_USERNAME_RE = /^https?:\/\/[^/]+\/([A-Za-z0-9_]{1,20})\/status(?:es)?\//i;
/** og:title 形如 `名字 on Twitter: "內文"` 或 `名字 (@handle) on X`。 */
const TITLE_HANDLE_RE = /\(@([A-Za-z0-9_]{1,20})\)/;
const TITLE_QUOTED_RE = /on (?:Twitter|X)\s*:\s*([\s\S]+)$/i;

/**
 * 從 HTML 快照的 og: meta 抽出推文資訊（降級路徑）。
 * 2018–2021 的快照通常可行；2022 之後是 React SPA 空殼，多半抽不到，回 null。
 */
export function parseArchivedTweetHtml(
  html: string,
  ctx: SnapshotContext,
): ArchivedTweet | null {
  if (typeof html !== 'string' || html.length === 0) return null;

  const ogUrl = extractMetaContent(html, 'og:url');
  const ogTitle = extractMetaContent(html, 'og:title');
  const ogDescription = extractMetaContent(html, 'og:description');
  const ogImage = extractMetaContent(html, 'og:image');

  let text = ogDescription ? stripWrappingQuotes(ogDescription) : undefined;
  if (!text && ogTitle) {
    const quoted = TITLE_QUOTED_RE.exec(ogTitle);
    if (quoted) text = stripWrappingQuotes(quoted[1]);
  }

  // 2007–2009 年的頁面早於 Open Graph，完全沒有 og: meta，改走舊版型解析。
  let legacyName: string | undefined;
  if (!text) {
    const legacy = parseLegacyStatusHtml(html);
    if (legacy) {
      text = legacy.text;
      legacyName = legacy.name;
    }
  }

  // 抽不到文字就承認失敗，不要硬猜。
  if (!text) return null;

  const username =
    (ogUrl ? HTML_USERNAME_RE.exec(ogUrl)?.[1] : undefined) ??
    (ogTitle ? TITLE_HANDLE_RE.exec(ogTitle)?.[1] : undefined) ??
    (ctx.originalUrl ? HTML_USERNAME_RE.exec(ctx.originalUrl)?.[1] : undefined);

  let name: string | undefined = legacyName;
  if (!name && ogTitle) {
    const head = ogTitle.split(/ on (?:Twitter|X)\b/i)[0]?.trim();
    if (head) name = head.replace(/\s*\(@[A-Za-z0-9_]{1,20}\)\s*$/, '').trim() || undefined;
  }

  // og:image 常是頭像或站台預設圖，只有看起來像貼文媒體時才收。
  const media: TweetMedia[] = [];
  if (ogImage && /pbs\.twimg\.com\/(?:media|ext_tw_video_thumb|amplify_video_thumb)\//.test(ogImage)) {
    media.push({ type: 'photo', url: ogImage, previewUrl: ogImage });
  }

  const originalUrl = ctx.originalUrl ?? ogUrl ?? resolveOriginalUrl(ctx, username);

  return compact({
    tweetId: ctx.tweetId,
    text,
    createdAt: fallbackCreatedAt(ctx.timestamp),
    lang: undefined,
    author: compact({ username, name }),
    metrics: {},
    media,
    inReplyToStatusId: null,
    inReplyToUsername: null,
    isRetweet: /^RT @\w+:/.test(text),
    retweetOf: null,
    quotedStatusId: null,
    conversationId: undefined,
    source: 'html',
    snapshotUrl: buildSnapshotUrl(ctx.timestamp, originalUrl),
    snapshotTimestamp: ctx.timestamp,
  } satisfies ArchivedTweet);
}

// ---------------------------------------------------------------------------
// 取回入口
// ---------------------------------------------------------------------------

export type FetchArchivedTweetContentOptions = ArchiveFetchOptions;

/**
 * 取回並解析一則存檔推文。
 * 先試結構化 JSON（v2 / v1），失敗才退回 HTML og:meta。全部失敗回 null。
 */
export async function fetchArchivedTweetContent(
  ref: Pick<ArchivedTweetRef, 'tweetId' | 'timestamp' | 'originalUrl'>,
  options: FetchArchivedTweetContentOptions = {},
): Promise<ArchivedTweet | null> {
  const ctx: SnapshotContext = {
    tweetId: ref.tweetId,
    timestamp: ref.timestamp,
    originalUrl: ref.originalUrl,
  };
  const url = buildRawSnapshotUrl(ref.timestamp, ref.originalUrl);

  let result;
  try {
    result = await fetchFromWayback(url, options);
  } catch (error) {
    console.warn(`[snapshot] 取回快照失敗（tweetId=${ref.tweetId}）：`, error);
    return null;
  }

  if (!result.ok) {
    console.warn(`[snapshot] 快照回應 ${result.status}（tweetId=${ref.tweetId}）`);
    return null;
  }

  const body = result.text;
  const trimmed = body.trimStart();
  const looksLikeJson = /json/i.test(result.contentType) || trimmed.startsWith('{');

  if (looksLikeJson) {
    try {
      const parsed = parseArchivedTweetJson(JSON.parse(body), ctx);
      if (parsed) return parsed;
    } catch {
      // 不是合法 JSON，往下走 HTML 路徑。
    }
  }

  return parseArchivedTweetHtml(body, ctx);
}
