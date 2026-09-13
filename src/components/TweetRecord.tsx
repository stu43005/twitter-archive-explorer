'use client';

import { useEffect, useRef, useState } from 'react';
import { requestLiveness, requestTweetContent } from '@/lib/batcher';
import { StatusStamp, type StampState } from '@/components/StatusStamp';
import type { ArchivedTweet, ArchivedTweetRef, LivenessStatus } from '@/lib/types';

const dateFmt = new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  hour12: false,
});

function formatUtc(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${dateFmt.format(d)} UTC`;
}

const numFmt = new Intl.NumberFormat('zh-TW', { notation: 'compact' });

function Metric({ label, value }: { label: string; value?: number }) {
  if (value === undefined) return null;
  return (
    <span className="u-mono text-[0.6875rem] text-ink-3">
      {label} {numFmt.format(value)}
    </span>
  );
}

export function TweetRecord({ tweetRef, index }: { tweetRef: ArchivedTweetRef; index: number }) {
  const nodeRef = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);
  const [tweet, setTweet] = useState<ArchivedTweet | null>(null);
  const [contentFailed, setContentFailed] = useState(false);
  const [liveness, setLiveness] = useState<LivenessStatus>('unknown');

  // 進入視野才動作：存檔內容與存活查核都很花費外部配額，不預先抓。
  useEffect(() => {
    const node = nodeRef.current;
    if (node === null || seen) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: '320px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);

  useEffect(() => {
    if (!seen) return;
    let alive = true;

    // 只有 HTML 快照（structured=false）時一樣嘗試解析，但解析失敗是預期內的結果。
    void requestTweetContent(tweetRef).then((t) => {
      if (!alive) return;
      if (t) setTweet(t);
      else setContentFailed(true);
    });

    void requestLiveness(tweetRef.tweetId).then((r) => {
      if (alive) setLiveness(r.status);
    });

    return () => {
      alive = false;
    };
  }, [seen, tweetRef]);

  // 「查核中」是推導出來的：已進入視野但結果還沒回來。不必為它多存一份 state。
  const status: StampState = seen && liveness === 'unknown' ? 'checking' : liveness;
  const voided = status === 'unavailable';

  // 存檔內容裡的 created_at 是第一手資料，優先於索引推導出來的時間。
  const displayedAt = tweet?.createdAt ?? tweetRef.createdAt;
  const approximateDate = tweet === null && tweetRef.createdAtSource === 'crawl';
  const liveUrl = `https://x.com/${tweetRef.username}/status/${tweetRef.tweetId}`;
  const snapshotUrl =
    tweet?.snapshotUrl ??
    `https://web.archive.org/web/${tweetRef.timestamp}/${tweetRef.originalUrl}`;

  return (
    <article
      ref={nodeRef}
      className={`record reveal px-4 py-3.5 pl-5 sm:px-5 sm:pl-6 ${
        voided ? 'record-void' : status === 'live' ? 'record-live' : ''
      }`}
      style={{ animationDelay: `${Math.min(index, 12) * 28}ms` }}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="u-mono text-[0.8125rem] font-medium text-ink">
            @{tweet?.author.username ?? tweetRef.username}
          </span>
          {tweet?.author.name && (
            <span className="text-[0.8125rem] text-ink-3">{tweet.author.name}</span>
          )}
        </div>
        <StatusStamp state={status} />
      </header>

      <p className="u-mono mt-1 text-[0.6875rem] text-ink-3">
        {/* 存檔內容裡的時間最權威；沒有時才用索引推導出來的。 */}
        <time dateTime={displayedAt}>{formatUtc(displayedAt)}</time>
        {approximateDate && (
          <span
            className="ml-1.5"
            title="這則推文早於 Twitter 的 snowflake id 制度，且沒有結構化存檔，因此無從得知確切發布時間。顯示的是 Internet Archive 的抓取時間，只能當作發布時間的上界。"
          >
            （抓取時間，非發布時間）
          </span>
        )}
      </p>

      <div className="record-text mt-2.5 text-[0.9375rem] leading-relaxed">
        {tweet ? (
          <>
            {tweet.isRetweet && tweet.retweetOf && (
              <p className="u-caps mb-1.5">
                轉推自 @{tweet.retweetOf.username ?? '—'}
              </p>
            )}
            {tweet.inReplyToUsername && (
              <p className="u-caps mb-1.5">回覆 @{tweet.inReplyToUsername}</p>
            )}
            <p className="whitespace-pre-wrap break-words">{tweet.text}</p>
            {tweet.media.length > 0 && (
              <p className="u-caps mt-2">
                含 {tweet.media.length} 個媒體附件（
                {[...new Set(tweet.media.map((m) => m.type))].join('、')}）
              </p>
            )}
          </>
        ) : contentFailed ? (
          <p className="text-[0.8125rem] italic text-ink-3">
            這筆存檔只有頁面快照、沒有可解析的推文內容
            {tweetRef.structured ? '' : '（2022 年後的快照多半是空殼頁面）'}。
            仍可開啟快照原件查看。
          </p>
        ) : seen ? (
          <p className="u-caps">調閱中…</p>
        ) : (
          <p className="u-caps text-transparent select-none" aria-hidden>
            佔位
          </p>
        )}
      </div>

      <footer className="mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-rule pt-2.5">
        <a
          href={snapshotUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="u-mono link-ink text-[0.6875rem] underline"
        >
          存檔原件 ↗
        </a>
        <a
          href={liveUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="u-mono link-ink text-[0.6875rem] underline"
        >
          X 上的原文 ↗
        </a>
        <span className="u-mono text-[0.6875rem] text-ink-3">
          快照 {tweetRef.snapshotCount} 份
        </span>
        {tweet && (
          <>
            <Metric label="♥" value={tweet.metrics.like} />
            <Metric label="↻" value={tweet.metrics.retweet} />
            <Metric label="↩" value={tweet.metrics.reply} />
          </>
        )}
        <span className="u-mono ml-auto text-[0.625rem] text-ink-3 opacity-70">
          {tweetRef.tweetId}
        </span>
      </footer>
    </article>
  );
}
