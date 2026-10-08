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
import { parseWhen } from "./when.js";

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

export function parseCommand(raw, now = Date.now()) {
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

  // ── 提醒 ──
  if (/^(?:提醒|看提醒|提醒列表|提醒清單|列出提醒)$/.test(text)) return { cmd: "remindList" };
  const rc = text.match(/^(?:取消|刪除)\s*提醒\s*#?(\d+)$/);
  if (rc) return { cmd: "remindCancel", id: parseInt(rc[1], 10) };

  // 刪除 30 / 刪除 3 5 7（記事；編號不是記事時改取消追蹤）
  const del = text.match(/^(?:刪除|刪掉|刪|移除|delete|del)\s*((?:#?\d+[\s,、，]*)+)$/i);
  if (del) return { cmd: "delete", ids: [...new Set(del[1].match(/\d+/g).map(Number))].slice(0, 20) };
  if (/^(?:刪除|刪掉|刪|移除|delete|del)(?:\s|$)/i.test(text)) {
    return { cmd: "usage", reason: "格式：刪除 30（可一次多筆：刪除 3 5 7）\n清空記事：記事 清空　/　取消全部追蹤：取消 全部" };
  }

  if (["取消", "cancel", "停止"].includes(key)) {
    const arg = tokens.join("").replace(/^#/, "");
    if (["全部", "all"].includes(arg.toLowerCase())) return { cmd: "cancel", all: true };
    if (/^\d+$/.test(arg)) return { cmd: "cancel", id: parseInt(arg, 10) };
    return { cmd: "usage", reason: "格式：取消 編號（例：取消 3）或 取消 全部" };
  }

  if (["說明", "help", "指令", "用法"].includes(key) && tokens.length === 0) return { cmd: "help" };
  if (["選單", "menu", "功能", "主選單", "目錄"].includes(key) && tokens.length === 0) return { cmd: "menu" };

  // ── 記事本 ──
  // 手機上常不打空格：「記買尿布」「記帶 健保卡」
  const glued = head.match(/^記(買|帶|做|出國)(.*)$/);
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
  // 「記事」「記事 買」「記事買什麼」「記事 出國」
  const nq = text.match(/^(?:記事|筆記|notes)\s*(.*)$/i);
  if (nq) {
    const rest = nq[1].trim();
    if (!rest) return { cmd: "notes" };
    if (/^本?\s*(?:說明|用法|教學|help|怎麼用)$/i.test(rest)) return { cmd: "noteHelp" };
    const [first, second] = rest.split(/\s+/);
    if (["清空", "清除"].includes(first)) {
      const cat = second ? NOTE_ALIASES[second] : null;
      if (second && !cat) return { cmd: "usage", reason: "格式：記事 清空 [買 / 帶 / 做 / 出國 / 其他]" };
      return { cmd: "noteClear", category: cat };
    }
    const cat = noteCategoryOf(rest);
    return cat ? { cmd: "notes", category: cat } : null;
  }
  // 單獨問「買什麼」「要帶什麼」「出國要帶什麼」→ 列出該分類
  const ask = text.match(/^(?:要)?(出國\s*(?:要)?\s*帶|出國\s*(?:要)?\s*買|買|帶)\s*(?:什麼|甚麼|啥|東西|哪些)\s*[?？]?$/);
  if (ask) return { cmd: "notes", category: /出國/.test(ask[1]) ? "trip" : ask[1] === "買" ? "buy" : "bring" };
  if (["完成", "勾", "done"].includes(key)) {
    const ids = tokens.join(" ").match(/\d+/g)?.map(Number) ?? [];
    if (!ids.length) return { cmd: "usage", reason: "格式：完成 3（可一次多筆：完成 3 5 7）" };
    return { cmd: "noteDone", ids };
  }
  // 改 3 大保鮮盒 / 改 3 買 牛奶 / 改 3 出國 / 3 改成 大保鮮盒
  const ed = text.match(/^(?:改|修改|編輯|更改)\s*#?(\d+)\s*(?:改成|改為|成|為|[:：])?\s*(.*)$/) ?? text.match(/^#?(\d+)\s*(?:改成|改為)\s*(.*)$/);
  if (ed) {
    const id = parseInt(ed[1], 10);
    const parts = ed[2].trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { cmd: "usage", reason: `格式：改 ${id} 新內容（也可以換分類：改 ${id} 買 牛奶、改 ${id} 出國）` };
    const cat = NOTE_ALIASES[parts[0]] ?? null;
    const rest = (cat ? parts.slice(1) : parts).join(" ").slice(0, 60);
    return { cmd: "noteEdit", id, category: cat, text: rest || null };
  }
  if (/^(?:改|修改|編輯|更改)$/.test(text)) return { cmd: "usage", reason: "格式：改 編號 新內容（例：改 3 大保鮮盒）" };

  if (["附圖", "加圖"].includes(key)) {
    const id = tokens.join("").match(/\d+/)?.[0];
    return id ? { cmd: "photoAsk", id: parseInt(id, 10) } : { cmd: "usage", reason: "格式：附圖 3（再傳一張照片）" };
  }
  if (["看圖", "圖"].includes(key)) {
    const id = tokens.join("").match(/\d+/)?.[0];
    return id ? { cmd: "photoShow", id: parseInt(id, 10) } : { cmd: "usage", reason: "格式：看圖 3" };
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

  return parseRemind(text, now) ?? noteWithDate(text, now) ?? parseNaturalNote(text);
}

// ── 提醒：「提醒 明天 8點 帶傘」「明天晚上提醒我繳費」「30分鐘後提醒 關火」 ──
const REMIND_HEAD = /^提醒(?:我|我們|大家|一下)?\s*/;

function parseRemind(text, now) {
  let s = text;
  const explicit = REMIND_HEAD.test(s);
  if (explicit) s = s.replace(REMIND_HEAD, "");
  const w = parseWhen(s, now);
  if (!w) {
    if (!explicit || !s) return null;
    // 「提醒大家記得帶口罩」沒有時間 → 當一般記事
    return parseNaturalNote(text) ? null : { cmd: "usage", reason: "格式：提醒 明天 8點 帶傘（日期、時間寫在前面）" };
  }
  let rest = w.rest;
  if (!explicit) {
    const p = rest.match(REMIND_HEAD);
    if (!p) return null;                 // 「明天帶月餅」→ 交給帶日期的記事
    rest = rest.slice(p[0].length);
  }
  rest = rest.replace(REMIND_HEAD, "").replace(/[\s。!！~～]+$/, "").trim();
  if (!rest) return { cmd: "usage", reason: "要提醒什麼呢？例：提醒 明天 8點 帶傘" };
  if (QUESTION.test(rest)) return null;
  return { cmd: "remind", at: w.at, hasTime: w.hasTime, text: rest.slice(0, 60) };
}

// ── 帶日期的記事：「明天帶月餅」「10/8 學校要帶濕紙巾」「記得週五買牛奶」→ 記事 + 當天提醒 ──
function noteWithDate(text, now) {
  const pre = text.match(new RegExp(`^${REMIND}`))?.[0] ?? "";
  const w = parseWhen(text.slice(pre.length), now);
  if (!w || !w.rest) return null;
  const note = parseNaturalNote(pre + w.rest);
  if (!note) return null;
  return { ...note, remindAt: w.at, remindHasTime: w.hasTime };
}

// ── 口語記事：「記得帶大保鮮盒」「別忘了買牛奶、尿布」「記得繳停車費」 ──
// 只認句首的固定說法；問句一律不理，避免把群組閒聊誤記下來。

const REMIND = "(?:(?:記得|別忘了|別忘記|不要忘了|不要忘記|要記得|提醒(?:大家|一下)?)\\s*)+";
const QUESTION = /[?？]|嗎|什麼|甚麼|啥|哪|幾個|多少|要不要|是不是/;
const TRAILING = /[\s!！。～~…]*(?:喔|哦|唷|呦|啊|呀|啦|欸|耶|嘿|喲|囉|哈)*[\s!！。～~…]*$/;
const MEASURE = /^(?:一(?:個|些|點|下|包|盒|瓶|袋|條|罐|份|顆|張|件|雙|支|本|片|串|箱|組|台|套)|個|些)(?=.)/;
// 沒有「記得」開頭時，出現這些字多半是在聊天，不是要記事
const CHATTY = /去|來|回|到|給|跟|一起|了|過|很|太|在|吧|貴|便宜|好吃|可以|不|沒|想|會|他|她|你|我/;
// 數量說法，判斷是不是閒聊時先拿掉（「很多愛」的「很」不算閒聊）
const QTY = /^(?:很多|好多|超多|一堆|多一點|多點|一點點?|一些|幾(?:個|包|盒|瓶|條|罐|份|顆|張|件|雙|支|本|片))/;
// 「學校要帶…」「明天得買…」：句首的場合
const CONTEXT = /^([^\s]{1,6}?)\s*(?:要|需要|(?<![記曉懂覺])得)\s*(?=帶|買)/;
const PRONOUN = /我|你|他|她|大家/;
// 「濕紙巾去學校」「健保卡到醫院」：句尾的地點
const PLACE = /^(.+?)\s*(?:去|到)\s*(\S{1,8})$/;
// 「月餅跟餅乾」
const JOIN = /(?<=\S)\s*(?:跟|和|還有|以及|與|及)\s*(?=\S)/;
// 帶「人」去某處是在聊天：「帶小孩去公園」「帶他去看醫生」
const PEOPLE = /^(?:小孩|孩子|小朋友|兒子|女兒|寶寶|弟弟|妹妹|哥哥|姐姐|姊姊|老婆|老公|媽媽?|爸爸?|阿公|阿嬤|奶奶|爺爺|外婆|外公|狗狗?|貓咪?|他|她|你|我|大家)們?$/;

/**
 * 口語記事：
 *   「記得帶大保鮮盒」「別忘了買牛奶、尿布」「記得繳停車費」
 *   「帶保鮮盒、買麵、買晚餐」（每段各自的動詞；沒寫動詞的沿用前一段：「買麵、晚餐」）
 *   「帶月餅跟餅乾」「帶一包濕紙巾去學校」「學校要帶一包濕紙巾」→ 濕紙巾（學校）
 *   可以分行寫多句。問句、閒聊不觸發。
 */
export function parseNaturalNote(raw) {
  const text = String(raw ?? "").replace(/　/g, " ").trim();
  if (!text || text.length > 120 || QUESTION.test(text)) return null;

  let body = text;
  let reminded = false;
  const r = body.match(new RegExp(`^${REMIND}`));
  if (r) {
    reminded = true;
    body = body.slice(r[0].length).replace(/^要\s*/, "");
  }

  const segs = body.split(/[、，,；;\n]+/).map((x) => x.replace(TRAILING, "").trim()).filter(Boolean);
  if (!segs.length) return null;

  const entries = [];
  let category = null;
  let prefix = "";                  // 「出國買…」記成出國分類的「買…」
  for (let seg of segs) {
    let sure = reminded;            // 這一段有明確的記事語氣
    const tags = [];
    const lead = seg.match(/^(?:要|順便|幫忙|幫我|麻煩)\s*(?=帶|買)/);
    if (lead) {
      sure = true;
      seg = seg.slice(lead[0].length);
    }
    const trip = seg.match(/^出國\s*(?:要|需要|得)?\s*(帶|買)\s*(.+)$/);
    if (trip) {
      sure = true;
      category = "trip";
      prefix = trip[1] === "買" ? "買" : "";
      seg = trip[2];
    } else if (!lead) {
      const c = seg.match(CONTEXT);
      if (c) {
        if (PRONOUN.test(c[1])) return null;   // 「我要買午餐」是在聊天
        sure = true;
        tags.push(c[1]);
        seg = seg.slice(c[0].length);
      }
    }

    const v = trip ? null : seg.match(/^(帶|買)\s*(.+)$/);
    if (v) {
      category = v[1] === "帶" ? "bring" : "buy";
      prefix = "";
      seg = v[2];
      const abroad = seg.match(/^(.+?)\s*出國$/);   // 「帶護照出國」
      if (abroad) {
        sure = true;
        category = "trip";
        prefix = v[1] === "買" ? "買" : "";
        seg = abroad[1];
      }
    } else if (trip) {
      // 已處理
    } else if (!category) {
      if (!sure) return null;  // 第一段沒有「帶 / 買」又沒有「記得」：不是記事
      category = "todo";       // 「記得繳停車費」
    }

    if (category !== "todo") {
      const p = seg.match(PLACE);
      if (p) {
        seg = p[1];
        if (!tags.includes(p[2])) tags.push(p[2]);
      }
    }
    const items = category === "todo" ? [seg] : seg.split(JOIN);
    for (let item of items) {
      item = item.replace(MEASURE, "").trim();
      if (!item) return null;
      if (category !== "todo" && PEOPLE.test(item)) return null;
      if (!sure && (item.length > 12 || CHATTY.test(item.replace(QTY, "")))) return null;
      const t = (prefix + (tags.length ? `${item}（${tags.join("、")}）` : item)).slice(0, 30);
      if (!entries.some((e) => e.category === category && e.text === t)) entries.push({ category, text: t });
    }
  }
  return { cmd: "noteAdd", entries, natural: true };
}

/** 「買」「買什麼」「要買的東西」「出國帶什麼」「待辦」→ 分類 key */
function noteCategoryOf(raw) {
  let t = raw.replace(/[?？\s]/g, "").replace(/^要/, "").replace(/(?:什麼|甚麼|啥|東西|哪些|清單|列表|的)+$/, "").replace(/^要/, "");
  if (/^出國/.test(t)) return "trip";
  return NOTE_ALIASES[t] ?? null;
}

export const NOTE_CATEGORIES = [
  { key: "buy", name: "買", icon: "🛒" },
  { key: "bring", name: "帶", icon: "🎒" },
  { key: "todo", name: "做", icon: "✅" },
  { key: "trip", name: "出國", icon: "✈️" },
  { key: "other", name: "其他", icon: "📌" },
];
const NOTE_ALIASES = {
  買: "buy", 購買: "buy", 要買: "buy",
  帶: "bring", 攜帶: "bring", 要帶: "bring",
  做: "todo", 要做: "todo", 待辦: "todo", 辦: "todo", 要幹麻: "todo", 要幹嘛: "todo",
  出國: "trip", 出國帶: "trip", 出國要帶: "trip",
  出國買: "trip", 出國要買: "trip", 旅行: "trip",
  其他: "other",
};

export const NOTE_HELP = [
  "📝 記事本用法（群組共用）",
  "分類：🛒 買｜🎒 帶｜✅ 做｜✈️ 出國｜📌 其他",
  "",
  "【新增】直接打字就好",
  "▶ 帶保鮮盒、買麵、買晚餐",
  "  一句可以混著寫，沒寫動詞的沿用前一個",
  "▶ 帶月餅跟餅乾　（跟、和 連接多項）",
  "▶ 學校要帶濕紙巾／帶濕紙巾去學校",
  "  → 濕紙巾（學校）",
  "▶ 記得帶健保卡／別忘了買牛奶",
  "▶ 記得繳停車費　→ ✅ 做",
  "▶ 出國帶護照、轉接頭／帶護照出國　→ ✈️ 出國",
  "▶ 記 買 尿布、牛奶　（指定分類的寫法）",
  "▶ 記 問醫生疫苗時間　（沒寫分類 → 📌 其他）",
  "可以分行一次記好幾句；記錯按「撤銷」。",
  "",
  "【查看】",
  "▶ 記事　（全部）",
  "▶ 記事 買／買什麼／要帶什麼／出國帶什麼／記事 做",
  "  只看某一類",
  "",
  "【日期提醒】前面加日期就會到時提醒",
  "▶ 明天帶月餅　/　10/8 學校要帶濕紙巾",
  "▶ 週五晚上8點 買牛奶　（沒寫時間＝當天早上 8 點）",
  "▶ 提醒列表　/　取消提醒 3",
  "",
  "【修改】",
  "▶ 改 3 大保鮮盒　/　3 改成 大保鮮盒",
  "▶ 改 3 買 牛奶　（換分類＋內容）　/　改 3 出國（只換分類）",
  "",
  "【完成、清空】",
  "▶ 完成 3　/　完成 3 5 7　/　刪除 3（一樣會刪掉）",
  "▶ 記事 清空 買　/　記事 清空（全部）",
  "",
  "【照片】",
  "▶ 記下後按「📷 附圖」，再拍照或選相簿",
  "▶ 附圖 3　/　看圖 3",
  "",
  "看診快輪到時，通知會附上「🎒 帶」的東西。",
  "問句和聊天（帶小孩去公園、買了晚餐）不會被記下來。",
].join("\n");

export const HELP = [
  "📋 看診燈號提醒（臺大醫院）",
  "輸入「選單」可以用按鈕操作",
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
  "  口語也行：帶保鮮盒、買麵、買晚餐／學校要帶濕紙巾",
  "▶ 出國帶 護照、轉接頭　（✈️ 出國分類）",
  "▶ 記事　（列出全部）",
  "▶ 記事 買　/　買什麼　/　要帶什麼　/　出國帶什麼",
  "  只看某一類",
  "▶ 完成 3　/　刪除 3　/　記事 清空 買",
  "▶ 改 3 大保鮮盒　（修改記事）",
  "▶ 附圖 3（再傳照片）／看圖 3",
  "▶ 記事 說明　（記事本完整用法）",
  "",
  "⏰ 提醒",
  "▶ 提醒 明天 8點 帶傘　/　提醒 10/8 繳費",
  "▶ 30分鐘後提醒 關火　/　週五晚上提醒我倒垃圾",
  "▶ 明天帶月餅　（記事＋當天早上 8 點提醒）",
  "▶ 提醒列表　/　取消提醒 3",
  "",
  "剩 10、5、2 號與到號時通知，到號後自動移除。",
].join("\n");
