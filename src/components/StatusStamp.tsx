'use client';

import type { LivenessStatus } from '@/lib/types';

export type StampState = LivenessStatus | 'checking';

const COPY: Record<StampState, { label: string; className: string; title: string }> = {
  live: {
    label: '現存',
    className: 'stamp stamp-live',
    title: '已向 X 查證，這則推文目前仍然存在',
  },
  unavailable: {
    label: '已不可取得',
    className: 'stamp stamp-unavailable',
    // 這裡的措辭很重要：404 無法區分刪除／停權／改私密／地區封鎖，不可斷言「已刪除」。
    title:
      'X 上已查不到這則推文。可能是作者刪除、帳號被停權、帳號改為受保護，或在你所在地區被封鎖 — 這四種情況無法從外部區分。',
  },
  checking: {
    label: '查核中',
    className: 'stamp stamp-checking',
    title: '正在向 X 查證這則推文是否仍然存在',
  },
  unknown: {
    label: '未查核',
    className: 'stamp stamp-unknown',
    title: '尚未查核目前狀態',
  },
  error: {
    label: '查核失敗',
    className: 'stamp stamp-error',
    title: '查核時發生錯誤（可能是逾時或被限流），稍後會重試',
  },
};

export function StatusStamp({ state }: { state: StampState }) {
  const { label, className, title } = COPY[state];
  return (
    <span className={className} title={title} aria-label={`存活狀態：${label}`}>
      {state === 'checking' && (
        <span
          aria-hidden
          className="inline-block size-1.5 rounded-full bg-current motion-safe:animate-pulse"
        />
      )}
      {label}
    </span>
  );
}
