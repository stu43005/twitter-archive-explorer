/**
 * Wayback CDX 索引存取層。
 *
 * 只能在伺服器端使用：web.archive.org 的 CDX API 沒有 CORS header。
 *
 * 已知的服務特性（實測）：
 * - 回傳 JSON 的第一列是欄位名稱列，必須跳過。
 * - 不可加 `filter=statuscode:200`：結構化 JSON 存檔的 statuscode 是 `-`，會被整批濾掉。
 * - 排序是 urlkey（SURT 字母序）再 timestamp，不是時間序，必須自己重排。
 * - `collapse=urlkey` 只對相鄰列生效；因預設就是 urlkey 排序，等同「每個 URL 一筆」。
 * - 有 rate limit，短時間連續查詢會逾時，因此所有請求一律序列化並保留間隔。
 */

import type { ArchivedTweetRef } from '@/lib/types';

const CDX_ENDPOINT = 'https://web.archive.org/cdx/search/cdx';

/** 三個網域都有 Twitter 的存檔資料，需分別查詢後合併。 */
export const TWITTER_DOMAINS = ['twitter.com', 'x.com', 'mobile.twitter.com'] as const;

/**
 * 每批撈取的列數，用 CDX 文件上的單次查詢上限。
 *
 * 這個值攸關整體耗時：CDX 不論 limit 多少都要掃過整個 urlkey 區間，
 * 所以「小 limit 多翻頁」等於把同樣的掃描成本重複付好幾次。
 * 實測 `twitter.com/jack/status/*` 有 60,332 個不重複 urlkey：
 * limit=150000 一次撈完只要約 55 秒，limit=5000 則要 13 頁、超過 300 秒。
 */
const DEFAULT_PAGE_LIMIT = 150_000;

/** 每個網域最多翻幾頁，避免 resumeKey 異常時無限迴圈。 */
const DEFAULT_MAX_PAGES = 12;

/** 對 web.archive.org 兩次請求「開始時間」之間的最小間隔（毫秒）。 */
const DEFAULT_THROTTLE_MS = 400;

/** 同時對 web.archive.org 發出的請求數上限。三個網域彼此獨立，可並行。 */
const DEFAULT_CONCURRENCY = 3;

/**
 * 整趟索引的時間預算（毫秒）。超過就帶著已取得的資料收工並標記為不完整，
 * 避免呼叫端無限期等待。
 */
const DEFAULT_DEADLINE_MS = 150_000;

/** 單一請求的逾時（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** 失敗重試次數（不含第一次嘗試）。 */
const DEFAULT_RETRIES = 3;

const USER_AGENT =
  'twitter-archive-explorer/0.1 (+https://github.com/; contact: archive explorer)';

// ---------------------------------------------------------------------------
// 節流 / 重試
// ---------------------------------------------------------------------------

export type ArchiveFetchOptions = {
  signal?: AbortSignal;
  /** 單一請求逾時，預設 60 秒。 */
  timeoutMs?: number;
  /** 兩次請求開始之間的最小間隔，預設 400ms。 */
  throttleMs?: number;
  /** 同時在飛的請求數上限，預設 3。 */
  concurrency?: number;
  /** 重試次數（不含第一次），預設 3。 */
  retries?: number;
  /** 額外的 request header。 */
  headers?: Record<string, string>;
};

export type ArchiveFetchResult = {
  ok: boolean;
  status: number;
  text: string;
  contentType: string;
  /** 最終回應的網址（Wayback 常會 302 到鄰近時間戳的快照）。 */
  url: string;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * 全域請求閘門：限制同時在飛的請求數，並在請求「開始時間」之間保留最小間隔。
 *
 * 之所以不是完全序列化：三個網域的查詢彼此獨立，而單一 CDX 查詢可能要跑幾十秒，
 * 序列化會讓耗時直接三倍。但仍要限流，因為 web.archive.org 有 rate limit。
 */
let activeRequests = 0;
const pendingWaiters: (() => void)[] = [];
/** 下一個請求最早可以開始的時間點。 */
let nextSlotAt = 0;

function releaseSlot(): void {
  activeRequests -= 1;
  pendingWaiters.shift()?.();
}

async function acquireSlot(
  gapMs: number,
  concurrency: number,
  signal?: AbortSignal,
): Promise<void> {
  while (activeRequests >= concurrency) {
    await new Promise<void>((resolve) => pendingWaiters.push(resolve));
  }
  activeRequests += 1;
  try {
    const now = Date.now();
    const start = Math.max(now, nextSlotAt);
    nextSlotAt = start + gapMs;
    if (start > now) await sleep(start - now, signal);
  } catch (error) {
    releaseSlot();
    throw error;
  }
}

/** 在閘門保護下執行一個請求。 */
async function enqueue<T>(
  gapMs: number,
  concurrency: number,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  await acquireSlot(gapMs, concurrency, signal);
  try {
    return await task();
  } finally {
    releaseSlot();
  }
}

function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const list = signals.filter((s): s is AbortSignal => Boolean(s));
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return AbortSignal.any(list);
}

/** 429 與 5xx 才值得重試；其餘狀態碼直接回報給呼叫端。 */
function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * 對 web.archive.org 發出一個經過節流、逾時與指數退避重試保護的請求。
 * 回傳文字內容；HTTP 錯誤（如 404）以 `ok: false` 表示，不會 throw。
 * 只有連續重試都失敗（網路錯誤 / 逾時 / 持續 429）才會 throw。
 */
export async function fetchFromWayback(
  url: string,
  options: ArchiveFetchOptions = {},
): Promise<ArchiveFetchResult> {
  const {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    throttleMs = DEFAULT_THROTTLE_MS,
    concurrency = DEFAULT_CONCURRENCY,
    retries = DEFAULT_RETRIES,
    headers,
  } = options;

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');

    if (attempt > 0) {
      // 指數退避：1s、2s、4s（外加隨機抖動，避免多個工作同時重試）。
      const backoff = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      await sleep(backoff, signal);
    }

    try {
      const result = await enqueue(
        throttleMs,
        concurrency,
        async () => {
          const timeoutSignal = AbortSignal.timeout(timeoutMs);
          const res = await fetch(url, {
            signal: combineSignals([signal, timeoutSignal]),
            redirect: 'follow',
            headers: {
              'user-agent': USER_AGENT,
              ...headers,
            },
          });
          const text = await res.text();
          return {
            ok: res.ok,
            status: res.status,
            text,
            contentType: res.headers.get('content-type') ?? '',
            url: res.url || url,
          } satisfies ArchiveFetchResult;
        },
        signal,
      );

      if (isRetriableStatus(result.status) && attempt < retries) {
        lastError = new Error(`Wayback 回應 ${result.status}：${url}`);
        continue;
      }
      return result;
    } catch (error) {
      // 使用者主動取消不重試。
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }

  throw new Error(
    `Wayback 請求失敗（已重試 ${retries} 次）：${url}${
      lastError instanceof Error ? ` — ${lastError.message}` : ''
    }`,
  );
}

// ---------------------------------------------------------------------------
// 時間戳
// ---------------------------------------------------------------------------

const TIMESTAMP_RE = /^\d{14}$/;

/**
 * Twitter snowflake 的自訂 epoch（2010-11-04T01:42:54.657Z）。
 * snowflake id 的高位元就是毫秒時間戳：`(id >> 22) + EPOCH`。
 */
const SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;

/**
 * 最小的 snowflake id。比這個小的是 2010 年 11 月之前的舊式流水號 id，
 * 無法從 id 反推時間（換算後全都會塌到 epoch 當下那一秒）。
 */
const SNOWFLAKE_MIN_ID = 29_700_859_247n;

/**
 * 由推文 id 反推發布時間。id 早於 snowflake 制度時回 null。
 *
 * 已用兩則發布時間獨立確認過的推文驗證：
 * `1005269895100223489` → 2018-06-09T02:06:34Z、`2098753670213181836` → 2026-09-12T12:40:42Z。
 */
export function tweetIdToISO(tweetId: string): string | null {
  if (!/^\d{1,19}$/.test(tweetId)) return null;
  let id: bigint;
  try {
    id = BigInt(tweetId);
  } catch {
    return null;
  }
  if (id < SNOWFLAKE_MIN_ID) return null;
  const ms = Number((id >> 22n) + SNOWFLAKE_EPOCH_MS);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * 把 CDX 的 14 位數時間戳（`yyyyMMddHHmmss`，UTC）轉成 ISO 8601 字串。
 * @throws 當 `ts` 不是 14 位數字時。
 */
export function cdxTimestampToISO(ts: string): string {
  if (!TIMESTAMP_RE.test(ts)) {
    throw new Error(`不是合法的 CDX 時間戳：${ts}`);
  }
  const year = Number(ts.slice(0, 4));
  const month = Number(ts.slice(4, 6));
  const day = Number(ts.slice(6, 8));
  const hour = Number(ts.slice(8, 10));
  const minute = Number(ts.slice(10, 12));
  const second = Number(ts.slice(12, 14));
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
}

/** 判斷字串是否為 14 位數 CDX 時間戳。 */
export function isCdxTimestamp(ts: unknown): ts is string {
  return typeof ts === 'string' && TIMESTAMP_RE.test(ts);
}

// ---------------------------------------------------------------------------
// URL 正規化
// ---------------------------------------------------------------------------

/** 存檔 URL 常見的髒尾巴：換行、空白（含百分比編碼）與多餘斜線。 */
const TRAILING_JUNK_RE = /(?:%0[aAdD]|%09|%20|[\s/])+$/;

/** 換行（含百分比編碼形式）。存檔 URL 裡出現換行代表後面是複製推文時混進來的雜訊。 */
const NEWLINE_RE = /%0[aAdD]|[\r\n]/;

/** URL 內部混進來的空白字元（含百分比編碼形式）。 */
const INNER_WHITESPACE_RE = /%09|%20|\s+/g;

/**
 * 去掉存檔 URL 結尾的換行、空白與斜線。內部字元保持原樣，
 * 因為取回快照時必須把 originalUrl 原封不動帶回 Wayback。
 */
export function normalizeArchivedUrl(raw: string): string {
  let url = raw.trim();
  let prev = '';
  while (url !== prev) {
    prev = url;
    url = url.replace(TRAILING_JUNK_RE, '');
  }
  return url;
}

// 推文 id 最長 19 位（snowflake）。2007 年的早期推文 id 只有 1～4 位，因此下限放到 1；
// 上限卡在 19 位可以擋掉存檔 URL 裡混進來的 20 位以上假數字。
const STATUS_ID_RE = /\/status(?:es)?\/(\d{1,19})(?:[/?#]|$)/;
const USERNAME_RE = /^https?:\/\/[^/]+\/([A-Za-z0-9_]{1,20})\/status(?:es)?\//i;

/**
 * 把存檔 URL 清成適合正則比對的形式（只用於抽 id / 帳號，不會拿去請求 Wayback）。
 * 實測有大量 `.../status/<id>%0A<被一起複製進來的推文文字>` 這種髒資料，
 * 換行之後全部截掉才抽得出 id。
 */
function cleanUrlForParsing(url: string): string {
  const [head] = url.split(NEWLINE_RE);
  return (head ?? url).replace(INNER_WHITESPACE_RE, '');
}

/** 從存檔 URL 抽出推文的數字 id；抽不到回 null。 */
export function extractTweetId(url: string): string | null {
  const match = STATUS_ID_RE.exec(cleanUrlForParsing(url));
  return match ? match[1] : null;
}

/** 從存檔 URL 抽出帳號名稱；抽不到回 null。 */
export function extractUsername(url: string): string | null {
  const match = USERNAME_RE.exec(cleanUrlForParsing(url));
  return match ? match[1] : null;
}

function isStructuredMimetype(mimetype: string): boolean {
  return /json/i.test(mimetype);
}

// ---------------------------------------------------------------------------
// CDX 查詢
// ---------------------------------------------------------------------------

export type FetchArchivedTweetsOptions = {
  /** CDX `from` 參數（時間戳前綴，例如 `2018` 或 `20180101`）。 */
  from?: string;
  /** CDX `to` 參數（時間戳前綴）。 */
  to?: string;
  signal?: AbortSignal;
  /** 要查詢的網域，預設 twitter.com / x.com / mobile.twitter.com。 */
  domains?: readonly string[];
  /** 每批列數，預設 5000。 */
  pageLimit?: number;
  /** 每個網域最多翻幾頁，預設 12。 */
  maxPages?: number;
  /** 兩次請求開始之間的最小間隔（毫秒），預設 400。 */
  throttleMs?: number;
  /** 同時在飛的請求數上限，預設 3。 */
  concurrency?: number;
  /** 單一請求逾時（毫秒），預設 60000。 */
  timeoutMs?: number;
  /** 重試次數，預設 3。 */
  retries?: number;
  /** 整趟索引的時間預算（毫秒），預設 150000。超過就回傳已取得的部分。 */
  deadlineMs?: number;
};

/** 一次索引查詢的結果。 */
export type ArchivedIndex = {
  items: ArchivedTweetRef[];
  /** true 表示因時間預算或分頁上限而提前收工，結果不完整。 */
  partial: boolean;
  /** 給呼叫端顯示或記錄的說明（例如哪個網域被略過）。 */
  notes: string[];
};

/** 解析後的 CDX 一頁結果。 */
type CdxPage = {
  rows: string[][];
  resumeKey: string | null;
};

/**
 * 解析 CDX 的 JSON 輸出。
 * 格式為 `[[欄位名...], [值...], ..., [], ["<resumeKey>"]]`，
 * 其中最後兩列只有在 `showResumeKey=true` 且還有後續資料時才出現。
 */
export function parseCdxResponse(text: string): CdxPage {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { rows: [], resumeKey: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // CDX 偶爾會回傳 HTML 錯誤頁；視為沒有資料而不是致命錯誤。
    return { rows: [], resumeKey: null };
  }
  if (!Array.isArray(parsed)) return { rows: [], resumeKey: null };

  const all: string[][] = [];
  for (const row of parsed) {
    if (!Array.isArray(row)) continue;
    all.push(row.map((cell) => (typeof cell === 'string' ? cell : String(cell ?? ''))));
  }

  let resumeKey: string | null = null;
  // resumeKey 以「一列空陣列」為分隔，後面接一列只有 resumeKey 的陣列。
  for (let i = all.length - 2; i >= 0; i -= 1) {
    if (all[i].length === 0) {
      const candidate = all[i + 1]?.[0];
      if (typeof candidate === 'string' && candidate.length > 0) {
        resumeKey = candidate;
      }
      all.length = i;
      break;
    }
  }

  // 濾掉欄位名稱列與任何時間戳不合法的列。
  const rows = all.filter((row) => isCdxTimestamp(row[0]));
  return { rows, resumeKey };
}

function buildCdxUrl(
  domain: string,
  username: string,
  opts: { from?: string; to?: string; limit: number; resumeKey?: string | null },
): string {
  const params = new URLSearchParams({
    url: `${domain}/${username}/status/*`,
    output: 'json',
    fl: 'timestamp,original,mimetype,digest,length',
    collapse: 'urlkey',
    limit: String(opts.limit),
    showResumeKey: 'true',
  });
  if (opts.from) params.set('from', opts.from);
  if (opts.to) params.set('to', opts.to);
  if (opts.resumeKey) params.set('resumeKey', opts.resumeKey);
  return `${CDX_ENDPOINT}?${params.toString()}`;
}

/** CDX 一列展開後的候選快照。 */
type SnapshotCandidate = {
  tweetId: string;
  username: string;
  originalUrl: string;
  timestamp: string;
  mimetype: string;
  structured: boolean;
  /** URL 中夾雜換行等雜訊；同條件下優先挑乾淨的。 */
  dirty: boolean;
};

function toCandidate(row: string[], fallbackUsername: string): SnapshotCandidate | null {
  const timestamp = row[0];
  const rawUrl = row[1] ?? '';
  const mimetype = row[2] ?? '';
  if (!isCdxTimestamp(timestamp)) return null;

  const originalUrl = normalizeArchivedUrl(rawUrl);
  if (originalUrl.length === 0) return null;

  const tweetId = extractTweetId(originalUrl);
  if (!tweetId) return null; // 抽不到數字 id 的列直接丟棄

  return {
    tweetId,
    username: extractUsername(originalUrl) ?? fallbackUsername,
    originalUrl,
    timestamp,
    mimetype,
    structured: isStructuredMimetype(mimetype),
    dirty: NEWLINE_RE.test(originalUrl),
  };
}

/**
 * 決定同一則推文的多筆快照要保留哪一筆。
 * 優先保留結構化 JSON 存檔，其次是 URL 乾淨的，最後才比時間戳（保留最早的）。
 */
function isBetterCandidate(next: SnapshotCandidate, current: SnapshotCandidate): boolean {
  if (next.structured !== current.structured) return next.structured;
  if (next.dirty !== current.dirty) return current.dirty;
  return next.timestamp < current.timestamp;
}

/**
 * 查出某帳號在 Wayback 中所有的存檔推文參照（跨 twitter.com / x.com / mobile.twitter.com）。
 *
 * 三個網域並行查詢，各自用 resumeKey 分頁撈完，依 tweetId 去重後由新到舊排序。
 * 若撞到時間預算或分頁上限，會帶著已取得的資料回傳並把 `partial` 設為 true —
 * 寧可回報不完整，也不要讓呼叫端無限期等待。
 */
export async function fetchArchivedIndex(
  username: string,
  opts: FetchArchivedTweetsOptions = {},
): Promise<ArchivedIndex> {
  const handle = username.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,20}$/.test(handle)) {
    throw new Error(`不是合法的 Twitter 帳號名稱：${username}`);
  }

  const {
    from,
    to,
    signal,
    domains = TWITTER_DOMAINS,
    pageLimit = DEFAULT_PAGE_LIMIT,
    maxPages = DEFAULT_MAX_PAGES,
    throttleMs = DEFAULT_THROTTLE_MS,
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    deadlineMs = DEFAULT_DEADLINE_MS,
  } = opts;

  const merged = new Map<string, { ref: SnapshotCandidate; count: number }>();
  const notes: string[] = [];
  let partial = false;
  const deadline = Date.now() + deadlineMs;

  const absorb = (rows: string[][]): void => {
    for (const row of rows) {
      const candidate = toCandidate(row, handle);
      if (!candidate) continue;
      const existing = merged.get(candidate.tweetId);
      if (!existing) {
        merged.set(candidate.tweetId, { ref: candidate, count: 1 });
        continue;
      }
      existing.count += 1;
      if (isBetterCandidate(candidate, existing.ref)) {
        existing.ref = candidate;
      }
    }
  };

  const scanDomain = async (domain: string): Promise<void> => {
    let resumeKey: string | null = null;
    const seenResumeKeys = new Set<string>();

    for (let page = 0; page < maxPages; page += 1) {
      if (Date.now() >= deadline) {
        partial = true;
        notes.push(`${domain}：已達時間預算，僅取得部分資料`);
        return;
      }

      const url = buildCdxUrl(domain, handle, { from, to, limit: pageLimit, resumeKey });
      const res = await fetchFromWayback(url, {
        signal,
        timeoutMs,
        throttleMs,
        concurrency,
        retries,
      });

      if (!res.ok) {
        // 404 / 403 代表這個網域沒有資料，不是致命錯誤。
        notes.push(`${domain}：CDX 回應 ${res.status}，略過`);
        return;
      }

      const parsed = parseCdxResponse(res.text);
      absorb(parsed.rows);

      if (!parsed.resumeKey) return;
      if (seenResumeKeys.has(parsed.resumeKey)) {
        // resumeKey 重複代表服務端出了問題，中止以免無限迴圈。
        notes.push(`${domain}：resumeKey 重複，提前結束分頁`);
        partial = true;
        return;
      }
      seenResumeKeys.add(parsed.resumeKey);
      resumeKey = parsed.resumeKey;
    }

    partial = true;
    notes.push(`${domain}：已達分頁上限 ${maxPages}，結果可能不完整`);
  };

  // 單一網域失敗不應讓整趟索引失敗；其他網域的資料仍然有價值。
  const settled = await Promise.allSettled(domains.map((d) => scanDomain(d)));
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === 'rejected') {
      if (signal?.aborted) throw outcome.reason;
      partial = true;
      const reason =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      notes.push(`${domains[i]}：查詢失敗 — ${reason}`);
    }
  }

  // 三個網域全軍覆沒時，這不是「查無資料」，而是查詢失敗，要讓呼叫端知道。
  if (merged.size === 0 && settled.every((o) => o.status === 'rejected')) {
    throw new Error(`CDX 查詢全部失敗：${notes.join('；')}`);
  }

  const refs: ArchivedTweetRef[] = [];
  for (const { ref, count } of merged.values()) {
    // 發布時間的來源依可靠度排序：
    // 1. snowflake id 反推 — 精確，且適用於 2010-11 之後的所有推文。
    // 2. 結構化存檔的時間戳 — tweets crawl 會把快照時間設為發布時間。
    // 3. 抓取時間 — 只有 HTML 快照的舊推文才會落到這裡，這只是上界而非發布時間。
    const fromId = tweetIdToISO(ref.tweetId);
    const createdAt = fromId ?? cdxTimestampToISO(ref.timestamp);
    const createdAtSource: ArchivedTweetRef['createdAtSource'] = fromId
      ? 'snowflake'
      : ref.structured
        ? 'archive'
        : 'crawl';

    refs.push({
      tweetId: ref.tweetId,
      username: ref.username,
      originalUrl: ref.originalUrl,
      timestamp: ref.timestamp,
      createdAt,
      createdAtSource,
      mimetype: ref.mimetype,
      snapshotCount: count,
      structured: ref.structured,
      origin: 'archive',
    });
  }

  // 由新到舊，依真正的發布時間排序（不是抓取時間）。
  // 時間相同時用 tweetId 遞減當次要鍵，讓輸出穩定。
  refs.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    if (a.tweetId === b.tweetId) return 0;
    return a.tweetId.length !== b.tweetId.length
      ? b.tweetId.length - a.tweetId.length
      : a.tweetId < b.tweetId
        ? 1
        : -1;
  });

  return { items: refs, partial, notes };
}

/** 只要結果不要中繼資訊時的便利包裝。 */
export async function fetchArchivedTweets(
  username: string,
  opts: FetchArchivedTweetsOptions = {},
): Promise<ArchivedTweetRef[]> {
  const index = await fetchArchivedIndex(username, opts);
  return index.items;
}
