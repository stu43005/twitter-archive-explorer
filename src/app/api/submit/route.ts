import { parseTweetUrl } from '@/lib/tweetUrl';
import { captureTweetFromLive } from '@/lib/liveCapture';
import { saveLocalCapture, setCachedLiveness, setCachedTweets } from '@/lib/cache';
import type { ApiError, ArchivedTweet, SubmitResponse, SubmitTrack } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function bad(message: string, status = 400): Response {
  return Response.json({ error: message } satisfies ApiError, { status });
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 即時擷取推文內容並保存。
 *
 * 這裡曾經還有一條「提交給 Internet Archive」的線，已移除：
 * Internet Archive 對 X／Twitter 整站拒收 Save Page Now 請求（回 `error:blocked-url`），
 * 詳見 README 與 AGENTS.md。
 */
async function capture(
  username: string,
  tweetId: string,
  signal: AbortSignal,
): Promise<SubmitTrack & { tweet?: ArchivedTweet }> {
  let tweet: ArchivedTweet | null;
  try {
    tweet = await captureTweetFromLive(tweetId, { signal });
  } catch (err) {
    return { status: 'failed', detail: `擷取推文內容時發生錯誤：${reason(err)}` };
  }

  if (tweet === null) {
    // 這裡不能說「已刪除」：404 無法區分刪除／停權／改私密／地區封鎖。
    return {
      status: 'failed',
      detail:
        'X 上取不到這則推文，因此無法擷取內容。可能是已被刪除、帳號被停權、帳號改為受保護，或在本伺服器所在地區被封鎖。',
    };
  }

  // 兩個地方都要寫：
  // - local_captures 是永久保存區，會出現在該帳號的時間軸上，且不隨快取清除消失
  // - tweet_content 是以 id 為鍵的內容快取，讓既有的讀取路徑直接命中
  saveLocalCapture(username, tweet);
  setCachedTweets([tweet]);
  // 既然剛剛才成功抓到內容，就順手把存活狀態記為 live，省下之後一次查核。
  setCachedLiveness([
    { tweetId, status: 'live', checkedAt: new Date().toISOString(), detail: '保存時確認仍存在' },
  ]);

  return {
    status: 'ok',
    detail: '已擷取推文內容並保存。這則推文現在也會出現在該帳號的查詢結果中。',
    tweet,
  };
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return bad('request body 不是合法的 JSON');
  }

  const rawUrl = (payload as { url?: unknown })?.url;
  if (typeof rawUrl !== 'string') return bad('缺少 url 欄位');
  if (rawUrl.length > 2048) return bad('網址過長');

  const parsed = parseTweetUrl(rawUrl);
  if (parsed === null) {
    return bad('無法辨識的推文網址。需要類似 https://x.com/jack/status/20 的格式。');
  }

  const local = await capture(parsed.username, parsed.tweetId, request.signal);

  const body: SubmitResponse = {
    tweetId: parsed.tweetId,
    username: parsed.username,
    canonicalUrl: parsed.canonicalUrl,
    local,
  };
  return Response.json(body);
}
