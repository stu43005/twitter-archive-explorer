'use client';

import { useState } from 'react';
import type { ApiError, ArchivedTweet, SubmitResponse, SubmitTrack } from '@/lib/types';

const STATUS_MARK: Record<SubmitTrack['status'], { mark: string; className: string }> = {
  ok: { mark: '完成', className: 'stamp stamp-live' },
  failed: { mark: '失敗', className: 'stamp stamp-unavailable' },
  skipped: { mark: '未執行', className: 'stamp stamp-unknown' },
};

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

/** 沒有回傳的欄位一律不顯示：syndication 根本不提供轉推等數字，顯示 0 會是謊話。 */
function Metric({ label, value }: { label: string; value?: number }) {
  if (value === undefined) return null;
  return (
    <span className="u-mono text-[0.6875rem] text-ink-3">
      {label} {numFmt.format(value)}
    </span>
  );
}

function TrackRow({ label, track, extra }: { label: string; track: SubmitTrack; extra?: string }) {
  const { mark, className } = STATUS_MARK[track.status];
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1.5 border-t border-rule py-2.5 first:border-t-0">
      <span className={className}>{mark}</span>
      <div className="min-w-[12rem] flex-1">
        <p className="u-caps">{label}</p>
        <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-ink-2">{track.detail}</p>
        {extra && <p className="u-mono mt-1 text-[0.6875rem] text-ink-3">{extra}</p>}
      </div>
    </li>
  );
}

/**
 * 保存成功後的內容預覽：讓使用者當場確認「存下來的東西是不是這則推文」。
 * 這份副本是本站自己擷取的，Internet Archive 上不會有對應快照。
 */
function CachePreview({ tweet }: { tweet: ArchivedTweet }) {
  const mediaTypes = [...new Set(tweet.media.map((m) => m.type))].join('、');

  return (
    <div className="mt-2.5 border-t border-rule pt-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="u-mono text-[0.8125rem] font-medium text-ink">
            @{tweet.author.username ?? '—'}
          </span>
          {tweet.author.name && (
            <span className="text-[0.8125rem] text-ink-3">{tweet.author.name}</span>
          )}
        </div>
        <span className="stamp stamp-unknown">本站保存</span>
      </div>

      <p className="u-mono mt-1 text-[0.6875rem] text-ink-3">
        <time dateTime={tweet.createdAt}>{formatUtc(tweet.createdAt)}</time>
      </p>

      <div className="record-text mt-2 text-[0.9375rem] leading-relaxed">
        <p className="whitespace-pre-wrap break-words">{tweet.text}</p>
        {tweet.media.length > 0 && (
          <p className="u-caps mt-2">
            含 {tweet.media.length} 個媒體附件（{mediaTypes}）
          </p>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
        <Metric label="♥" value={tweet.metrics.like} />
        <Metric label="↩" value={tweet.metrics.reply} />
        {tweet.capturedAt && (
          <span className="u-mono text-[0.6875rem] text-ink-3">
            擷取於 {formatUtc(tweet.capturedAt)}
          </span>
        )}
      </div>
    </div>
  );
}

export function SubmitArchive() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SubmitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (trimmed.length === 0 || busy) return;

    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = (await res.json()) as SubmitResponse | ApiError;
      if (!res.ok) throw new Error('error' in data ? data.error : `HTTP ${res.status}`);
      setResult(data as SubmitResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cached = result?.local.status === 'ok' ? result.local.tweet : undefined;

  return (
    <details className="mt-6 border border-rule bg-paper-2 px-4 py-3">
      <summary className="u-caps cursor-pointer list-none marker:content-none hover:text-ink">
        ＋ 送件：主動保存一則推文
      </summary>
      <p className="mt-3 max-w-xl text-[0.875rem] leading-relaxed text-ink-2">
        貼上推文網址，這裡會把內容擷取一份存進本站保存區。
        Internet Archive 目前對 X／Twitter 整站拒收存檔請求，因此只能保存本站自己的副本。
        <span className="text-ink-3">
          {' '}
          只能保存<em className="font-[family-name:var(--font-display)] italic">現在還在</em>
          的推文；已經消失的推文任何工具都救不回來。
        </span>
      </p>

      <form onSubmit={onSubmit} className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-3">
        <label className="min-w-[16rem] flex-1">
          <span className="u-caps block">推文網址</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://x.com/jack/status/20"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="slip-input mt-1 w-full pb-1 text-[0.9375rem]"
          />
        </label>
        <button type="submit" disabled={busy || url.trim().length === 0} className="btn-ink">
          {busy ? '送件中' : '送交保存'}
        </button>
      </form>

      {error !== null && (
        <p className="mt-4 border-l-2 border-stamp bg-[var(--stamp-soft)] px-3.5 py-2.5 text-[0.875rem] text-ink-2">
          <span className="u-caps text-stamp">送件失敗</span>
          <br />
          {error}
        </p>
      )}

      {result !== null && (
        <div className="record reveal mt-4 px-4 py-3 pl-5">
          <p className="u-mono text-[0.8125rem]">
            <span className="text-ink-3">@</span>
            {result.username}
            <span className="text-ink-3"> · </span>
            {result.tweetId}
          </p>
          <ul className="mt-2">
            <TrackRow label="本站保存" track={result.local} />
          </ul>

          {cached && <CachePreview tweet={cached} />}

          <p className="mt-2 border-t border-rule pt-2">
            <a
              href={result.canonicalUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="u-mono link-ink text-[0.6875rem] underline"
            >
              X 上的原文 ↗
            </a>
          </p>
        </div>
      )}
    </details>
  );
}
