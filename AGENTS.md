<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# 專案規則

## 這是什麼

查詢某 Twitter／X 帳號在 Internet Archive 中被存檔的所有推文，並查核每則目前是否仍存在。
背景與完整運作方式見 `README.md`。

## 不可違反的事實（已實測驗證，不要憑記憶推翻）

- **CDX 查詢絕對不要加 `filter=statuscode:200`。** 結構化 JSON 存檔的 statuscode 是 `-`，
  加上去會把主資料源整批濾掉。
- **CDX 回傳的第一列是欄位名稱列**，必須跳過。
- **CDX 預設排序是 urlkey 字母序，不是時間序。**
- **CDX 與 `web.archive.org` 快照端點都沒有 CORS header**；`cdn.syndication.twimg.com` 的 CORS
  寫死為 `platform.twitter.com`。這三者只能從伺服器端呼叫，不要試圖搬到前端。
- **存檔 JSON 有 v1.1 與 v2 兩種 schema**，靠頂層有無 `data` 鍵分派，兩種都要支援。
- **「Wayback 快照時間戳等於推文發布時間」只對結構化 JSON 的 tweets crawl 成立。**
  一般 HTML 快照的時間戳是**抓取時間**。發布時間優先用 snowflake 反推
  （`(id >> 22) + 1288834974657`，適用 id ≥ `29700859247`，即 2010-11 之後），
  推不出來才退回快照時間戳，並以 `createdAtSource` 標明來源。
- **`limit` 開小會讓 CDX 變慢，不是變快。** CDX 不論 limit 多少都要掃過整個 urlkey 區間，
  小 limit 多翻頁等於重複付掃描成本。實測 `jack` 從 limit=5000（13 頁、232s）改成
  150000（1 頁、28s）。不要為了「保守」把 `DEFAULT_PAGE_LIMIT` 調小。
- **早期存檔 URL 會帶明示連接埠**（`http://twitter.com:80/jack/statuses/5254943`），
  而且路徑是 `statuses` 不是 `status`，推文 id 可能只有 3–4 位數。
  驗證網址一律用 `new URL()` 比對 hostname 白名單，不要用會被 `:80` 打敗的字串 regex。
- **2007–2009 年的頁面早於 Open Graph**，完全沒有 `og:` meta，正文在 `<div class="desc">`。

## 語意紀律

存活查核拿到 404 時無法區分「刪除／停權／改私密／地區封鎖」。
**程式碼、UI 文案、註解一律不得斷言「已刪除」**，只能說「已不可取得」。

## 對外部服務要節制

Internet Archive 與 X 都是公共資源且有速率限制。既有的並發上限、請求間隔、退避重試與
SQLite 快取都是刻意設計，**不要為了跑得快而移除**。存活查核只在卡片進入視野時觸發，
不要改成整批預先掃描。

## 慣例

- 資料存取一律經過 `src/lib/cache.ts`，不要在 route 裡直接開 DB。
- `src/lib/types.ts` 是 lib／API／UI 的共用契約，改動要同步三邊。
- 不要為了快取而引入 better-sqlite3，用 Node 內建的 `node:sqlite`。
- 註解與使用者可見文案用繁體中文，程式識別字用英文。

## 送件（`/api/submit`）

送件只做一件事：即時向 X 擷取該則推文的內容，存進本地 SQLite。沒有其他分支。

送件只做單筆。不要加批次送出整個帳號的功能 —— X 的端點是公共資源。

### 不要重新加回 Save Page Now 提交功能

曾經有第二條線用 Save Page Now（SPN）提交到 Internet Archive，**已移除，不要加回來**。
2026-09-14 實測：

- 用**有效**金鑰提交 `x.com/<user>/status/<id>`、`twitter.com/<user>/status/<id>`、
  `x.com/<user>`，SPN 一律回 `{"status":"error","status_ext":"error:blocked-url"}`。
- **同一組金鑰**提交 `https://example.com/` 則正常受理，只撞到每日配額上限。

所以這是 Internet Archive 端對 X／Twitter 的整站限制，不是金鑰問題、不是網址格式問題，
也不是本專案的 bug。重試、換 URL 形式、改參數都不會成功。
CDX 上的佐證：SPN 來源（`x-archive-src` 為 `liveweb-...spn*`）的推文快照停在 2020 年前後，
現在 IA 上的推文存檔來自它自己的 `tweets-*` 管線與 ArchiveTeam。

這條線移除後專案已無任何 Internet Archive 帳號金鑰。日後若真的引入任何密鑰，
一律只從環境變數讀取，且不得出現在錯誤訊息、log 或 API 回應中。

## API 的健壯性要求

批次端點（`/api/tweets`、`/api/liveness`）**不得因為單一筆輸入格式不對就整批回 400**。
存檔索引本來就混有各種歷史 URL 樣態，一則舊推文不該毒死整頁；不合格的項目記進 `failed` 就好。

## 驗證

改完務必跑過（缺一不可）：

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

`tsconfig.json` 開了 `incremental`，`tsc --noEmit` 可能拿 stale 的 `tsconfig.tsbuildinfo`
回報已經修好的錯誤。結果可疑時先 `rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo` 再跑一次。
