// 解析群組裡的文字指令（純函式）
//
//   追蹤 25 <網址> [備註]     新增追蹤（號碼、網址順序不拘）
//   列表                      顯示目前追蹤中的看診
//   取消 3 / 取消 全部        取消追蹤
//   測試 <網址>               抓一次頁面，回報解析結果
//   說明                      顯示用法
//
// 不是以指令開頭的訊息一律回傳 null（群組閒聊不理會）

const URL_RE = /https?:\/\/[^\s<>"'，。]+/i;

export function parseCommand(raw) {
  const text = String(raw ?? "").replace(/　/g, " ").trim();
  const [head, ...rest] = text.split(/\s+/);
  const body = rest.join(" ");
  const key = (head ?? "").toLowerCase();

  if (["追蹤", "追踪", "track", "新增"].includes(key)) {
    const url = body.match(URL_RE)?.[0];
    const tokens = body.replace(URL_RE, " ").split(/\s+/).filter(Boolean);
    const numIdx = tokens.findIndex((t) => /^\d{1,4}號?$/.test(t));
    if (!url || numIdx < 0) return { cmd: "usage", reason: "格式：追蹤 號碼 網址 [備註]" };
    const number = parseInt(tokens[numIdx], 10);
    if (number <= 0) return { cmd: "usage", reason: "號碼必須大於 0" };
    tokens.splice(numIdx, 1);
    const label = tokens.join(" ").slice(0, 30) || null;
    return { cmd: "add", number, url, label };
  }

  if (["列表", "清單", "list", "查詢"].includes(key) && !body) return { cmd: "list" };

  if (["取消", "刪除", "cancel", "停止"].includes(key)) {
    const arg = body.replace(/^#/, "").trim();
    if (["全部", "all"].includes(arg.toLowerCase())) return { cmd: "cancel", all: true };
    if (/^\d+$/.test(arg)) return { cmd: "cancel", id: parseInt(arg, 10) };
    return { cmd: "usage", reason: "格式：取消 編號（例如：取消 3）或 取消 全部" };
  }

  if (["測試", "test"].includes(key)) {
    const url = body.match(URL_RE)?.[0];
    return url ? { cmd: "test", url } : { cmd: "usage", reason: "格式：測試 網址" };
  }

  if (["說明", "help", "指令", "用法"].includes(key) && !body) return { cmd: "help" };

  return null;
}

export const HELP = [
  "📋 看診燈號提醒 指令",
  "",
  "追蹤 號碼 網址 [備註]",
  "  例：追蹤 25 https://reg.ntuh.gov.tw/... 小孩腸胃科",
  "列表",
  "  顯示目前追蹤中的看診",
  "取消 編號　/　取消 全部",
  "測試 網址",
  "  抓一次燈號頁，確認讀得到號碼",
  "",
  "剩 10、5、2 號與到號時會通知，到號後自動移除。",
].join("\n");
