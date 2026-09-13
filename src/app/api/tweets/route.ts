import { fetchArchivedTweetContent } from '@/lib/snapshot';
import { getCachedTweets, setCachedTweets } from '@/lib/cache';
import type { ApiError, ArchivedTweet, TweetsRequest, TweetsResponse } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 一次最多取回幾則，避免單一請求把 Wayback 打爆。 */
const MAX_REFS = 50;
/** 同時對 web.archive.org 發出的請求數上限。 */
const CONCURRENCY = 4;

function bad(message: string, status = 400): Response {
  return Response.json({ error: message } satisfies ApiError, { status });
}

type Ref = TweetsRequest['refs'][number];

/**
 * 允許抓取的主機。用主機名白名單而非字串比對：
 * `https://evil.com/twitter.com/...` 這種路徑偽裝會被 URL 解析還原成 evil.com 而擋下。
 */
const ALLOWED_HOSTS = new Set([
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'x.com',
  'www.x.com',
  'mobile.x.com',
]);

function isAllowedTweetUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // 早期的 Wayback 存檔 URL 會帶明示連接埠（`http://twitter.com:80/...`）；
  // hostname 已排除 port，所以不必特別處理。
  return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
}

function isRef(v: unknown): v is Ref {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.tweetId === 'string' &&
    /^\d{1,19}$/.test(r.tweetId) &&
    typeof r.timestamp === 'string' &&
    /^\d{14}$/.test(r.timestamp) &&
    typeof r.originalUrl === 'string' &&
    isAllowedTweetUrl(r.originalUrl)
  );
}

/** 以固定並發數跑完所有工作，回傳與輸入等長的結果陣列。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return bad('request body 不是合法的 JSON');
  }

  const refsRaw = (payload as { refs?: unknown })?.refs;
  if (!Array.isArray(refsRaw)) return bad('缺少 refs 陣列');
  if (refsRaw.length === 0) {
    return Response.json({ tweets: [], failed: [] } satisfies TweetsResponse);
  }
  if (refsRaw.length > MAX_REFS) return bad(`一次最多 ${MAX_REFS} 筆`);

  const failed: TweetsResponse['failed'] = [];

  // 單一筆格式不對不該讓整批失敗：存檔索引中本來就混有各種歷史 URL 樣態，
  // 一則舊推文不應該毒死整頁。不合格的記進 failed，其餘照常處理。
  const refs: Ref[] = [];
  for (const r of refsRaw) {
    if (isRef(r)) {
      refs.push(r);
      continue;
    }
    const id = (r as { tweetId?: unknown })?.tweetId;
    failed.push({
      tweetId: typeof id === 'string' ? id : '(未知)',
      reason: '參照格式不正確，已略過',
    });
  }
  if (refs.length === 0) {
    return Response.json({ tweets: [], failed } satisfies TweetsResponse);
  }

  // 去重，避免同一則推文重複抓取。
  const byId = new Map<string, Ref>();
  for (const r of refs) byId.set(r.tweetId, r);

  const cachedMap = getCachedTweets([...byId.keys()]);
  const missing = [...byId.values()].filter((r) => !cachedMap.has(r.tweetId));

  const fetched: ArchivedTweet[] = [];

  const outcomes = await mapWithConcurrency(missing, CONCURRENCY, async (ref) => {
    try {
      const tweet = await fetchArchivedTweetContent(ref);
      return { ref, tweet, reason: null as string | null };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ref, tweet: null, reason };
    }
  });

  for (const o of outcomes) {
    if (o.tweet) {
      fetched.push(o.tweet);
    } else {
      failed.push({
        tweetId: o.ref.tweetId,
        reason: o.reason ?? '快照中找不到可解析的推文內容',
      });
    }
  }

  if (fetched.length > 0) setCachedTweets(fetched);

  // 依照請求順序回傳，讓前端不必再排序。
  const all = new Map<string, ArchivedTweet>(cachedMap);
  for (const t of fetched) all.set(t.tweetId, t);
  const tweets = refs.map((r) => all.get(r.tweetId)).filter((t): t is ArchivedTweet => t !== undefined);

  return Response.json({ tweets, failed } satisfies TweetsResponse);
}
