# 看診燈號 LINE 機器人（Cloudflare Worker・臺大醫院）

在 LINE 群組裡用醫師名或按鈕新增追蹤，機器人每分鐘讀取臺大「當日看診進度」，
剩 10 / 5 / 2 號和到號時推播到群組。全部跑在 Cloudflare 免費方案上，電腦不用開。

## 群組指令

| 指令 | 說明 |
|---|---|
| `追蹤 25 戴季珊` | 用醫師名找今天的門診並追蹤 25 號。同一天有多診時會跳出按鈕讓你選 |
| `追蹤 25 兒童 下午 戴季珊` | 指定院區、時段（順序不拘） |
| `追蹤 戴季珊` | 沒給號碼 → 機器人會問，直接回覆數字即可 |
| `追蹤` | 用按鈕選 院區 → 時段 → 診，再回覆號碼 |
| `追蹤 25 <燈號頁網址> [備註]` | 直接貼臺大燈號頁網址 |
| `燈號 戴季珊` | 只查目前燈號，不追蹤（下方有「追蹤」按鈕） |
| `列表` | 追蹤中的看診、目前燈號、剩幾號（下方有取消按鈕） |
| `取消 3` / `取消 全部` | 取消追蹤 |
| `說明` | 顯示用法 |

- 不是指令的訊息一律不理會；單獨一個數字只有在機器人剛問你號碼時才有作用，而且只認提問的那個人。
- 沒指定院區時，搜尋 `SEARCH_HOSPITALS`（預設兒童醫院、總院）今天的三個時段。
- 還沒開始看診時安靜等待；到號（或過號）後自動移除；超過 8 小時也會自動移除。
- 回覆指令不佔 LINE 每月額度；只有燈號通知會計入（群組按人數計算），同一分鐘的多筆通知合併成一則。

## 運作方式

臺大的查詢頁 `ClinicCurrentLightNo` 內含驗證 token，`POST /WebReg/WebReg/DeptLightTable`
帶上 token 與 cookie，就會回傳某院區某時段**所有診**的醫師、診間與目前燈號（科部參數沒有作用）。
機器人每分鐘把到期的追蹤依「院區＋時段」分組，每組只抓一次列表；token 會重複使用，失效時自動重取。

## 部署（第一次）

需要 Node.js 18 以上。以下指令都在 `worker/` 資料夾執行。

```bash
npm install
npx wrangler login                     # 開瀏覽器登入 Cloudflare
npx wrangler d1 create clinic-light    # 把輸出的 database_id 貼到 wrangler.toml
npm run db:migrate                     # 建立 / 更新資料表
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET
npm run deploy
```

`secret put` 會問 `Enter a secret value:`，貼上對應的值後按 Enter（畫面不會顯示）。

LINE Developers → Messaging API 分頁：Webhook URL 填 `https://clinic-light-bot.<子網域>.workers.dev/webhook`，
按 **Verify**，打開 **Use webhook**。LINE Official Account Manager → 回應設定：關閉「自動回應訊息」。

## 更新程式

```bash
git pull
npm run db:migrate     # 有新的資料表變更時才會執行，重複執行沒關係
npm run deploy
```

## 設定（`wrangler.toml` 的 `[vars]`）

| 名稱 | 預設 | 說明 |
|---|---|---|
| `ALLOWED_CHAT_IDS` | 你的群組與個人 ID | 只有這些聊天室能下指令。清空的話，機器人會回報聊天室 ID，方便新增 |
| `SEARCH_HOSPITALS` | `CH,T0` | 用醫師名搜尋時的預設院區（T0 總院、CH 兒童、C0 癌醫、T2 北護、T3 金山、T4 新竹、T7 生醫、Y0 雲林） |
| `THRESHOLDS` | `10,5,2` | 剩幾號時通知 |
| `MAX_HOURS` | `8` | 最長追蹤時數 |

改完後執行 `npm run deploy` 生效。

## 開發

```bash
npm test               # 單元測試（列表解析用真實回應節錄、指令、門檻邏輯）
npx wrangler tail      # 看線上 log
```

## 費用

Cloudflare 免費方案：Workers 每天 10 萬次請求、D1 每天 10 萬次寫入，這個機器人的用量遠低於上限。
LINE 輕用量每月 200 則免費，額度用完只會推不出去，不會扣款。
