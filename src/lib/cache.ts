/**
 * SQLite 快取層（Node 24 內建的 `node:sqlite`，不額外裝套件）。
 *
 * 三張表：
 * - `cdx_index`     一個帳號一列，整份 CDX 索引以 JSON 存放
 * - `tweet_content` 一則推文一列，存解析完成的存檔內容
 * - `liveness`      一則推文一列，存最近一次存活檢查結果
 *
 * 只能在 Node runtime 使用（API route 需宣告 `runtime = 'nodejs'`）。
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ArchivedTweet, ArchivedTweetRef, LivenessResult, LivenessStatus } from '@/lib/types';

// ---------- node:sqlite 的最小型別描述 ----------
// @types/node 20 尚未收錄 node:sqlite，這裡自行描述用得到的部分，
// 並改用 process.getBuiltinModule 取得模組（避免 import 期就型別錯誤）。

type SqliteParam = null | number | bigint | string | Uint8Array;
type SqliteRow = Record<string, unknown>;

interface StatementSyncLike {
  run(...params: SqliteParam[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqliteParam[]): SqliteRow | undefined;
  all(...params: SqliteParam[]): SqliteRow[];
}

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (location: string) => DatabaseSyncLike;
}

interface ProcessWithBuiltinModule {
  getBuiltinModule(id: string): unknown;
}

function loadSqlite(): NodeSqliteModule {
  const getter = process as unknown as Partial<ProcessWithBuiltinModule>;
  if (typeof getter.getBuiltinModule !== 'function') {
    throw new Error('目前的 Node 版本不支援 process.getBuiltinModule，無法載入 node:sqlite（需 Node 22.3+）');
  }
  const mod = getter.getBuiltinModule('node:sqlite');
  if (typeof mod !== 'object' || mod === null || !('DatabaseSync' in mod)) {
    throw new Error('無法載入 node:sqlite；請確認 Node 版本（建議 22+）');
  }
  return mod as NodeSqliteModule;
}

// ---------- 設定 ----------

/**
 * schema 版本；改動表結構或 payload 形狀時 +1，舊表會被重建（快取本來就可拋棄）。
 * v2：ArchivedTweetRef 新增 createdAtSource，且 createdAt 改為推文發布時間而非抓取時間。
 */
const SCHEMA_VERSION = 2;

const DEFAULT_DB_PATH = './data/cache.db';

const HOUR_MS = 60 * 60 * 1000;

/** 讀取正整數環境變數；格式不對就用預設值。 */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'infinite' || normalized === 'never') return Number.POSITIVE_INFINITY;
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** CDX 索引 TTL，預設 6 小時（`ARCHIVE_CDX_TTL_MS` 可覆寫）。 */
export const CDX_INDEX_TTL_MS = envMs('ARCHIVE_CDX_TTL_MS', 6 * HOUR_MS);
/** 推文內容 TTL，預設永久：存檔內容不會再變（`ARCHIVE_TWEET_TTL_MS` 可覆寫）。 */
export const TWEET_CONTENT_TTL_MS = envMs('ARCHIVE_TWEET_TTL_MS', Number.POSITIVE_INFINITY);
/** liveness TTL，預設 24 小時（`ARCHIVE_LIVENESS_TTL_MS` 可覆寫）。 */
export const LIVENESS_TTL_MS = envMs('ARCHIVE_LIVENESS_TTL_MS', 24 * HOUR_MS);

/** 取得實際使用的 DB 檔路徑（絕對路徑）。 */
export function getCacheDbPath(): string {
  const raw = process.env.ARCHIVE_DB_PATH?.trim();
  // 允許用 ':memory:' 跑純記憶體模式（測試用），此時不做路徑解析。
  if (raw === ':memory:') return raw;
  return resolve(raw && raw !== '' ? raw : DEFAULT_DB_PATH);
}

// ---------- 單例連線 ----------
// Next.js dev 模式會 hot reload 模組，掛在 globalThis 上避免重複開檔／重複建表。

const GLOBAL_DB_KEY = '__twitterArchiveExplorerCacheDb__';

type GlobalWithCacheDb = typeof globalThis & {
  __twitterArchiveExplorerCacheDb__?: { db: DatabaseSyncLike; path: string };
};

function createDb(path: string): DatabaseSyncLike {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function readUserVersion(db: DatabaseSyncLike): number {
  const row = db.prepare('PRAGMA user_version').get();
  const v = row?.user_version;
  return typeof v === 'number' ? v : Number(v ?? 0);
}

function migrate(db: DatabaseSyncLike): void {
  const current = readUserVersion(db);
  if (current === SCHEMA_VERSION) return;

  if (current !== 0) {
    // 快取內容可以隨時重建，版本不符就直接砍掉重來，不寫複雜的資料搬遷。
    console.warn(`[cache] schema 版本由 ${current} 變更為 ${SCHEMA_VERSION}，重建快取表`);
    db.exec('DROP TABLE IF EXISTS cdx_index');
    db.exec('DROP TABLE IF EXISTS tweet_content');
    db.exec('DROP TABLE IF EXISTS liveness');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS cdx_index (
      username   TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      total      INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tweet_content (
      tweet_id   TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS liveness (
      tweet_id   TEXT PRIMARY KEY,
      status     TEXT NOT NULL,
      detail     TEXT,
      checked_at INTEGER NOT NULL
    );
  `);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** lazy 取得單例連線；DB 路徑變更（測試中改環境變數）時會重開。 */
function getDb(): DatabaseSyncLike {
  const g = globalThis as GlobalWithCacheDb;
  const path = getCacheDbPath();
  const existing = g[GLOBAL_DB_KEY];
  if (existing && existing.path === path) return existing.db;
  if (existing) {
    try {
      existing.db.close();
    } catch {
      // 忽略：關閉舊連線失敗不影響開新的。
    }
  }
  const db = createDb(path);
  g[GLOBAL_DB_KEY] = { db, path };
  return db;
}

/** 關閉單例連線（主要給測試與腳本收尾用）。 */
export function closeCache(): void {
  const g = globalThis as GlobalWithCacheDb;
  const existing = g[GLOBAL_DB_KEY];
  if (!existing) return;
  try {
    existing.db.close();
  } catch {
    // 忽略。
  }
  delete g[GLOBAL_DB_KEY];
}

// ---------- 共用工具 ----------

/** SQLite 預設參數上限是 999，分批查詢避免超過。 */
const MAX_PARAMS = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isFresh(fetchedAt: number, ttlMs: number): boolean {
  if (!Number.isFinite(ttlMs)) return true;
  return Date.now() - fetchedAt < ttlMs;
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return Number(v ?? 0);
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

/** 在 transaction 中執行批次寫入；失敗會 rollback。 */
function inTransaction(db: DatabaseSyncLike, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 忽略：rollback 失敗時仍要把原始錯誤丟出去。
    }
    throw err;
  }
}

function normalizeUsername(username: string): string {
  return username.trim().replace(/^@/, '').toLowerCase();
}

// ---------- cdx_index ----------

export type CachedCdxIndex = {
  items: ArchivedTweetRef[];
  total: number;
  /** 寫入時間（epoch 毫秒）。 */
  fetchedAt: number;
};

/** 讀取某帳號的完整 CDX 索引；不存在或已過 TTL 都回 null。 */
export function getCachedCdxIndex(username: string): CachedCdxIndex | null {
  const key = normalizeUsername(username);
  if (key === '') return null;

  const row = getDb()
    .prepare('SELECT payload, total, fetched_at FROM cdx_index WHERE username = ?')
    .get(key);
  if (!row) return null;

  const fetchedAt = asNumber(row.fetched_at);
  if (!isFresh(fetchedAt, CDX_INDEX_TTL_MS)) return null;

  let items: ArchivedTweetRef[];
  try {
    const parsed: unknown = JSON.parse(asString(row.payload));
    if (!Array.isArray(parsed)) return null;
    items = parsed as ArchivedTweetRef[];
  } catch {
    // payload 壞掉就當 miss，讓上層重抓。
    return null;
  }

  return { items, total: asNumber(row.total), fetchedAt };
}

/** 寫入（覆寫）某帳號的完整 CDX 索引。 */
export function setCachedCdxIndex(username: string, items: readonly ArchivedTweetRef[]): void {
  const key = normalizeUsername(username);
  if (key === '') return;

  getDb()
    .prepare(
      `INSERT INTO cdx_index (username, payload, total, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         payload = excluded.payload,
         total = excluded.total,
         fetched_at = excluded.fetched_at`,
    )
    .run(key, JSON.stringify(items), items.length, Date.now());
}

// ---------- tweet_content ----------

/** 依 id 批次讀取已快取的推文內容；miss 的 id 不會出現在 Map 中。 */
export function getCachedTweets(ids: readonly string[]): Map<string, ArchivedTweet> {
  const found = new Map<string, ArchivedTweet>();
  if (ids.length === 0) return found;

  const db = getDb();
  for (const group of chunk(ids, MAX_PARAMS)) {
    const placeholders = group.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT tweet_id, payload, fetched_at FROM tweet_content WHERE tweet_id IN (${placeholders})`,
      )
      .all(...group);

    for (const row of rows) {
      if (!isFresh(asNumber(row.fetched_at), TWEET_CONTENT_TTL_MS)) continue;
      try {
        const parsed: unknown = JSON.parse(asString(row.payload));
        if (typeof parsed !== 'object' || parsed === null) continue;
        found.set(asString(row.tweet_id), parsed as ArchivedTweet);
      } catch {
        // 壞掉的 payload 當作 miss。
      }
    }
  }
  return found;
}

/** 批次寫入推文內容（同一個 transaction）。 */
export function setCachedTweets(tweets: readonly ArchivedTweet[]): void {
  if (tweets.length === 0) return;

  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO tweet_content (tweet_id, payload, fetched_at)
     VALUES (?, ?, ?)
     ON CONFLICT(tweet_id) DO UPDATE SET
       payload = excluded.payload,
       fetched_at = excluded.fetched_at`,
  );
  const now = Date.now();
  inTransaction(db, () => {
    for (const tweet of tweets) {
      if (!tweet.tweetId) continue;
      stmt.run(tweet.tweetId, JSON.stringify(tweet), now);
    }
  });
}

// ---------- liveness ----------

const LIVENESS_STATUSES: readonly LivenessStatus[] = ['live', 'unavailable', 'unknown', 'error'];

function toLivenessStatus(v: unknown): LivenessStatus | null {
  const s = asString(v);
  return (LIVENESS_STATUSES as readonly string[]).includes(s) ? (s as LivenessStatus) : null;
}

/** 依 id 批次讀取存活檢查結果；miss 或過期的 id 不會出現在 Map 中。 */
export function getCachedLiveness(ids: readonly string[]): Map<string, LivenessResult> {
  const found = new Map<string, LivenessResult>();
  if (ids.length === 0) return found;

  const db = getDb();
  for (const group of chunk(ids, MAX_PARAMS)) {
    const placeholders = group.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT tweet_id, status, detail, checked_at FROM liveness WHERE tweet_id IN (${placeholders})`,
      )
      .all(...group);

    for (const row of rows) {
      const checkedAt = asNumber(row.checked_at);
      if (!isFresh(checkedAt, LIVENESS_TTL_MS)) continue;
      const status = toLivenessStatus(row.status);
      if (status === null) continue;

      const detail = typeof row.detail === 'string' ? row.detail : undefined;
      const tweetId = asString(row.tweet_id);
      found.set(
        tweetId,
        detail === undefined
          ? { tweetId, status, checkedAt: new Date(checkedAt).toISOString() }
          : { tweetId, status, checkedAt: new Date(checkedAt).toISOString(), detail },
      );
    }
  }
  return found;
}

/**
 * 批次寫入存活檢查結果。
 * `error` 與 `unknown` 一律略過：那不是結論，寫進去會讓暫時性失敗被 TTL 鎖住。
 */
export function setCachedLiveness(results: readonly LivenessResult[]): void {
  const writable = results.filter((r) => r.status === 'live' || r.status === 'unavailable');
  if (writable.length === 0) return;

  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO liveness (tweet_id, status, detail, checked_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(tweet_id) DO UPDATE SET
       status = excluded.status,
       detail = excluded.detail,
       checked_at = excluded.checked_at`,
  );
  inTransaction(db, () => {
    for (const r of writable) {
      const checkedAt = Date.parse(r.checkedAt);
      stmt.run(
        r.tweetId,
        r.status,
        r.detail ?? null,
        Number.isFinite(checkedAt) ? checkedAt : Date.now(),
      );
    }
  });
}

// ---------- 清除 ----------

export type CacheScope = 'all' | 'cdx' | 'tweets' | 'liveness';

/** 清空快取；不給 scope 就全清。 */
export function clearCache(scope: CacheScope = 'all'): void {
  const db = getDb();
  inTransaction(db, () => {
    if (scope === 'all' || scope === 'cdx') db.exec('DELETE FROM cdx_index');
    if (scope === 'all' || scope === 'tweets') db.exec('DELETE FROM tweet_content');
    if (scope === 'all' || scope === 'liveness') db.exec('DELETE FROM liveness');
  });
}
