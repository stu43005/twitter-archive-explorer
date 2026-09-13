'use client';

import { useCallback, useRef, useState } from 'react';
import { TweetRecord } from '@/components/TweetRecord';
import type { ApiError, ArchiveResponse, ArchivedTweetRef } from '@/lib/types';

const PAGE_SIZE = 50;

type Query = { username: string; from: string; to: string };

export default function Home() {
  const [input, setInput] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [query, setQuery] = useState<Query | null>(null);
  const [items, setItems] = useState<ArchivedTweetRef[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [cached, setCached] = useState(false);
  const [partial, setPartial] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (q: Query, offset: number) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        user: q.username,
        offset: String(offset),
        limit: String(PAGE_SIZE),
      });
      // 日期輸入是 yyyy-mm-dd，CDX 要的是 yyyyMMdd。
      if (q.from) params.set('from', q.from.replaceAll('-', ''));
      if (q.to) params.set('to', q.to.replaceAll('-', ''));

      const res = await fetch(`/api/archive?${params}`, { signal: controller.signal });
      const data = (await res.json()) as ArchiveResponse | ApiError;
      if (!res.ok) throw new Error('error' in data ? data.error : `HTTP ${res.status}`);

      const page = data as ArchiveResponse;
      setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
      setTotal(page.total);
      setNextOffset(page.nextOffset);
      setCached(page.cached);
      setPartial(page.partial);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const username = input.trim().replace(/^@/, '');
    if (!username) return;
    const q: Query = { username, from, to };
    setQuery(q);
    setItems([]);
    setTotal(0);
    setNextOffset(null);
    void load(q, 0);
  };

  const firstLoad = loading && items.length === 0;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-24 pt-10 sm:px-6">
      {/* ---------- 報頭 ---------- */}
      <header>
        <p className="u-caps">Internet Archive · 推文調閱</p>
        <h1 className="mt-1.5 font-[family-name:var(--font-display)] text-[2.75rem] leading-[0.95] tracking-tight sm:text-6xl">
          推文存檔閱覽室
        </h1>
        <p className="mt-3 max-w-xl text-[0.9375rem] leading-relaxed text-ink-2">
          查詢任一 Twitter／X 帳號在 Internet Archive 中被存檔過的推文，
          並逐則查核它<em className="font-[family-name:var(--font-display)] italic">此刻</em>
          是否仍存在於 X 上。
        </p>
        <div className="u-rule-double mt-5" />
      </header>

      {/* ---------- 調閱單 ---------- */}
      <form onSubmit={onSubmit} className="mt-6">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-4">
          <label className="min-w-[13rem] flex-1">
            <span className="u-caps block">帳號</span>
            <span className="mt-1 flex items-baseline gap-1">
              <span className="u-mono text-lg text-ink-3">@</span>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="jack"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="slip-input w-full pb-1 text-lg"
              />
            </span>
          </label>

          <label>
            <span className="u-caps block">起始日</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="slip-input mt-1 pb-1 text-[0.8125rem]"
            />
          </label>

          <label>
            <span className="u-caps block">截止日</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="slip-input mt-1 pb-1 text-[0.8125rem]"
            />
          </label>

          <button type="submit" disabled={loading || !input.trim()} className="btn-ink">
            {loading ? '調閱中' : '調閱'}
          </button>
        </div>
      </form>

      {/* ---------- 首次查詢的說明 ---------- */}
      {query === null && (
        <section className="mt-10 border-t border-rule pt-5">
          <p className="u-caps">關於這份索引</p>
          <ul className="mt-2.5 space-y-1.5 text-[0.875rem] leading-relaxed text-ink-2">
            <li>
              資料來自 Internet Archive 的推文存檔，多數以結構化 JSON 保存，
              因此能還原原文、時間與互動數，而非只有網頁截圖。
            </li>
            <li>
              首次查詢某個帳號要向 Internet Archive 完整索引一次，
              推文多的帳號可能需要數十秒；之後會走本地快取。
            </li>
            <li>
              「已不可取得」代表現在於 X 上查不到該則推文。
              這無法區分作者刪除、帳號停權、改為受保護或地區封鎖 — 請勿逕自解讀為刪除。
            </li>
          </ul>
        </section>
      )}

      {/* ---------- 錯誤 ---------- */}
      {error !== null && (
        <p className="mt-6 border-l-2 border-stamp bg-[var(--stamp-soft)] px-3.5 py-2.5 text-[0.875rem] text-ink-2">
          <span className="u-caps text-stamp">調閱失敗</span>
          <br />
          {error}
        </p>
      )}

      {/* ---------- 結果 ---------- */}
      {query !== null && !firstLoad && error === null && (
        <section className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule pb-2">
            <p className="u-mono text-[0.8125rem]">
              <span className="text-ink-3">@</span>
              {query.username}
              <span className="text-ink-3"> — 存檔推文 </span>
              <span className="text-base font-medium">{total.toLocaleString('zh-TW')}</span>
              <span className="text-ink-3"> 則</span>
            </p>
            <p className="u-caps">{cached ? '本地快取' : '即時取自 Internet Archive'}</p>
          </div>

          {partial && (
            <p className="mt-3 border-l-2 border-stamp bg-[var(--stamp-soft)] px-3.5 py-2.5 text-[0.8125rem] leading-relaxed text-ink-2">
              <span className="u-caps text-stamp">索引不完整</span>
              <br />
              這個帳號的存檔量太大，索引在時間上限內沒有跑完，以上並非全部。
              這份不完整的結果不會被快取 — 重新查詢一次通常能補到更多。
            </p>
          )}

          {total === 0 ? (
            <p className="mt-6 text-[0.9375rem] text-ink-2">
              在 Internet Archive 中找不到這個帳號的推文存檔。
              可能是帳號名稱有誤，或這個帳號從未被存檔。
            </p>
          ) : (
            <div className="mt-4 flex flex-col gap-2.5">
              {items.map((it, i) => (
                <TweetRecord key={it.tweetId} tweetRef={it} index={i} />
              ))}
            </div>
          )}

          {nextOffset !== null && (
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                disabled={loading}
                onClick={() => query && void load(query, nextOffset)}
                className="btn-ink"
              >
                {loading ? '調閱中' : `再調閱 ${PAGE_SIZE} 則`}
              </button>
            </div>
          )}
        </section>
      )}

      {/* ---------- 首次載入 ---------- */}
      {firstLoad && (
        <p className="mt-10 text-center">
          <span className="u-caps">正在向 Internet Archive 建立索引…</span>
          <br />
          <span className="mt-1.5 inline-block text-[0.8125rem] text-ink-3">
            推文量大的帳號首次查詢可能需要數十秒
          </span>
        </p>
      )}
    </main>
  );
}
