import { fetchArchivedIndex } from '@/lib/cdx';
import { getCachedCdxIndex, setCachedCdxIndex } from '@/lib/cache';
import type { ArchiveResponse, ApiError, ArchivedTweetRef } from '@/lib/types';

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

  // 日期篩選在記憶體做，且依「發布時間」而非「抓取時間」——
  // 只有 HTML 快照的舊推文，其 timestamp 是抓取時間，拿來篩會篩錯。
  let filtered = items;
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
