import { fetchArchivedIndex } from '@/lib/cdx';
import { getCachedCdxIndex, getLocalCaptures, setCachedCdxIndex } from '@/lib/cache';
import type { ArchiveResponse, ApiError, ArchivedTweet, ArchivedTweetRef } from '@/lib/types';

// node:sqlite 與 CDX 節流都需要 Node runtime，不能跑在 edge。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Twitter 帳號格式：1-15 字元的英數與底線。 */
const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
/** CDX 的日期參數：yyyyMMdd 到 yyyyMMddHHmmss。 */
const CDX_DATE_RE = /^\d{8}(\d{6})?$/;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function bad(message: string, status = 400): Response {
  return Response.json({ error: message } satisfies ApiError, { status });
}

/** 把 ISO 8601 轉成可字典序比較的 14 位數 `yyyyMMddHHmmss`（UTC）。 */
function isoToCdxTimestamp(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** 把一則本站保存的推文包成索引用的參照。 */
function toLocalRef(tweet: ArchivedTweet, fallbackUsername: string): ArchivedTweetRef {
  const username = tweet.author.username ?? fallbackUsername;
  return {
    tweetId: tweet.tweetId,
    username,
    originalUrl: `https://x.com/${username}/status/${tweet.tweetId}`,
    // 這裡沒有 Wayback 快照，時間戳純粹由發布時間推導，只為了排序與日期篩選。
    timestamp: isoToCdxTimestamp(tweet.createdAt) ?? '00000000000000',
    createdAt: tweet.createdAt,
    // 取自擷取到的推文內容本身，精確。
    createdAtSource: 'archive',
    mimetype: 'application/json',
    snapshotCount: 0,
    structured: true,
    origin: 'local',
  };
}

/**
 * 把本站保存的推文併進 Internet Archive 的索引。
 *
 * 這一步刻意放在讀取快取**之後**：索引本身快取 6 小時，若在建索引時才合併，
 * 剛送件保存的推文要等快取過期才看得到。
 * 同一則推文兩邊都有時保留存檔那筆 —— 它帶有真正的快照可供查證。
 */
function mergeLocalCaptures(
  archived: readonly ArchivedTweetRef[],
  username: string,
): ArchivedTweetRef[] {
  const locals = getLocalCaptures(username);
  if (locals.length === 0) return [...archived];

  const byId = new Map(locals.map((t) => [t.tweetId, t]));
  const merged: ArchivedTweetRef[] = [];
  const seen = new Set<string>();

  for (const ref of archived) {
    seen.add(ref.tweetId);
    const local = byId.get(ref.tweetId);
    // 兩邊都有時保留存檔那筆（它有真正的快照可查證），但若存檔只能提供「抓取時間」，
    // 就改用本站擷取到的發布時間 —— 那是推文自己帶的，一定正確。
    // 例：jack/status/20 早於 snowflake 制度，索引推出 2008-09-19，實際是 2006-03-21。
    if (local && ref.createdAtSource === 'crawl') {
      merged.push({ ...ref, createdAt: local.createdAt, createdAtSource: 'archive' });
    } else {
      merged.push(ref);
    }
  }

  for (const tweet of locals) {
    if (seen.has(tweet.tweetId)) continue;
    merged.push(toLocalRef(tweet, username));
  }

  // 一律重排：除了新增的項目，上面也可能修正了既有項目的發布時間。
  merged.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.tweetId === b.tweetId ? 0 : a.tweetId < b.tweetId ? 1 : -1;
  });
  return merged;
}

function parseIntParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  const rawUser = url.searchParams.get('user')?.trim().replace(/^@/, '') ?? '';
  if (!USERNAME_RE.test(rawUser)) {
    return bad('user 參數無效：必須是 1-15 個英數字或底線組成的 Twitter 帳號');
  }
  const username = rawUser.toLowerCase();

  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  if (from !== undefined && !CDX_DATE_RE.test(from)) {
    return bad('from 參數格式錯誤：需為 yyyyMMdd 或 yyyyMMddHHmmss');
  }
  if (to !== undefined && !CDX_DATE_RE.test(to)) {
    return bad('to 參數格式錯誤：需為 yyyyMMdd 或 yyyyMMddHHmmss');
  }

  const offset = parseIntParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = parseIntParam(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);

  // 完整索引一律整份快取，之後的分頁與日期篩選都在本地做，避免重複打 CDX。
  let items: ArchivedTweetRef[];
  let cached = true;
  let partial = false;

  const hit = getCachedCdxIndex(username);
  if (hit) {
    items = hit.items;
  } else {
    cached = false;
    try {
      const index = await fetchArchivedIndex(username, { signal: request.signal });
      items = index.items;
      partial = index.partial;
      if (index.notes.length > 0) {
        console.warn(`[archive] @${username}：${index.notes.join('；')}`);
      }
    } catch (err) {
      if (request.signal.aborted) return bad('請求已取消', 499);
      const reason = err instanceof Error ? err.message : String(err);
      return bad(`查詢 Internet Archive 失敗：${reason}`, 502);
    }
    // 不完整的索引不寫入快取，否則殘缺結果會被鎖住整個 TTL；下次請求可重新嘗試補齊。
    if (!partial) setCachedCdxIndex(username, items);
  }

  // 併入本站保存的推文。放在這裡（而不是建索引時）才能讓剛送件的推文立刻出現，
  // 不必等索引快取過期。
  const withLocal = mergeLocalCaptures(items, username);

  // 日期篩選在記憶體做，且依「發布時間」而非「抓取時間」——
  // 只有 HTML 快照的舊推文，其 timestamp 是抓取時間，拿來篩會篩錯。
  let filtered: ArchivedTweetRef[] = withLocal;
  if (from !== undefined || to !== undefined) {
    const lo = from?.padEnd(14, '0');
    const hi = to?.padEnd(14, '9');
    filtered = filtered.filter((it) => {
      const key = isoToCdxTimestamp(it.createdAt);
      if (key === null) return true; // 時間不明的不主動排除
      if (lo !== undefined && key < lo) return false;
      if (hi !== undefined && key > hi) return false;
      return true;
    });
  }

  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + limit < filtered.length ? offset + limit : null;

  const body: ArchiveResponse = {
    username,
    total: filtered.length,
    items: page,
    nextOffset,
    cached,
    partial,
  };
  return Response.json(body);
}
