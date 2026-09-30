# 看診燈號 LINE 機器人（Cloudflare Worker）

在 LINE 群組裡輸入指令新增追蹤，機器人每分鐘檢查燈號，剩 10 / 5 / 2 號和到號時推播到群組。
全部跑在 Cloudflare 免費方案上，電腦不用開，也不用 GitHub Actions。

## 群組指令

| 指令 | 說明 |
|---|---|
| `追蹤 25 <網址> [備註]` | 新增追蹤。號碼、網址順序不拘，備註可省略 |
| `列表` | 顯示追蹤中的看診、目前燈號、剩幾號 |
| `取消 3` / `取消 全部` | 取消追蹤 |
| `測試 <網址>` | 抓一次燈號頁，確認讀得到號碼 |
| `說明` | 顯示用法 |

- 其他訊息一律不理會，不會干擾群組聊天。
- 到號（或過號）後自動移除；超過 8 小時也會自動移除。
- 還沒開診時會安靜等待，開診後才開始通知。
- 回覆指令不佔 LINE 每月額度；只有燈號通知會計入（群組按人數計算）。同一分鐘的多筆通知會合併成一則。

## 部署（一次性，約 10 分鐘）

需要 Node.js 18 以上。以下指令都在 `worker/` 資料夾執行。

### 1. 安裝並登入 Cloudflare

```bash
cd worker
npm install
npx wrangler login          # 會開瀏覽器，沒有帳號就先免費註冊
```

### 2. 建立資料庫

```bash
npx wrangler d1 create clinic-light
```

把輸出的 `database_id` 貼到 `wrangler.toml` 的 `database_id = "..."`，然後建立資料表：

```bash
npm run db:init
```

### 3. 設定 LINE 機密

```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN   # LINE Developers → Messaging API 分頁最下方
npx wrangler secret put LINE_CHANNEL_SECRET         # LINE Developers → Basic settings 分頁
```

### 4. 部署

```bash
npm run deploy
```

完成後會顯示網址，例如 `https://clinic-light-bot.xxxx.workers.dev`。
第一次部署可能會要你設定 workers.dev 子網域，照提示輸入即可。

### 5. 把 LINE webhook 指到 Worker

LINE Developers → channel → **Messaging API** 分頁 → Webhook settings：

1. Webhook URL 填 `https://clinic-light-bot.xxxx.workers.dev/webhook`（結尾要有 `/webhook`）
2. 按 **Verify**，應顯示 Success
3. 打開 **Use webhook**

LINE Official Account Manager → 設定 → 回應設定：關閉「自動回應訊息」，避免機器人在群組回罐頭訊息。

### 6. 測試

在群組輸入：

```
說明
測試 https://reg.ntuh.gov.tw/WebReg/WebReg/ClinicCurrentLightNoDetail?ServiceIDSE=...&vHospitalCode=CH
```

`測試` 要在門診有燈號的時段做：
- 回覆「讀得到燈號：目前 N 號」→ 完成
- 回覆「解析不到燈號」→ 把回覆裡列出的文字貼給 Claude 調整解析規則
- 回覆「抓不到網頁」→ 醫院可能擋 Cloudflare 的連線，只能改用本機版（專案根目錄的 .NET 程式）

## 設定（`wrangler.toml` 的 `[vars]`）

| 名稱 | 預設 | 說明 |
|---|---|---|
| `ALLOWED_CHAT_IDS` | 你的群組 ID 與個人 ID | 只有這些聊天室能下指令。清空的話，機器人會在任何聊天室回報該聊天室的 ID，方便新增 |
| `ALLOWED_HOSTS` | `reg.ntuh.gov.tw` | 只允許追蹤這些網站 |
| `THRESHOLDS` | `10,5,2` | 剩幾號時通知 |
| `MAX_HOURS` | `8` | 最長追蹤時數 |
| `LIGHT_REGEX` | （內建） | 燈號解析規則，需要時再加 |

改完後執行 `npm run deploy` 生效。

## 開發

```bash
npm test                    # 單元測試（解析、指令、門檻邏輯）
npx wrangler tail           # 看線上 log
```

## 費用

Cloudflare 免費方案：Workers 每天 10 萬次請求、D1 每天 10 萬次寫入，這個機器人每天用量約 1,500 次，遠低於上限。
LINE 輕用量每月 200 則免費，額度用完只會推不出去，不會扣款。
