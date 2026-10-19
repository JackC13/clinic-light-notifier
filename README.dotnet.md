# 看診燈號 LINE 提醒（臺大醫院）

> **想在 LINE 群組裡新增、查看、取消追蹤？** 請用 [`worker/`](worker/README.md) 的 Cloudflare 版本（推薦）。
> 以下是單次執行的 .NET 版本，適合在自己電腦上跑，或當醫院擋雲端連線時的備案。

看診當天在自己電腦上執行，燈號接近你的號碼時推播到 LINE，到號後自動結束。
沒有外部套件，只要 .NET 8 SDK 以上。

## 1. LINE 設定（一次性，免費）

1. 到 <https://entry.line.biz/> 建立一個 LINE 官方帳號（名稱隨意，例如「看診提醒」）。
2. 進 LINE Official Account Manager → 設定 → **Messaging API** → 啟用（選或建立一個 Provider）。
3. 到 <https://developers.line.biz/console/> 找到剛剛的 channel：
   - **Messaging API** 分頁最下方 → Channel access token (long-lived) → **Issue** → 複製
   - **Basic settings** 分頁最下方 → **Your user ID**（`U` 開頭）→ 複製
   - **Messaging API** 分頁有 QR code → 用手機 LINE 掃描，**把官方帳號加為好友**（沒加推不到）
4. 本機執行：複製 `appsettings.local.example.json` 成 `appsettings.local.json`，填入 Token 和 User ID。
   這個檔案已被 `.gitignore` 排除，**不要**把 Token 寫進 `appsettings.json`（會被推上 GitHub）。
   GitHub Actions 則用 Secrets（見第 4 節）。
5. 測試：

   ```bash
   dotnet run -- --test-line
   ```

輕用量方案每月 200 則免費，一次看診約推 4–5 則；額度用完只會推不出去，不會扣款。

## 2. 確認燈號解析（第一次用、或網站改版時）

在看診時段（有燈號的時候）執行：

```bash
dotnet run -- --dump
```

- 顯示「目前的 Regex 解析結果：N 號」而且跟網頁一樣 → 完成。
- 顯示「沒對到」→ 把畫面上列出、含有號碼的那幾行貼給 Claude，或自己改 `Parse.Regex`
  （套用在去掉 HTML 的純文字上，第一個括號群組是號碼）。
  頁面也存成 `page.html` / `page.txt`，改完可用 `dotnet run -- --parse-file page.html` 離線測試。

## 3. 看診當天

1. 從掛號網站點進你那一診，複製網址（`ServiceIDSE` 可能每診次不同）。
2. 執行（網址和號碼可以直接用參數帶，不用改檔案）：

   ```bash
   caffeinate -i dotnet run -- --number 25 --url "https://reg.ntuh.gov.tw/WebReg/WebReg/ClinicCurrentLightNoDetail?ServiceIDSE=xxxx&vHospitalCode=CH"
   ```

   `caffeinate -i` 讓 Mac 執行期間不睡眠（Mac 蓋上螢幕仍會睡，請保持開著）。
3. 按 `Ctrl+C` 可隨時停止。

## 4. 用 GitHub Actions 跑（電腦不用開）

一次性設定：
1. 在 GitHub 建一個 **private** repo（public 的執行紀錄任何人都看得到），把這個資料夾推上去。
2. Repo → Settings → Secrets and variables → Actions → New repository secret，新增兩個：
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_USER_ID`

看診當天（手機 GitHub App 或網頁都可以）：
1. Repo → **Actions** → 「看診燈號提醒」→ **Run workflow**
2. 填你的號碼、當天網址，mode 選 `run` → 執行
3. 到號後程式自動結束；要提早停止就在該次執行按 **Cancel workflow**

第一次建議先用 `test-line` 測 LINE，再用 `dump`（在有燈號的時段）確認
**GitHub 的國外機器抓得到臺大網站**。如果被擋，就只能用本機執行。

額度：private repo 每月免費 2,000 分鐘，一次看診約 3–5 小時。workflow 設了 5.5 小時硬上限，
而且同時只會跑一個（重按會取消前一個）。

## 會收到的通知

| 時機 | 訊息 |
|---|---|
| 開始 | ▶️ 目前 X 號，你是 Y 號 |
| 剩 10 / 5 / 2 號內 | 🟡 🟠 🔴 剩 N 號（跳號跨過多個門檻只推一則） |
| 到號 / 已超過 | 🔔 / 🚨，然後程式結束 |
| 連續 3 次抓不到 | ⚠️ 請自己看網頁（恢復時會再通知） |
| 燈號變小 | ⚠️ 可能網址不是今天這一診 |
| 超過 5 小時 | ⏹ 自動結束 |

## 輪詢頻率（`Polling`）

- 剩超過 10 號：每 120 秒抓一次；10 號內：每 30 秒
- 失敗時指數退避（最長 240 秒；接近你的號碼時最長 60 秒）
- 門檻、間隔都可在 `appsettings.json` 調整

## 其他指令

```bash
dotnet run -- --simulate --number 20   # 用假燈號快速跑完整流程（有填 LINE 就會真的推播）
```
