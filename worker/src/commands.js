// 解析群組裡的文字指令（純函式）
//
//   追蹤 25 戴季珊            用醫師名找今天的門診（可加院區、時段：追蹤 25 兒童 下午 戴季珊）
//   追蹤                      用按鈕選 院區 → 時段 → 診
//   追蹤 25 <燈號頁網址>       直接用網址
//   燈號 戴季珊               只查目前燈號，不追蹤
//   列表 / 取消 3 / 取消 全部 / 說明
//   25                        選好診之後，回覆自己的號碼
//
// 不是指令的訊息回傳 null（群組閒聊不理會）

import { hospitalByAlias, ampmByAlias } from "./ntuh.js";

const URL_RE = /https?:\/\/[^\s<>"'，。]+/i;
const NUM_RE = /^(\d{1,4})號?$/;

/** 把「25 兒童 下午 戴季珊」拆成號碼、院區、時段、醫師名 */
function parseTerms(tokens) {
  let number = null, hosp = null, ampm = null;
  const rest = [];
  for (const t of tokens) {
    const n = t.match(NUM_RE);
    if (n && number === null) number = parseInt(n[1], 10);
    else if (!hosp && hospitalByAlias(t)) hosp = hospitalByAlias(t);
    else if (!ampm && ampmByAlias(t)) ampm = ampmByAlias(t);
    else rest.push(t);
  }
  const doctor = rest.join("").replace(/醫師$|醫生$/, "") || null;
  return { number, hosp, ampm, doctor };
}

export function parseCommand(raw) {
  const text = String(raw ?? "").replace(/　/g, " ").trim();
  const [head = "", ...tokens] = text.split(/\s+/);
  const key = head.toLowerCase();

  const num = text.match(NUM_RE);
  if (num) return { cmd: "number", number: parseInt(num[1], 10) };

  if (["追蹤", "追踪", "track", "新增"].includes(key)) {
    const body = tokens.join(" ");
    const url = body.match(URL_RE)?.[0];
    if (url) {
      const rest = body.replace(URL_RE, " ").split(/\s+/).filter(Boolean);
      const { number } = parseTerms(rest);
      const label = rest.filter((t) => !NUM_RE.test(t)).join(" ").slice(0, 30) || null;
      return { cmd: "addUrl", url, number, label };
    }
    const terms = parseTerms(tokens);
    if (terms.number !== null && terms.number <= 0) return { cmd: "usage", reason: "號碼必須大於 0" };
    return terms.doctor ? { cmd: "add", ...terms } : { cmd: "guide", ...terms };
  }

  if (["燈號", "查燈號", "看燈號", "查"].includes(key)) {
    const terms = parseTerms(tokens);
    if (!terms.doctor) return { cmd: "usage", reason: "格式：燈號 醫師名（例：燈號 戴季珊）" };
    return { cmd: "lookup", hosp: terms.hosp, ampm: terms.ampm, doctor: terms.doctor };
  }

  if (["列表", "清單", "list"].includes(key) && tokens.length === 0) return { cmd: "list" };

  if (["取消", "刪除", "cancel", "停止"].includes(key)) {
    const arg = tokens.join("").replace(/^#/, "");
    if (["全部", "all"].includes(arg.toLowerCase())) return { cmd: "cancel", all: true };
    if (/^\d+$/.test(arg)) return { cmd: "cancel", id: parseInt(arg, 10) };
    return { cmd: "usage", reason: "格式：取消 編號（例：取消 3）或 取消 全部" };
  }

  if (["說明", "help", "指令", "用法"].includes(key) && tokens.length === 0) return { cmd: "help" };

  return null;
}

export const HELP = [
  "📋 看診燈號提醒（臺大醫院）",
  "",
  "▶ 追蹤 25 戴季珊",
  "  用醫師名找今天的門診，開始追蹤 25 號",
  "  可指定院區、時段：追蹤 25 兒童 下午 戴季珊",
  "▶ 追蹤",
  "  用按鈕選 院區 → 時段 → 診，再輸入號碼",
  "▶ 燈號 戴季珊",
  "  只查目前燈號，不追蹤",
  "▶ 列表",
  "▶ 取消 3　/　取消 全部",
  "",
  "剩 10、5、2 號與到號時通知，到號後自動移除。",
].join("\n");
