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

  // ── 記事本 ──
  // 手機上常不打空格：「記買尿布」「記帶 健保卡」
  const glued = head.match(/^記(買|帶|做)(.*)$/);
  if (glued) return parseCommand(`記 ${glued[1]} ${[glued[2], ...tokens].join(" ")}`);
  if (["記", "記一下", "note"].includes(key)) {
    if (!tokens.length) return { cmd: "notes" };
    let category = NOTE_ALIASES[tokens[0]] ?? null;
    const rest = (category ? tokens.slice(1) : tokens).join(" ");
    category ??= "other";
    const items = rest.split(/[、，,；;]+/).map((x) => x.trim()).filter(Boolean).map((x) => x.slice(0, 60));
    if (!items.length) return { cmd: "usage", reason: "格式：記 買 尿布、牛奶（分類：買 / 帶 / 做，可省略）" };
    return { cmd: "noteAdd", category, items };
  }
  if (["記事", "筆記", "notes"].includes(key)) {
    if (!tokens.length) return { cmd: "notes" };
    if (["清空", "清除"].includes(tokens[0])) {
      const cat = tokens[1] ? NOTE_ALIASES[tokens[1]] : null;
      if (tokens[1] && !cat) return { cmd: "usage", reason: "格式：記事 清空 [買 / 帶 / 做 / 其他]" };
      return { cmd: "noteClear", category: cat };
    }
    return null;
  }
  if (["完成", "勾", "done"].includes(key)) {
    const ids = tokens.join(" ").match(/\d+/g)?.map(Number) ?? [];
    if (!ids.length) return { cmd: "usage", reason: "格式：完成 3（可一次多筆：完成 3 5 7）" };
    return { cmd: "noteDone", ids };
  }
  if (["備註", "註記"].includes(key)) {
    const m = tokens.join(" ").match(/^#?(\d+)\s*(.*)$/);
    if (!m) return { cmd: "usage", reason: "格式：備註 3 帶健保卡和報告（不寫內容＝清除備註）" };
    return { cmd: "label", id: parseInt(m[1], 10), text: m[2].trim().slice(0, 60) || null };
  }

  if (["診斷", "debug"].includes(key)) {
    const terms = parseTerms(tokens);
    return { cmd: "diagnose", hosp: terms.hosp, ampm: terms.ampm };
  }

  return parseNaturalNote(text);
}

// ── 口語記事：「記得帶大保鮮盒」「別忘了買牛奶、尿布」「記得繳停車費」 ──
// 只認句首的固定說法；問句一律不理，避免把群組閒聊誤記下來。

const REMIND = "(?:(?:記得|別忘了|別忘記|不要忘了|不要忘記|要記得|提醒(?:大家|一下)?)\\s*)+";
const NATURAL = [
  { re: new RegExp(`^${REMIND}\\s*要?\\s*(帶|買)\\s*(.+)$`) },
  { re: /^(?:要|順便|幫忙|幫我|麻煩)\s*(帶|買)\s*(.+)$/ },
  { re: new RegExp(`^${REMIND}\\s*要?\\s*(.+)$`), category: "todo" },
];
const QUESTION = /[?？]|嗎|什麼|甚麼|啥|哪|幾個|多少|要不要|是不是/;
const TRAILING = /[\s!！。～~…]*(?:喔|哦|唷|呦|啊|呀|啦|欸|耶|嘿|喲|囉|哈)*[\s!！。～~…]*$/;

export function parseNaturalNote(raw) {
  const text = String(raw ?? "").replace(/\u3000/g, " ").trim();
  if (!text || text.length > 40 || QUESTION.test(text) || /\n/.test(text)) return null;
  for (const { re, category } of NATURAL) {
    const m = text.match(re);
    if (!m) continue;
    const cat = category ?? (m[1] === "帶" ? "bring" : "buy");
    const body = (category ? m[1] : m[2]).replace(TRAILING, "");
    const items = body.split(/[、，,；;]+/)
      .map((x) => x.trim().replace(/^(?:一個|一些|一點|一下|個|些|點)(?=.)/, ""))
      .filter(Boolean).map((x) => x.slice(0, 30));
    if (!items.length || items.some((x) => x.length < 1)) return null;
    return { cmd: "noteAdd", category: cat, items, natural: true };
  }
  return null;
}

export const NOTE_CATEGORIES = [
  { key: "buy", name: "買", icon: "🛒" },
  { key: "bring", name: "帶", icon: "🎒" },
  { key: "todo", name: "做", icon: "✅" },
  { key: "other", name: "其他", icon: "📌" },
];
const NOTE_ALIASES = {
  買: "buy", 購買: "buy", 要買: "buy",
  帶: "bring", 攜帶: "bring", 要帶: "bring",
  做: "todo", 要做: "todo", 待辦: "todo", 辦: "todo", 要幹麻: "todo", 要幹嘛: "todo",
  其他: "other",
};

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
  "▶ 備註 3 帶健保卡和報告",
  "  把備註加在追蹤 #3，通知會一起顯示",
  "",
  "📝 記事本",
  "▶ 記 買 尿布、牛奶　/　記 帶 健保卡　/　記 做 繳費",
  "  口語也行：記得帶大保鮮盒、別忘了買牛奶",
  "▶ 記事　（列出全部）",
  "▶ 完成 3　/　記事 清空 買",
  "",
  "剩 10、5、2 號與到號時通知，到號後自動移除。",
].join("\n");
