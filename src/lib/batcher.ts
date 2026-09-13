'use client';

import type {
  ArchivedTweet,
  ArchivedTweetRef,
  LivenessResult,
  LivenessResponse,
  TweetsResponse,
} from '@/lib/types';

/**
 * 前端批次佇列。
 *
 * 每則推文的卡片各自在進入視野時發出請求，若逐一打 API 會產生大量小請求，
 * 而 Wayback 與 syndication 都有 rate limit。這裡把短時間內的請求合併成一批送出。
 */

type Resolver<T> = (value: T) => void;

const CONTENT_BATCH_MAX = 50;
const LIVENESS_BATCH_MAX = 25;
const DEBOUNCE_MS = 160;

// ---------- 存檔內容 ----------

type ContentRef = Pick<ArchivedTweetRef, 'tweetId' | 'timestamp' | 'originalUrl'>;

const contentQueue = new Map<string, { ref: ContentRef; resolvers: Resolver<ArchivedTweet | null>[] }>();
const contentInflight = new Map<string, Promise<ArchivedTweet | null>>();
let contentTimer: ReturnType<typeof setTimeout> | null = null;

async function flushContent(): Promise<void> {
  contentTimer = null;
  const batch = [...contentQueue.values()].slice(0, CONTENT_BATCH_MAX);
  for (const entry of batch) contentQueue.delete(entry.ref.tweetId);
  if (batch.length === 0) return;
  // 佇列若仍有剩餘，排下一批。
  if (contentQueue.size > 0) scheduleContentFlush();

  const settle = (id: string, value: ArchivedTweet | null) => {
    const entry = batch.find((b) => b.ref.tweetId === id);
    entry?.resolvers.forEach((r) => r(value));
    contentInflight.delete(id);
  };

  try {
    const res = await fetch('/api/tweets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refs: batch.map((b) => b.ref) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as TweetsResponse;
    const byId = new Map(data.tweets.map((t) => [t.tweetId, t]));
    for (const b of batch) settle(b.ref.tweetId, byId.get(b.ref.tweetId) ?? null);
  } catch {
    for (const b of batch) settle(b.ref.tweetId, null);
  }
}

function scheduleContentFlush(): void {
  if (contentTimer !== null) return;
  contentTimer = setTimeout(() => void flushContent(), DEBOUNCE_MS);
}

/** 取回單則存檔推文內容；相同 id 的併發呼叫會共用同一個請求。 */
export function requestTweetContent(ref: ContentRef): Promise<ArchivedTweet | null> {
  const existing = contentInflight.get(ref.tweetId);
  if (existing) return existing;

  const promise = new Promise<ArchivedTweet | null>((resolve) => {
    const queued = contentQueue.get(ref.tweetId);
    if (queued) {
      queued.resolvers.push(resolve);
    } else {
      contentQueue.set(ref.tweetId, { ref, resolvers: [resolve] });
    }
    scheduleContentFlush();
  });

  contentInflight.set(ref.tweetId, promise);
  return promise;
}

// ---------- 存活狀態 ----------

const livenessQueue = new Map<string, Resolver<LivenessResult>[]>();
const livenessInflight = new Map<string, Promise<LivenessResult>>();
let livenessTimer: ReturnType<typeof setTimeout> | null = null;

async function flushLiveness(): Promise<void> {
  livenessTimer = null;
  const ids = [...livenessQueue.keys()].slice(0, LIVENESS_BATCH_MAX);
  const resolvers = new Map<string, Resolver<LivenessResult>[]>();
  for (const id of ids) {
    resolvers.set(id, livenessQueue.get(id) ?? []);
    livenessQueue.delete(id);
  }
  if (ids.length === 0) return;
  if (livenessQueue.size > 0) scheduleLivenessFlush();

  const settle = (id: string, value: LivenessResult) => {
    resolvers.get(id)?.forEach((r) => r(value));
    livenessInflight.delete(id);
  };

  try {
    const res = await fetch('/api/liveness', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as LivenessResponse;
    const byId = new Map(data.results.map((r) => [r.tweetId, r]));
    for (const id of ids) {
      settle(
        id,
        byId.get(id) ?? { tweetId: id, status: 'error', checkedAt: new Date().toISOString() },
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    for (const id of ids) {
      settle(id, { tweetId: id, status: 'error', checkedAt: new Date().toISOString(), detail });
    }
  }
}

function scheduleLivenessFlush(): void {
  if (livenessTimer !== null) return;
  livenessTimer = setTimeout(() => void flushLiveness(), DEBOUNCE_MS);
}

/** 查詢單則推文目前是否仍存在；相同 id 的併發呼叫會共用同一個請求。 */
export function requestLiveness(tweetId: string): Promise<LivenessResult> {
  const existing = livenessInflight.get(tweetId);
  if (existing) return existing;

  const promise = new Promise<LivenessResult>((resolve) => {
    const queued = livenessQueue.get(tweetId);
    if (queued) {
      queued.push(resolve);
    } else {
      livenessQueue.set(tweetId, [resolve]);
    }
    scheduleLivenessFlush();
  });

  livenessInflight.set(tweetId, promise);
  return promise;
}
