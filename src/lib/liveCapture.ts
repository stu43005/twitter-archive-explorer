/**
 * 即時擷取層：直接向 X 的 syndication 端點取回一則推文，轉成 `ArchivedTweet`。
 *
 * 與 `snapshot.ts` 的差別：這裡拿到的是「推文現在的樣子」，不是 Internet Archive
 * 的歷史快照，所以 `source` 標為 `'live'`、只填 `capturedAt`，
 * 不會有 `snapshotUrl` / `snapshotTimestamp`。
 *
 * 只能在 Node runtime（後端）執行：syndication 的
 * `access-control-allow-origin` 寫死成 `https://platform.twitter.com`，
 * 瀏覽器無法直接呼叫。
 *
 * 端點行為（已實測）：
 * - 推文還在 → 200 + `application/json`，頂層 `__typename === 'Tweet'`。
 * - 取不到   → 404 + `text/html`（X 的錯誤頁）。
 *   404 只代表「現在取不到」，無法區分已刪除／帳號停權／改為受保護／地區封鎖，
 *   所以任何對外訊息都不得斷言推文「已被刪除」。
 */

import { tweetIdToISO } from '@/lib/cdx';
import { buildSyndicationToken } from '@/lib/liveness';
import type {
  ArchivedTweet,
  TweetAuthor,
  TweetMedia,
  TweetMetrics,
} from '@/lib/types';

const SYNDICATION_ENDPOINT = 'https://cdn.syndication.twimg.com/tweet-result';

/** 一般瀏覽器 UA；不帶的話 syndication 偶爾會直接擋掉。 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 單一請求的預設逾時（毫秒）。 */
export const DEFAULT_LIVE_CAPTURE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// 防禦性取值工具（與 snapshot.ts 同一套風格，刻意各自持有以免相互耦合）
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

/** 移除物件中值為 undefined 的鍵，讓輸出的 JSON 乾淨一點。 */
function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

/** 解析 syndication 的 `created_at`（ISO 8601）。解析不出來回 undefined。 */
function parseCreatedAt(raw: unknown): string | undefined {
  const text = asString(raw);
  if (!text) return undefined;
  const time = Date.parse(text);
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString();
}

// ---------------------------------------------------------------------------
// 欄位解析
// ---------------------------------------------------------------------------

function parseAuthor(raw: unknown): TweetAuthor {
  const u = asRecord(raw);
  if (!u) return {};

  // syndication 同時有兩個「認證」欄位：
  // `verified` 是舊制藍勾（多半已是 false），`is_blue_verified` 是 X Premium。
  // `TweetAuthor.verified` 只有一格，任一為 true 就視為已認證；
  // 兩個欄位都不存在時保持 undefined（代表「不知道」，而不是「未認證」）。
  const legacyVerified = typeof u.verified === 'boolean' ? u.verified : undefined;
  const blueVerified = typeof u.is_blue_verified === 'boolean' ? u.is_blue_verified : undefined;
  const verified =
    legacyVerified === undefined && blueVerified === undefined
      ? undefined
      : legacyVerified === true || blueVerified === true;

  return compact({
    id: asString(u.id_str) ?? asString(u.id),
    username: asString(u.screen_name),
    name: asString(u.name),
    profileImageUrl: asString(u.profile_image_url_https) ?? asString(u.profile_image_url),
    verified,
  });
}

/**
 * syndication 只回 `favorite_count` 與 `conversation_count`，
 * **沒有** retweet / quote / bookmark / impression，也沒有單純的 reply 數。
 * 缺的欄位一律留空，不要用其他數字冒充。
 */
function parseMetrics(root: Record<string, unknown>): TweetMetrics {
  return compact({
    like: asNumber(root.favorite_count),
    // 注意：`conversation_count` 是整條對話串的貼文總數（含更深層的回覆與作者自串），
    // 並不等於「直接回覆數」。這裡當成 reply 的近似值，讀取端不應把它當精確回覆數。
    reply: asNumber(root.conversation_count),
  });
}

/** 從一組影片 variants 中挑出 bitrate 最高的 mp4。 */
function pickBestVideoVariant(variants: unknown): string | undefined {
  let bestUrl: string | undefined;
  let bestRate = -1;
  for (const raw of asArray(variants)) {
    const variant = asRecord(raw);
    if (!variant) continue;
    // mediaDetails 的 video_info 用 `url` + `content_type`；
    // 頂層 `video.variants` 的鍵名可能不同，一併防禦性接受。
    const url = asString(variant.url) ?? asString(variant.src);
    if (!url) continue;
    const contentType = asString(variant.content_type) ?? asString(variant.type) ?? '';
    // HLS（application/x-mpegURL）在後端與一般 <video> 都不好直接播，只收 mp4。
    if (contentType && !/mp4/i.test(contentType)) continue;
    const rate = asNumber(variant.bitrate) ?? asNumber(variant.bit_rate) ?? 0;
    if (rate > bestRate) {
      bestRate = rate;
      bestUrl = url;
    }
  }
  return bestUrl;
}

/**
 * 媒體以 `mediaDetails` 為主（欄位最完整）；
 * 沒有時退而求其次用頂層的 `photos` / `video`（react-tweet 用的簡化形狀）。
 * `entities.media` 只有 t.co 短網址、沒有 `media_url_https`，不足以獨立成一筆媒體。
 */
function parseMedia(root: Record<string, unknown>): TweetMedia[] {
  const out: TweetMedia[] = [];

  for (const raw of asArray(root.mediaDetails)) {
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
  if (out.length > 0) return out;

  for (const raw of asArray(root.photos)) {
    const p = asRecord(raw);
    if (!p) continue;
    const url = asString(p.url);
    if (!url) continue;
    out.push(
      compact({
        type: 'photo',
        url,
        previewUrl: url,
        expandedUrl: asString(p.expandedUrl),
      }),
    );
  }

  const video = asRecord(root.video);
  if (video) {
    const poster = asString(video.poster);
    const url = pickBestVideoVariant(video.variants);
    if (url !== undefined || poster !== undefined) {
      out.push(
        compact({
          type: asString(video.contentType) === 'animated_gif' ? 'animated_gif' : 'video',
          url: url ?? poster,
          previewUrl: poster,
          expandedUrl: undefined,
        }),
      );
    }
  }

  return out;
}

/** 轉推的文字前綴，例：`RT @jack: ...`。 */
const RETWEET_PREFIX_RE = /^RT @\w+:/;

export type LiveCaptureContext = {
  /** 呼叫端要求的推文 id；回應缺 `id_str` 時當備援。 */
  tweetId: string;
};

/**
 * 把 syndication 的 JSON 轉成 `ArchivedTweet`。純函式，方便單元測試。
 *
 * 防禦性解析：任何欄位缺失都不會 throw；形狀不對（不是物件、
 * `__typename` 不是 `'Tweet'`、或連文字都抽不到）就回 null。
 */
export function parseSyndicationTweet(
  json: unknown,
  ctx: LiveCaptureContext,
): ArchivedTweet | null {
  const root = asRecord(json);
  if (!root) return null;

  try {
    // tombstone（受保護／停權）與其他錯誤形狀都不是可用的推文。
    if (asString(root.__typename) !== 'Tweet') return null;

    const tweetId = asString(root.id_str) ?? ctx.tweetId;
    if (!tweetId) return null;

    // 長推文（note tweet）的全文優先於被截斷的 `text`。
    const noteText = asString(asRecord(root.note_tweet)?.text);
    const text = noteText ?? asString(root.text);
    if (text === undefined) return null;

    const author = parseAuthor(root.user);

    // 限制：syndication 對「轉推」通常直接回傳被轉的原推文本體，
    // 沒有 v1 的 `retweeted_status`、也沒有 v2 的 `referenced_tweets`，
    // 因此只能靠 `RT @xxx:` 這個文字前綴判斷，且判不出被轉推文的 id
    // （所以 `retweetOf` 一律為 null）。
    // 少數推文正文本身就以 `RT @xxx:` 開頭時會誤判，這是已知且無解的限制。
    const isRetweet = RETWEET_PREFIX_RE.test(text);

    const quotedStatusId = asString(asRecord(root.quoted_tweet)?.id_str) ?? null;

    return compact({
      tweetId,
      text,
      // created_at 缺漏時用 snowflake 反推；再不行才落到 epoch（早期 id 推不出時間）。
      createdAt:
        parseCreatedAt(root.created_at) ?? tweetIdToISO(tweetId) ?? new Date(0).toISOString(),
      lang: asString(root.lang),
      author,
      metrics: parseMetrics(root),
      media: parseMedia(root),
      inReplyToStatusId: asString(root.in_reply_to_status_id_str) ?? null,
      inReplyToUsername: asString(root.in_reply_to_screen_name) ?? null,
      isRetweet,
      retweetOf: null,
      quotedStatusId,
      // syndication 沒有 conversation_id 欄位，留空而不是拿其他 id 頂替。
      conversationId: undefined,
      source: 'live',
      // live 擷取沒有 Wayback 快照，snapshotUrl / snapshotTimestamp 一律不填。
      capturedAt: new Date().toISOString(),
    } satisfies ArchivedTweet);
  } catch (error) {
    console.warn(`[liveCapture] 解析 syndication JSON 失敗（tweetId=${ctx.tweetId}）：`, error);
    return null;
  }
}

/** 把逾時訊號與外部取消訊號合併成一個。 */
function makeSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

/** 丟棄不需要的 response body，避免連線被卡住。 */
async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // 忽略：body 已經被讀完或連線已關閉。
  }
}

export type CaptureTweetOptions = {
  /** 外部取消訊號（例如 request.signal）。 */
  signal?: AbortSignal;
  /** 單一請求逾時，預設 15 秒。 */
  timeoutMs?: number;
};

/**
 * 直接向 X 擷取一則推文。
 *
 * 回傳值語意（呼叫端必須能分辨這兩種情況）：
 * - `null`：X 回 404，或回了 200 但解析不出可用的推文
 *   —— 也就是「這則推文現在取不到」（無法區分刪除／停權／私密／地區封鎖）。
 * - **throw**：網路錯誤、逾時、被限流（429）、伺服器錯誤（5xx）等
 *   —— 也就是「我們沒抓成功」，之後重試有機會拿到。
 */
export async function captureTweetFromLive(
  tweetId: string,
  opts: CaptureTweetOptions = {},
): Promise<ArchivedTweet | null> {
  if (!/^\d+$/.test(tweetId)) {
    throw new Error('推文 id 不是純數字');
  }

  const token = buildSyndicationToken(tweetId);
  const url = `${SYNDICATION_ENDPOINT}?id=${encodeURIComponent(tweetId)}&lang=en&token=${encodeURIComponent(token)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: makeSignal(opts.timeoutMs ?? DEFAULT_LIVE_CAPTURE_TIMEOUT_MS, opts.signal),
      cache: 'no-store',
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new Error('擷取請求已被呼叫端取消');
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('向 X 擷取推文逾時');
    }
    if (err instanceof Error) throw new Error(`向 X 擷取推文時發生網路錯誤：${err.message}`);
    throw new Error(`向 X 擷取推文時發生網路錯誤：${String(err)}`);
  }

  // 404 是「取不到」，不是抓取失敗，回 null 讓呼叫端走「內容不可得」的路徑。
  if (res.status === 404) {
    await drain(res);
    return null;
  }
  if (res.status === 429) {
    await drain(res);
    throw new Error('向 X 擷取推文被限流（429），稍後再試');
  }
  if (res.status >= 500) {
    await drain(res);
    throw new Error(`X 伺服器錯誤（${res.status}），稍後再試`);
  }
  if (!res.ok) {
    await drain(res);
    throw new Error(`向 X 擷取推文收到非預期狀態碼（${res.status}）`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // 200 但不是 JSON（例如被導去錯誤頁）：算擷取失敗，不是推文不存在。
    throw new Error('X 回應 200 但內容不是合法 JSON');
  }

  return parseSyndicationTweet(body, { tweetId });
}
