/**
 * 共用型別契約。lib / API routes / UI 一律以此檔為準。
 */

/** CDX 索引中的一筆存檔推文參照（尚未取回內容）。 */
export type ArchivedTweetRef = {
  tweetId: string;
  /** 存檔 URL 中出現的帳號名稱（可能與現在的帳號名不同）。 */
  username: string;
  /** 原始推文 URL，取回快照時需要原封不動帶入。 */
  originalUrl: string;
  /**
   * CDX 的 14 位數時間戳。
   * 在結構化 JSON 的 tweets crawl 中此值等於推文發布時間；
   * 一般 HTML 快照則是「抓取時間」，兩者不可混為一談。
   */
  timestamp: string;
  /** 推文發布時間（ISO 8601）。其可靠度見 `createdAtSource`。 */
  createdAt: string;
  /**
   * `createdAt` 是怎麼來的：
   * snowflake = 由推文 id 反推，精確；
   * archive   = 取自結構化存檔的快照時間戳，精確；
   * crawl     = 只有 HTML 快照且 id 早於 snowflake 制度，這其實是「抓取時間」，
   *             只能當成發布時間的上界，不是真正的發布時間。
   */
  createdAtSource: 'snowflake' | 'archive' | 'crawl';
  mimetype: string;
  /** 同一則推文在 Wayback 中的快照數量。 */
  snapshotCount: number;
  /** 是否為結構化 JSON 存檔（可完整解析）；false 表示只有 HTML 快照。 */
  structured: boolean;
};

export type TweetMedia = {
  type: string;
  url?: string;
  previewUrl?: string;
  expandedUrl?: string;
};

export type TweetAuthor = {
  id?: string;
  username?: string;
  name?: string;
  profileImageUrl?: string;
  verified?: boolean;
};

export type TweetMetrics = {
  like?: number;
  retweet?: number;
  reply?: number;
  quote?: number;
  bookmark?: number;
  impression?: number;
};

/** 從存檔快照解析出的完整推文內容。 */
export type ArchivedTweet = {
  tweetId: string;
  text: string;
  createdAt: string;
  lang?: string;
  author: TweetAuthor;
  metrics: TweetMetrics;
  media: TweetMedia[];
  inReplyToStatusId?: string | null;
  inReplyToUsername?: string | null;
  isRetweet: boolean;
  retweetOf?: { tweetId: string; username?: string; text?: string } | null;
  quotedStatusId?: string | null;
  conversationId?: string;
  /** 解析來源：v1 = Twitter API v1.1 存檔，v2 = API v2 存檔，html = 從 HTML og tag 抽取。 */
  source: 'v1' | 'v2' | 'html';
  /** 可點擊的 Wayback 快照網址（給使用者查證用）。 */
  snapshotUrl: string;
  snapshotTimestamp: string;
};

/**
 * 推文目前的存活狀態。
 * live        = 確認仍存在
 * unavailable = 取不到（已刪除／帳號停權／改私密／地區封鎖，四者無法區分）
 * unknown     = 尚未檢查
 * error       = 檢查過程出錯（逾時、被限流等），可重試
 */
export type LivenessStatus = 'live' | 'unavailable' | 'unknown' | 'error';

export type LivenessResult = {
  tweetId: string;
  status: LivenessStatus;
  /** ISO 8601 檢查時間。 */
  checkedAt: string;
  detail?: string;
};

// ---------- API 契約 ----------

/** GET /api/archive */
export type ArchiveResponse = {
  username: string;
  /** 該帳號在 CDX 中的存檔推文總數（去重後）。 */
  total: number;
  items: ArchivedTweetRef[];
  /** 下一頁的 offset；null 表示已到底。 */
  nextOffset: number | null;
  /** 此結果是否來自本地快取。 */
  cached: boolean;
  /** true 表示索引因時間預算而提前收工，尚未涵蓋該帳號的全部存檔。 */
  partial: boolean;
};

/** POST /api/tweets */
export type TweetsRequest = {
  refs: Pick<ArchivedTweetRef, 'tweetId' | 'timestamp' | 'originalUrl'>[];
};

export type TweetsResponse = {
  tweets: ArchivedTweet[];
  /** 取回或解析失敗的推文 id 與原因。 */
  failed: { tweetId: string; reason: string }[];
};

/** POST /api/liveness */
export type LivenessRequest = { ids: string[] };
export type LivenessResponse = { results: LivenessResult[] };

export type ApiError = { error: string };
