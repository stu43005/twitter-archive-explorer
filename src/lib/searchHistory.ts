'use client';

import { useSyncExternalStore } from 'react';

/**
 * 查詢過的帳號歷史。
 *
 * 這純粹是單一使用者在單一瀏覽器上的便利功能，沒有跨裝置或跨人共享的需求，
 * 所以存在 localStorage 就好，不需要後端。
 *
 * 以 useSyncExternalStore 對接：localStorage 是 React 之外的狀態來源，
 * 用它才能同時處理「伺服器端渲染時沒有 localStorage」與「其他分頁改動了資料」。
 */

const STORAGE_KEY = 'twitter-archive-explorer:recent-handles';
const MAX_ENTRIES = 10;
const EMPTY: readonly string[] = Object.freeze([]);

/** 快取快照。必須維持參考穩定，否則 useSyncExternalStore 會無限重繪。 */
let cache: readonly string[] | null = null;
const listeners = new Set<() => void>();

/** 去掉前後空白與開頭的 @。 */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').trim();
}

function sameHandle(a: string, b: string): boolean {
  // Twitter 帳號不分大小寫，但顯示時保留使用者輸入的寫法。
  return a.toLowerCase() === b.toLowerCase();
}

function readStorage(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;

    const out: string[] = [];
    for (const value of parsed) {
      if (typeof value !== 'string') continue;
      const handle = normalizeHandle(value);
      if (handle.length === 0) continue;
      if (out.some((h) => sameHandle(h, handle))) continue;
      out.push(handle);
      if (out.length >= MAX_ENTRIES) break;
    }
    return out.length > 0 ? out : EMPTY;
  } catch {
    // 私密視窗、site data 被封鎖、或存了壞掉的 JSON：當作沒有歷史。
    return EMPTY;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function writeStorage(next: readonly string[]): void {
  cache = next;
  try {
    if (next.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 寫不進去（配額滿或被封鎖）也不影響本次瀏覽，記憶體中的快照仍然正確。
  }
  notify();
}

function onStorageEvent(event: StorageEvent): void {
  // key 為 null 表示整個 storage 被清空。
  if (event.key !== null && event.key !== STORAGE_KEY) return;
  cache = null;
  notify();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (listeners.size === 1) window.addEventListener('storage', onStorageEvent);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) window.removeEventListener('storage', onStorageEvent);
  };
}

function getSnapshot(): readonly string[] {
  if (cache === null) cache = readStorage();
  return cache;
}

/** 伺服器端沒有 localStorage；回空陣列讓 hydration 從一致的狀態開始。 */
function getServerSnapshot(): readonly string[] {
  return EMPTY;
}

export function useSearchHistory(): readonly string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 把帳號移到歷史最前面（已存在就上移，不重複）。 */
export function rememberHandle(raw: string): void {
  const handle = normalizeHandle(raw);
  if (handle.length === 0) return;
  const current = getSnapshot();
  writeStorage(
    [handle, ...current.filter((h) => !sameHandle(h, handle))].slice(0, MAX_ENTRIES),
  );
}

export function forgetHandle(raw: string): void {
  const handle = normalizeHandle(raw);
  const current = getSnapshot();
  const next = current.filter((h) => !sameHandle(h, handle));
  if (next.length !== current.length) writeStorage(next);
}

export function clearSearchHistory(): void {
  if (getSnapshot().length > 0) writeStorage(EMPTY);
}
