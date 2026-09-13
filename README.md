# 推文存檔閱覽室 (twitter-archive-explorer)

查詢任一 Twitter／X 帳號在 **Internet Archive** 中被存檔過的所有推文，並逐則查核該推文**目前是否仍存在**於 X 上。

功能定位類似 [xarchive.net](https://xarchive.net/)，但有兩點不同：

1. **主資料源是結構化 JSON，不是網頁截圖。** Internet Archive 有一組通用的 `tweets-*` crawl，把推文以 Twitter API 的 JSON 格式存在 `twitter.com/<user>/status/<id>` 之下。因此能還原推文原文、發布時間、作者與互動數，而不只是一張 HTML 快照。
2. **主動查核存活狀態。** 既有工具多半只用「Wayback 有沒有快照」來推測推文是否被刪，因而無法區分「已刪除」與「從未被存檔」。本專案改為實際向 X 查證每則推文當前是否可取得。

## 快速開始

```bash
pnpm install
pnpm dev
# 開啟 http://localhost:3000
```

需要 **Node.js 22.5 以上**（使用內建的 `node:sqlite`），開發時實測於 Node 24。

### Docker

```bash
docker compose up --build
```

快取資料庫掛在具名 volume 上，容器重建後不必重新索引。

## 運作方式

```
使用者輸入帳號
      │
      ▼
GET /api/archive ──► Wayback CDX Server API
      │              url=twitter.com/<user>/status/*
      │              collapse=urlkey（每則推文一筆）
      │              合併 twitter.com / x.com / mobile.twitter.com
      ▼
  完整推文索引（存入 SQLite，預設 6 小時）
      │
      ▼  卡片進入視野時才觸發
      ├─► POST /api/tweets   ──► web.archive.org/web/<ts>id_/<url>  取回並解析存檔 JSON
      └─► POST /api/liveness ──► cdn.syndication.twimg.com  查核推文現在是否還在
```

### 為什麼需要後端

`web.archive.org` 的 CDX 與快照端點**都不回 CORS header**，`cdn.syndication.twimg.com` 的
CORS 則寫死為 `platform.twitter.com`。三者都無法從瀏覽器直接呼叫，因此必須有伺服器代理。

### 為什麼時間軸不必先抓內容

推文的發布時間可以在不抓取任何內容的情況下得知，依可靠度有三條路：

1. **由推文 id 反推**（`(id >> 22) + 1288834974657`）。Twitter 的 snowflake id 高位元就是毫秒時間戳，
   對 2010-11 之後的所有推文都精確。實測 `1005269895100223489` → `2018-06-09T02:06:34Z`、
   `2098753670213181836` → `2026-09-12T12:40:42Z`，與存檔 JSON 記載完全吻合。
2. **結構化存檔的快照時間戳**。tweets crawl 會把快照時間設為推文發布時間。
3. **抓取時間**。只有 HTML 快照、且 id 早於 snowflake 制度（2010-11 之前）的舊推文才會落到這裡。
   這其實是 Internet Archive 的抓取時間，只是發布時間的**上界**。

每筆索引都帶 `createdAtSource` 標明是哪一種，落到第 3 種時介面會明講「抓取時間，非發布時間」，
不會假裝那是發布時間。時間軸依此排序，推文內容則改為捲動到才載入。

### 三種解析路徑

| 年代 | 格式 | 特徵 |
| --- | --- | --- |
| 約 2018 起 | Twitter API v1.1 status（JSON） | 頂層即推文，`created_at` 是 `Sat Jun 09 02:06:34 +0000 2018` 格式 |
| 約 2026 | Twitter API v2（JSON） | `data` + `includes.users/tweets/media`，`created_at` 是 ISO 8601 |
| 2010–2021 | HTML + Open Graph | 從 `og:description` / `og:title` 抽取 |
| 2007–2009 | 早期 HTML | 早於 Open Graph，整頁沒有 `og:`，正文在 `<div class="desc">`，作者在 `<title>` |

JSON 兩代依「頂層有沒有 `data` 鍵」分派。2022 年後的 HTML 快照多為 SPA 空殼，通常取不到內容，
此時卡片會明說「只有頁面快照」而不是假裝有資料。

## 關於「已不可取得」的準確語意

存活查核拿到 404 時，**無法區分**以下四種情況：

- 作者刪除了推文
- 帳號被停權
- 帳號改為受保護
- 該推文在查詢來源所在地區被封鎖

因此介面上一律標示為「已不可取得」，不會斷言「已刪除」。要精確區分只能使用付費的 X API v2。

## 設定

| 環境變數 | 預設 | 說明 |
| --- | --- | --- |
| `ARCHIVE_DB_PATH` | `./data/cache.db` | SQLite 快取檔位置。設為 `:memory:` 可跑純記憶體模式 |
| `ARCHIVE_CDX_TTL_MS` | `21600000`（6 小時） | 帳號索引的快取時間（毫秒） |
| `ARCHIVE_TWEET_TTL_MS` | 永久 | 推文內容快取時間（毫秒）。可填 `infinite`／`never` |
| `ARCHIVE_LIVENESS_TTL_MS` | `86400000`（24 小時） | 存活狀態的快取時間（毫秒） |

推文內容永久快取，因為存檔內容不會再變動。查核失敗（`error`）的結果不寫入快取，避免暫時性的限流被鎖住。

## 對外部服務的節制

Internet Archive 與 X 的端點都有速率限制，本專案在多處刻意設限：

- CDX 請求序列化並在請求間留間隔，失敗採指數退避重試
- 存檔內容一次最多 50 則、並發 4
- 存活查核一次最多 25 則、並發 3，且**只在卡片進入視野時**才觸發
- 前端把短時間內的請求合併成批次送出
- 所有結果都進 SQLite 快取

請勿移除這些限制去做全站掃描。這些是公共資源。

## 專案結構

```
src/
  app/
    api/archive/route.ts    列出帳號的存檔推文索引
    api/tweets/route.ts     批次取回存檔推文內容
    api/liveness/route.ts   批次查核推文是否仍存在
    page.tsx                主頁面
  components/
    TweetRecord.tsx         單則推文紀錄卡（進入視野才載入）
    StatusStamp.tsx         存活狀態圖章
  lib/
    types.ts                共用型別契約
    cdx.ts                  Wayback CDX 客戶端
    snapshot.ts             存檔快照取回與 v1/v2/HTML 解析
    liveness.ts             syndication／oEmbed 存活查核
    cache.ts                SQLite 快取
    batcher.ts              前端請求合批
```
