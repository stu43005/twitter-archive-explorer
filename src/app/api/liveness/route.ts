import { checkTweetLivenessBatch } from '@/lib/liveness';
import { getCachedLiveness, setCachedLiveness } from '@/lib/cache';
import type { ApiError, LivenessResponse, LivenessResult } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 一次最多檢查幾則。刻意壓低，因為 syndication 與 oEmbed 都有 rate limit。 */
const MAX_IDS = 25;

function bad(message: string, status = 400): Response {
  return Response.json({ error: message } satisfies ApiError, { status });
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return bad('request body 不是合法的 JSON');
  }

  const idsRaw = (payload as { ids?: unknown })?.ids;
  if (!Array.isArray(idsRaw)) return bad('缺少 ids 陣列');
  if (idsRaw.length > MAX_IDS) return bad(`一次最多 ${MAX_IDS} 筆`);

  // 格式不對的 id 略過即可，不讓整批失敗。
  const ids: string[] = [];
  for (const v of idsRaw) {
    if (typeof v !== 'string' || !/^\d{1,19}$/.test(v)) continue;
    if (!ids.includes(v)) ids.push(v);
  }
  if (ids.length === 0) {
    return Response.json({ results: [] } satisfies LivenessResponse);
  }

  const cachedMap = getCachedLiveness(ids);
  const missing = ids.filter((id) => !cachedMap.has(id));

  let fresh: LivenessResult[] = [];
  if (missing.length > 0) {
    try {
      fresh = await checkTweetLivenessBatch(missing, { signal: request.signal });
    } catch (err) {
      if (request.signal.aborted) return bad('請求已取消', 499);
      const reason = err instanceof Error ? err.message : String(err);
      return bad(`存活檢查失敗：${reason}`, 502);
    }
    // 快取層會自行略過 status 為 error 的結果，避免暫時性失敗被鎖住。
    setCachedLiveness(fresh);
  }

  const all = new Map<string, LivenessResult>(cachedMap);
  for (const r of fresh) all.set(r.tweetId, r);

  const results = ids.map(
    (id): LivenessResult =>
      all.get(id) ?? { tweetId: id, status: 'unknown', checkedAt: new Date().toISOString() },
  );

  return Response.json({ results } satisfies LivenessResponse);
}
