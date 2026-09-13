/**
 * 解析使用者手動輸入的推文網址。
 *
 * 一律用 `new URL()` 比對主機名，不要用字串或正則比對：
 * `https://evil.com/x.com/a/status/1` 這種路徑偽裝只有解析後才擋得掉，
 * 而這個網址會被伺服器端拿去抓取與提交。
 */

const ALLOWED_HOSTS = new Set([
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'x.com',
  'www.x.com',
  'mobile.x.com',
]);

/** `/<username>/status/<id>`，也接受舊式的 `statuses`，後面可再接 `/photo/1` 之類。 */
const STATUS_PATH_RE = /^\/([A-Za-z0-9_]{1,20})\/status(?:es)?\/(\d{1,19})(?:\/|$)/;

export type ParsedTweetUrl = {
  username: string;
  tweetId: string;
  /** 正規化後的網址，用於提交與顯示。 */
  canonicalUrl: string;
};

/**
 * 解析成功回傳各欄位，失敗回 null。
 * 允許省略 scheme（`x.com/jack/status/20`），會自動補上 https。
 */
export function parseTweetUrl(raw: string): ParsedTweetUrl | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // 沒有 scheme 時補 https，否則 new URL 會失敗。
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;

  const match = STATUS_PATH_RE.exec(url.pathname);
  if (!match) return null;

  const [, username, tweetId] = match;
  // 去掉開頭的 0，避免同一則推文出現兩種 id 寫法。
  if (/^0/.test(tweetId)) return null;

  return {
    username,
    tweetId,
    canonicalUrl: `https://x.com/${username}/status/${tweetId}`,
  };
}
