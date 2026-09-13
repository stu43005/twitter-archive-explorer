'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { clearSearchHistory, forgetHandle, useSearchHistory } from '@/lib/searchHistory';

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** 從歷史選了一個帳號，直接發動查詢。 */
  onPick: (handle: string) => void;
};

export function HandleInput({ value, onChange, onPick }: Props) {
  const history = useSearchHistory();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const needle = value.trim().replace(/^@+/, '').toLowerCase();
  const matches =
    needle.length === 0
      ? history
      : history.filter((h) => h.toLowerCase().includes(needle));

  const canOpen = matches.length > 0;
  const expanded = open && canOpen;

  // 點到元件外面就收起。用 pointerdown 而非 click，才能早於 input 的 blur 發生。
  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [expanded]);

  const choose = (handle: string) => {
    setOpen(false);
    setActive(-1);
    onChange(handle);
    onPick(handle);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      setActive(-1);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!canOpen) return;
      event.preventDefault();
      if (!expanded) {
        setOpen(true);
        setActive(event.key === 'ArrowDown' ? 0 : matches.length - 1);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((prev) => (prev + step + matches.length) % matches.length);
      return;
    }
    // 只有真的選了某一列才攔截 Enter，否則交給表單正常送出。
    if (event.key === 'Enter' && expanded && active >= 0 && active < matches.length) {
      event.preventDefault();
      choose(matches[active]);
      return;
    }
    if (event.key === 'Tab') setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative min-w-[13rem] flex-1">
      <label>
        <span className="u-caps block">帳號</span>
        <span className="mt-1 flex items-baseline gap-1">
          <span className="u-mono text-lg text-ink-3">@</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="jack"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              expanded && active >= 0 ? `${listId}-${active}` : undefined
            }
            className="slip-input w-full pb-1 text-lg"
          />
        </span>
      </label>

      {expanded && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 border border-rule bg-paper-2 shadow-[0_6px_20px_-10px_rgba(0,0,0,0.5)]">
          <p className="u-caps border-b border-rule px-2.5 py-1.5">查詢紀錄</p>
          <ul id={listId} role="listbox" className="max-h-64 overflow-y-auto py-0.5">
            {matches.map((handle, i) => (
              <li
                key={handle}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onPointerEnter={() => setActive(i)}
                onClick={() => choose(handle)}
                className={`flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 ${
                  i === active ? 'bg-paper-3' : ''
                }`}
              >
                <span className="u-mono truncate text-[0.875rem]">
                  <span className="text-ink-3">@</span>
                  {handle}
                </span>
                <button
                  type="button"
                  aria-label={`從查詢紀錄移除 @${handle}`}
                  title={`從查詢紀錄移除 @${handle}`}
                  onClick={(e) => {
                    // 不要連帶觸發整列的「選取」。
                    e.stopPropagation();
                    forgetHandle(handle);
                    setActive(-1);
                    inputRef.current?.focus();
                  }}
                  className="u-mono shrink-0 px-1 text-[0.875rem] leading-none text-ink-3 hover:text-stamp"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-rule px-2.5 py-1.5 text-right">
            <button
              type="button"
              onClick={() => {
                clearSearchHistory();
                setOpen(false);
                setActive(-1);
                inputRef.current?.focus();
              }}
              className="u-caps hover:text-stamp"
            >
              全部清除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
