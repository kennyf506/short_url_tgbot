# 光房子創意縮網址服務

`lhc.tw` 的短網址服務。提供公開建立頁、管理後台，以及給 Telegram bot 呼叫的內部 API。

## 功能

- 公開建立頁 `/short`：貼上長網址即可產生短網址，支援自訂短碼、次數上限、到期時間、備註
- 管理後台 `/admin`：列出所有連結，可搜尋、編輯、停用、單筆或批次刪除
- 點擊次數限制與到期時間，達上限或過期會顯示品牌化的失效頁
- 有人從公開頁建立時發 Telegram 通知（含目標網址與來源 IP）
- 首次點擊通知（由建立者決定是否開啟）

## 路由

| 路徑 | 說明 | 保護方式 |
|---|---|---|
| `/` | 轉到官網 | — |
| `/short` | 公開建立頁 | 無 |
| `/admin` | 管理後台 | nginx：IP 白名單 + Basic Auth |
| `POST /api/links` | 建立（公開） | 頻率限制 |
| `/api/admin/*` | 管理 API | 同 `/admin` |
| `POST /api/internal/links` | 給 tg-bot 呼叫 | nginx `deny all`，僅 127.0.0.1 |
| `/:code` | 跳轉 | — |

`/:code` 必須註冊在最後，否則會吃掉上面所有路徑。短碼的保留字清單見 `RESERVED`。

## 設定（.env）

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | 3006 | 服務埠號 |
| `SITE_ORIGIN` | `https://lhc.tw` | 產生短網址時用的網域 |
| `DB_HOST` / `DB_USER` / `DB_PASSWORD` | — | MariaDB 連線，資料庫固定為 `lhc_short` |
| `TG_BOT_TOKEN` | — | 發送通知用。**必須搭配 `polling: false`**，與 tg-bot 共用同一支 bot，兩邊都開 polling 會互搶訊息 |
| `NOTIFY_CHAT_ID` | 空 | 有人從公開頁建立時通知誰。留空則不發送 |
| `CREATE_RATE_LIMIT` | 30 | 公開建立的每 IP 每小時上限，0 = 不限 |

## 部署

```bash
npm ci --omit=dev
node migrate-01.js      # 首次部署或升級時執行
pm2 restart lhc-short
```

nginx 需要把 `/admin` 與 `/api/admin` 限制來源並加上 Basic Auth，`/api/internal` 一律 `deny all`。

## 注意事項

- **靜態檔改動後要把 HTML 裡的 `?v=` 版本號加一**，否則 Cloudflare 與瀏覽器的快取會讓使用者拿到舊檔
- 目標網址若缺少 `http(s)://`，`res.redirect` 會當成相對路徑而導致 404。建立時會自動補上 `https://`，管理頁也會把既有的問題資料標示出來
- 點擊次數的檢查與累加是單一原子操作（`UPDATE ... WHERE current_clicks < max_clicks`），避免並發時超過上限
