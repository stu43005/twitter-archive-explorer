/**
 * 推文存活偵測。
 *
 * 只能在 Node runtime（後端）執行：syndication 端點的
 * `access-control-allow-origin` 寫死成 `https://platform.twitter.com`，
 * 瀏覽器無法直接呼叫。
 *
 * 語意上的重要限制：任何 404 都只代表「現在取不到」，
 * 無法區分已刪除／帳號停權／改為受保護／地區封鎖，
 * 所以最多只標成 `unavailable`，不會斷言推文被刪除。
 */

import type { LivenessResult, LivenessStatus } from '@/lib/types';

/** 一般瀏覽器 UA；不帶的話 syndication 偶爾會直接擋掉。 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 單一請求的預設逾時（毫秒）。 */
export const DEFAULT_LIVENESS_TIMEOUT_MS = 15_000;
/** 批次檢查的預設並發上限。 */
export const DEFAULT_LIVENESS_CONCURRENCY = 3;
/** 批次檢查中，兩個請求之間的預設最小間隔（毫秒）。 */
export const DEFAULT_LIVENESS_INTERVAL_MS = 250;

const SYNDICATION_ENDPOINT = 'https://cdn.syndication.twimg.com/tweet-result';
const OEMBED_ENDPOINT = 'https://publish.twitter.com/oembed';

export type LivenessCheckOptions = {
  /** 存檔中的帳號名稱；有給才能用 oEmbed 對 404 做覆核。 */
  username?: string;
  /** 外部取消訊號（例如 request.signal）。 */
  signal?: AbortSignal;
  /** 單一請求逾時，預設 15 秒。 */
  timeoutMs?: number;
};

export type LivenessBatchOptions = Omit<LivenessCheckOptions, 'username'> & {
  /** 並發上限，預設 3。 */
  concurrency?: number;
  /** 兩個請求之間的最小間隔（毫秒），預設 250。 */
  intervalMs?: number;
  /** 整批共用的帳號名稱（所有 id 都屬於同一個帳號時使用）。 */
  username?: string;
  /** 個別指定 tweetId → username，優先於 `username`。 */
  usernames?: Readonly<Record<string, string | undefined>>;
};

/**
 * 由推文 id 推導 syndication token。
 * 公式取自 vercel/react-tweet；例：id "20" → "6dq1a2xwd93"。
 */
export function buildSyndicationToken(tweetId: string): string {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
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

/** 把 fetch 拋出的例外轉成可讀的中文原因。 */
function describeFetchError(err: unknown, external?: AbortSignal): string {
  if (external?.aborted) return '請求已被呼叫端取消';
  if (err instanceof DOMException && err.name === 'TimeoutError') return '請求逾時';
  if (err instanceof Error && err.name === 'AbortError') return '請求已中止';
  if (err instanceof Error) return `網路錯誤：${err.message}`;
  return `網路錯誤：${String(err)}`;
}

function result(
  tweetId: string,
  status: LivenessStatus,
  detail?: string,
): LivenessResult {
  return detail === undefined
    ? { tweetId, status, checkedAt: new Date().toISOString() }
    : { tweetId, status, checkedAt: new Date().toISOString(), detail };
}

/** syndication 探測的三種結果。 */
type Probe =
  | { kind: 'live' }
  | { kind: 'missing'; detail: string }
  | { kind: 'error'; detail: string };

/** 呼叫 syndication 端點。這是主要判斷依據。 */
async function probeSyndication(
  tweetId: string,
  opts: LivenessCheckOptions,
): Promise<Probe> {
  const token = buildSyndicationToken(tweetId);
  const url = `${SYNDICATION_ENDPOINT}?id=${encodeURIComponent(tweetId)}&lang=en&token=${encodeURIComponent(token)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: makeSignal(opts.timeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS, opts.signal),
      cache: 'no-store',
    });
  } catch (err) {
    return { kind: 'error', detail: `syndication ${describeFetchError(err, opts.signal)}` };
  }

  if (res.status === 404) {
    await drain(res);
    return { kind: 'missing', detail: 'syndication 回 404' };
  }
  if (res.status === 429) {
    await drain(res);
    return { kind: 'error', detail: 'syndication 被限流（429）' };
  }
  if (res.status >= 500) {
    await drain(res);
    return { kind: 'error', detail: `syndication 伺服器錯誤（${res.status}）` };
  }
  if (!res.ok) {
    await drain(res);
    return { kind: 'error', detail: `syndication 非預期狀態碼（${res.status}）` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'error', detail: 'syndication 回 200 但 body 不是合法 JSON' };
  }

  if (typeof body !== 'object' || body === null) {
    return { kind: 'error', detail: 'syndication 回 200 但 body 結構不符預期' };
  }

  const obj = body as Record<string, unknown>;
  if (obj.__typename === 'Tweet') return { kind: 'live' };
  // 受保護／被停權的帳號有時會回 200 + tombstone，同樣只能算「取不到」。
  if ('tombstone' in obj) return { kind: 'missing', detail: 'syndication 回 tombstone' };

  return { kind: 'error', detail: 'syndication 回 200 但缺少 __typename=Tweet' };
}

/** 呼叫 oEmbed 端點；只在 syndication 判定 missing 時用來覆核。 */
async function probeOEmbed(
  tweetId: string,
  username: string,
  opts: LivenessCheckOptions,
): Promise<Probe> {
  const target = `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(tweetId)}`;
  const url = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(target)}&omit_script=1`;

  let res: Response;
  try {
    // publish.twitter.com 會 301 導到 publish.x.com，必須跟隨轉址。
    res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      redirect: 'follow',
      signal: makeSignal(opts.timeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS, opts.signal),
      cache: 'no-store',
    });
  } catch (err) {
    return { kind: 'error', detail: `oEmbed ${describeFetchError(err, opts.signal)}` };
  }

  if (res.status === 404) {
    await drain(res);
    return { kind: 'missing', detail: 'oEmbed 回 404' };
  }
  if (res.status === 429) {
    await drain(res);
    return { kind: 'error', detail: 'oEmbed 被限流（429）' };
  }
  if (!res.ok) {
    await drain(res);
    return { kind: 'error', detail: `oEmbed 非預期狀態碼（${res.status}）` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'error', detail: 'oEmbed 回 200 但 body 不是合法 JSON' };
  }
  if (typeof body === 'object' && body !== null && typeof (body as { html?: unknown }).html === 'string') {
    return { kind: 'live' };
  }
  return { kind: 'error', detail: 'oEmbed 回 200 但 body 結構不符預期' };
}

/**
 * 檢查單一推文是否還存在。
 *
 * 流程：
 * 1. 打 syndication；`__typename === 'Tweet'` → `live`。
 * 2. syndication 判定取不到時，若有 username 就用 oEmbed 覆核；
 *    oEmbed 仍拿得到 → `live`，兩邊都取不到 → `unavailable`。
 * 3. 逾時／429／5xx／網路錯誤一律 `error`，絕不當成 `unavailable`。
 */
export async function checkTweetLiveness(
  tweetId: string,
  opts: LivenessCheckOptions = {},
): Promise<LivenessResult> {
  if (!/^\d+$/.test(tweetId)) {
    return result(tweetId, 'error', '推文 id 不是純數字');
  }

  const primary = await probeSyndication(tweetId, opts);
  if (primary.kind === 'live') return result(tweetId, 'live', 'syndication 確認存在');
  if (primary.kind === 'error') return result(tweetId, 'error', primary.detail);

  const username = opts.username?.trim();
  if (!username) {
    // 沒有帳號名稱就無法覆核，只能以 syndication 為準。
    return result(
      tweetId,
      'unavailable',
      `${primary.detail}（無帳號名稱可用 oEmbed 覆核；無法區分刪除／停權／私密／地區封鎖）`,
    );
  }

  const secondary = await probeOEmbed(tweetId, username, opts);
  if (secondary.kind === 'live') {
    return result(tweetId, 'live', `${primary.detail}，但 oEmbed 仍可取得`);
  }
  if (secondary.kind === 'error') {
    // 覆核本身失敗時不敢下結論，交給呼叫端重試。
    return result(tweetId, 'error', `${primary.detail}；覆核失敗：${secondary.detail}`);
  }
  return result(
    tweetId,
    'unavailable',
    `${primary.detail} 且 ${secondary.detail}（無法區分刪除／停權／私密／地區封鎖）`,
  );
}

/** 可被 AbortSignal 提前喚醒的 sleep。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onDone = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onDone);
      resolve();
    };
    const timer = setTimeout(onDone, ms);
    signal?.addEventListener('abort', onDone, { once: true });
  });
}

/**
 * 批次檢查，帶並發上限與請求間隔節流。
 * 單筆失敗只會讓那一筆變成 `error`，不會讓整批失敗；
 * 回傳結果與輸入 ids 同順序、同長度。
 */
export async function checkTweetLivenessBatch(
  ids: readonly string[],
  opts: LivenessBatchOptions = {},
): Promise<LivenessResult[]> {
  const results = new Array<LivenessResult>(ids.length);
  if (ids.length === 0) return results;

  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_LIVENESS_CONCURRENCY);
  const intervalMs = Math.max(0, opts.intervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS);

  // 全域節流時間軸：不論同時有幾個 worker，兩次送出至少間隔 intervalMs。
  let nextSlot = 0;
  const reserveSlot = (): number => {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + intervalMs;
    return at - now;
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= ids.length) return;
      const tweetId = ids[index];

      await sleep(reserveSlot(), opts.signal);

      if (opts.signal?.aborted) {
        results[index] = result(tweetId, 'error', '請求已被呼叫端取消');
        continue;
      }

      const username = opts.usernames?.[tweetId] ?? opts.username;
      try {
        results[index] = await checkTweetLiveness(tweetId, {
          username,
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
        });
      } catch (err) {
        // checkTweetLiveness 理論上不會拋，這裡只是最後一道保險。
        results[index] = result(tweetId, 'error', describeFetchError(err, opts.signal));
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()),
  );

  return results;
}
