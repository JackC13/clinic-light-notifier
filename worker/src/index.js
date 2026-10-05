// 看診燈號 LINE 機器人（Cloudflare Worker，臺大醫院）
//   fetch     : 接收 LINE webhook，處理群組指令與按鈕
//   scheduled : 每分鐘檢查到期的追蹤，抓燈號、推播

import { parseCommand, HELP, NOTE_CATEGORIES } from "./commands.js";
import { verifySignature, reply, push, textMsg, quickPostback, quickText, getContent, imageMsg, quickCamera, quickCameraRoll } from "./line.js";
import {
  HOSPITALS, AMPM, hospitalName, currentAmpm, fetchTable, fetchDetail, diagnose, parseDetailUrl, detailUrl, baseUrl,
} from "./ntuh.js";
import { loadConfig, onReading, onFailure, onDetail, isExpired, title, CHECKIN_NOTE } from "./monitor.js";

const MAX_ACTIVE_PER_CHAT = 10;
const MAX_PER_TICK = 30;
const PENDING_TTL = 10 * 60_000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("clinic-light-bot OK");
    const img = url.pathname.match(/^\/img\/([0-9a-f]{32}(?:_p)?)$/);
    if (request.method === "GET" && img) return serveImage(env, img[1]);
    if (request.method !== "POST" || url.pathname !== "/webhook") return new Response("Not found", { status: 404 });

    const body = await request.text();
    const ok = await verifySignature(env.LINE_CHANNEL_SECRET, body, request.headers.get("x-line-signature"));
    if (!ok) return new Response("Bad signature", { status: 401 });

    let events = [];
    try {
      events = JSON.parse(body).events ?? [];
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }
    // 先回 200 給 LINE，指令在背景處理
    ctx.waitUntil(Promise.allSettled(events.map((e) => handleEvent(e, env, url.origin))));
    return new Response("OK");
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env, Date.now()));
  },
};

// ───────────────────────── 事件 ─────────────────────────

function allowedChats(env) {
  return String(env.ALLOWED_CHAT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function handleEvent(event, env, origin) {
  const src = event.source ?? {};
  const chatId = src.groupId ?? src.roomId ?? src.userId;
  if (!chatId || !event.replyToken) return;

  let cmd = null;
  if (event.type === "message" && event.message?.type === "text") cmd = parseCommand(event.message.text);
  else if (event.type === "message" && event.message?.type === "image") cmd = { cmd: "image", messageId: event.message.id };
  else if (event.type === "postback") {
    try {
      cmd = { cmd: "postback", data: JSON.parse(event.postback.data) };
    } catch {
      return;
    }
  }
  if (!cmd) return;

  const allowed = allowedChats(env);
  if (allowed.length === 0) {
    if (cmd.cmd === "number" || cmd.cmd === "image") return;
    return reply(env, event.replyToken,
      `🔒 尚未設定授權聊天室。\n這個聊天室的 ID：\n${chatId}\n請加到 ALLOWED_CHAT_IDS 後重新部署。`);
  }
  if (!allowed.includes(chatId)) return;

  const ctx = { env, origin, chatId, userId: src.userId ?? "", now: Date.now(), tables: new Map() };
  let out;
  try {
    out = await runCommand(cmd, ctx);
  } catch (e) {
    console.error(e);
    out = `❌ 發生錯誤：${e.message}`;
  }
  if (out) await reply(env, event.replyToken, out);
}

async function runCommand(cmd, ctx) {
  switch (cmd.cmd) {
    case "help": return textMsg(HELP, [quickText("☰ 選單", "選單")]);
    case "menu": return menuCard(ctx);
    case "usage": return `❓ ${cmd.reason}\n\n輸入「說明」看完整用法`;
    case "list": return listReply(ctx);
    case "cancel": return cancel(cmd, ctx);
    case "lookup": return lookup(cmd, ctx);
    case "add": return addByDoctor(cmd, ctx);
    case "guide": return guide(cmd, ctx);
    case "addUrl": return addByUrl(cmd, ctx);
    case "number": return answerNumber(cmd.number, ctx);
    case "postback": return onPostback(cmd.data, ctx);
    case "notes": return notesReply(ctx);
    case "noteAdd": return noteAdd(cmd, ctx);
    case "noteDone": return noteDone(cmd, ctx);
    case "noteClear": return noteClear(cmd, ctx);
    case "label": return setLabel(cmd, ctx);
    case "photoAsk": return photoAsk(cmd.id, ctx);
    case "photoShow": return photoShow(cmd.id, ctx);
    case "image": return onImage(cmd, ctx);
    case "diagnose": {
      const hosp = cmd.hosp ?? "CH";
      const ampm = cmd.ampm ?? currentAmpm(ctx.now);
      const trace = await diagnose(ctx.env, hosp, ampm);
      return [`🩺 診斷：${hospitalName(hosp)} ${AMPM[ampm]}`, "", ...trace.map((l) => `・${l}`)].join("\n");
    }
  }
  return null;
}

// ───────────────────────── 查詢 ─────────────────────────

/** 同一次處理內，同院區同時段只抓一次 */
function getTable(ctx, hosp, ampm) {
  const key = `${hosp}|${ampm}`;
  if (!ctx.tables.has(key)) ctx.tables.set(key, fetchTable(ctx.env, hosp, ampm));
  return ctx.tables.get(key);
}

/** 同一次處理內，同一診的燈號頁只抓一次 */
function getDetail(ctx, hosp, sid) {
  const key = `detail|${hosp}|${sid}`;
  if (!ctx.tables.has(key)) ctx.tables.set(key, fetchDetail(ctx.env, hosp, sid));
  return ctx.tables.get(key);
}

/** 找某一診：先查院區列表；列表查不到（例如查詢頁暫時 520）時改用不需要 token 的個別燈號頁 */
async function findClinic(ctx, hosp, ampm, sid) {
  try {
    const table = await getTable(ctx, hosp, ampm);
    return table.clinics.find((x) => x.sid === sid) ?? null;
  } catch (e) {
    const d = await getDetail(ctx, hosp, sid).catch(() => null);
    if (!d) throw e;
    console.warn(`列表失敗（${e.message}），改用燈號頁`);
    return {
      sid, hosp, number: d.current, note: "", byCheckin: false, fromDetail: true,
      room: d.room.replace(/^\S+\s+/, "").replace(/\s+/g, ""), doctor: d.doctor || "（醫師）",
    };
  }
}

/** 加入追蹤時，從燈號頁判斷你目前的報到狀態 */
function initialCheckin(d, my) {
  const me = d?.statuses.find((s) => s.n === my);
  if (!me) return { state: null };
  if (me.status === "checkin" || me.status === "oncall") {
    const ahead = d.statuses.filter((s) => s.n !== my && (s.status === "checkin" || s.status === "oncall")).map((s) => s.n);
    return { state: "approx", ahead };
  }
  return { state: "no" };
}

function searchHospitals(env) {
  return String(env.SEARCH_HOSPITALS ?? "CH,T0").split(",").map((s) => s.trim()).filter(Boolean);
}

const normName = (s) => String(s).replace(/\(代\)|（代）|\s/g, "");

/** 用醫師名找門診。沒指定院區 / 時段時，查 SEARCH_HOSPITALS 的所有時段（目前時段優先） */
async function search(ctx, { hosp, ampm, doctor }) {
  const hosps = hosp ? [hosp] : searchHospitals(ctx.env);
  const cur = currentAmpm(ctx.now);
  const ampms = ampm ? [ampm] : [cur, ...[1, 2, 3].filter((p) => p !== cur)];
  const combos = hosps.flatMap((h) => ampms.map((p) => [h, p]));
  const settled = await Promise.allSettled(combos.map(([h, p]) => getTable(ctx, h, p)));

  const q = normName(doctor);
  const matches = [];
  const errors = [];
  settled.forEach((r, i) => {
    const [h, p] = combos[i];
    if (r.status === "rejected") return errors.push(`${hospitalName(h)}${AMPM[p]}：${r.reason.message}`);
    for (const c of r.value.clinics) if (normName(c.doctor).includes(q)) matches.push({ ...c, hosp: h, ampm: p });
  });
  return { matches, errors, hosps, ampms };
}

const where = (c) => `${hospitalName(c.hosp)} ${AMPM[c.ampm]} ${c.room}`;
const status = (c) => (c.number === null ? "尚未開始看診" : `目前 ${c.number} 號`) + (c.note ? `（${c.note}）` : "");
const pickLabel = (c) => `${hospitalName(c.hosp).slice(0, 2)}${AMPM[c.ampm]} ${c.room} ${c.doctor}`;

function notFound(doctor, { errors, hosps, ampms }) {
  const scope = `${hosps.map(hospitalName).join("、")}（${ampms.map((p) => AMPM[p]).join("、")}）`;
  const lines = [`🔍 今天在 ${scope} 找不到「${doctor}」的門診。`];
  if (errors.length) lines.push("", "⚠️ 部分查詢失敗：", ...errors);
  lines.push("", "可以指定院區，例如：追蹤 25 總院 醫師名", "或輸入「追蹤」用按鈕選");
  return lines.join("\n");
}

async function lookup(cmd, ctx) {
  const res = await search(ctx, cmd);
  if (!res.matches.length) return notFound(cmd.doctor, res);
  const lines = res.matches.map((c) => `${c.doctor}｜${where(c)}\n  ${status(c)}`);
  const quick = res.matches.map((c) =>
    quickPostback(`追蹤 ${pickLabel(c)}`, { a: "s", h: c.hosp, p: c.ampm, s: c.sid }, `追蹤 ${c.doctor} ${c.room}`));
  return textMsg(["🔎 目前燈號", "", ...lines].join("\n"), quick);
}

// ───────────────────────── 新增追蹤 ─────────────────────────

async function addByDoctor(cmd, ctx) {
  const res = await search(ctx, cmd);
  if (!res.matches.length) return notFound(cmd.doctor, res);

  if (res.matches.length === 1) {
    const c = res.matches[0];
    if (cmd.number) return addTracking(ctx, { hosp: c.hosp, ampm: c.ampm, sid: c.sid, number: cmd.number });
    return askNumber(ctx, c, null);
  }
  // 同一位醫師今天有好幾診：用按鈕選
  const quick = res.matches.map((c) =>
    quickPostback(pickLabel(c), { a: "s", h: c.hosp, p: c.ampm, s: c.sid, n: cmd.number }, `選擇 ${c.doctor} ${where(c)}`));
  const lines = res.matches.map((c) => `・${where(c)} ${c.doctor}｜${status(c)}`);
  return textMsg([`找到 ${res.matches.length} 診，請選擇：`, ...lines].join("\n"), quick);
}

async function addByUrl(cmd, ctx) {
  const info = parseDetailUrl(cmd.url);
  if (!info || info.host !== new URL(baseUrl(ctx.env)).hostname) {
    return "❌ 請貼臺大醫院的燈號頁網址（含 ServiceIDSE=…）";
  }
  const cur = currentAmpm(ctx.now);
  for (const p of [cur, ...[1, 2, 3].filter((x) => x !== cur)]) {
    let table;
    try {
      table = await getTable(ctx, info.hosp, p);
    } catch {
      continue;
    }
    const c = table.clinics.find((x) => x.sid === info.sid);
    if (!c) continue;
    const clinic = { ...c, hosp: info.hosp, ampm: p };
    if (cmd.number) return addTracking(ctx, { hosp: info.hosp, ampm: p, sid: info.sid, number: cmd.number, label: cmd.label });
    return askNumber(ctx, clinic, cmd.label);
  }
  return "❌ 今天的看診列表中找不到這一診（網址可能不是今天的）";
}

/** 按鈕流程：院區 → 時段 → 診 */
async function guide(cmd, ctx) {
  const n = cmd.number ?? undefined;
  if (!cmd.hosp) {
    const quick = HOSPITALS.map((h) => quickPostback(h.name, { a: "h", h: h.code, n }, h.name));
    return textMsg("🏥 請選擇院區\n（也可以直接輸入：追蹤 25 醫師名）", quick);
  }
  if (!cmd.ampm) {
    const cur = currentAmpm(ctx.now);
    const quick = [1, 2, 3].map((p) =>
      quickPostback(`${AMPM[p]}${p === cur ? "（現在）" : ""}`, { a: "p", h: cmd.hosp, p, n }, `${hospitalName(cmd.hosp)} ${AMPM[p]}`));
    return textMsg(`${hospitalName(cmd.hosp)}：請選擇時段`, quick);
  }
  const table = await getTable(ctx, cmd.hosp, cmd.ampm);
  if (!table.clinics.length) return `${hospitalName(cmd.hosp)} ${AMPM[cmd.ampm]} 目前查不到門診。`;
  return clinicsFlex(table.clinics, cmd.hosp, cmd.ampm, n);
}

function clinicsFlex(clinics, hosp, ampm, n) {
  const PER = 10;
  const list = clinics.slice(0, PER * 12); // carousel 最多 12 頁
  const pages = [];
  for (let i = 0; i < list.length; i += PER) pages.push(list.slice(i, i + PER));
  const head = `${hospitalName(hosp)} ${AMPM[ampm]}`;
  const bubbles = pages.map((page, i) => ({
    type: "bubble",
    size: "kilo",
    header: {
      type: "box", layout: "vertical", paddingBottom: "sm",
      contents: [
        { type: "text", text: head, weight: "bold", size: "md" },
        { type: "text", text: `第 ${i + 1}/${pages.length} 頁・右側為目前燈號・※ 依報到順序`, size: "xxs", color: "#888888", wrap: true },
      ],
    },
    body: {
      type: "box", layout: "vertical", spacing: "xs", paddingTop: "none",
      contents: page.map((c) => ({
        type: "button", style: "secondary", height: "sm",
        action: {
          type: "postback",
          label: `${c.room} ${c.doctor} ${c.number ?? "－"}${c.byCheckin ? " ※" : ""}`.slice(0, 40),
          data: JSON.stringify({ a: "s", h: hosp, p: ampm, s: c.sid, n }),
          displayText: `選擇 ${c.room} ${c.doctor}`,
        },
      })),
    },
  }));
  const more = clinics.length > list.length ? `（只列前 ${list.length} 診，其餘請用醫師名搜尋）` : "";
  return [
    { type: "flex", altText: `${head} 共 ${clinics.length} 診，請選擇`, contents: { type: "carousel", contents: bubbles } },
    `👆 ${head} 共 ${clinics.length} 診，左右滑動選擇${more}`,
  ];
}

async function onPostback(d, ctx) {
  if (d.a === "h") return guide({ hosp: d.h, number: d.n }, ctx);
  if (d.a === "p") return guide({ hosp: d.h, ampm: d.p, number: d.n }, ctx);
  if (d.a === "photo") return photoAsk(Number(d.id), ctx);
  if (d.a === "hint") return HINTS[d.k] ?? null;
  if (d.a === "undo" && Array.isArray(d.ids) && d.ids.length) {
    const ids = d.ids.map(Number).filter(Number.isInteger).slice(0, 20);
    const marks = ids.map(() => "?").join(",");
    const { results: rows } = await ctx.env.DB.prepare(`SELECT image_key FROM notes WHERE chat_id = ? AND id IN (${marks})`)
      .bind(ctx.chatId, ...ids).all();
    await deleteImages(ctx.env, rows);
    const r = await ctx.env.DB.prepare(`DELETE FROM notes WHERE chat_id = ? AND id IN (${marks})`).bind(ctx.chatId, ...ids).run();
    return r.meta.changes ? "↩️ 已撤銷" : "已經刪除或完成了";
  }
  if (d.a === "s") {
    if (d.n) return addTracking(ctx, { hosp: d.h, ampm: d.p, sid: d.s, number: d.n });
    const c = await findClinic(ctx, d.h, d.p, d.s);
    if (!c) return "❌ 今天的列表中找不到這一診";
    return askNumber(ctx, { ...c, hosp: d.h, ampm: d.p }, null);
  }
  return null;
}

/** 選好診但還不知道號碼：記下來，等同一個人回覆號碼 */
async function askNumber(ctx, c, label) {
  await ctx.env.DB.prepare(
    `INSERT OR REPLACE INTO pending (chat_id, user_id, hosp, ampm, service_id, label, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(ctx.chatId, ctx.userId, c.hosp, c.ampm, c.sid, label, ctx.now + PENDING_TTL).run();
  return `👨‍⚕️ ${c.doctor}｜${where(c)}\n${status(c)}\n\n請輸入你的號碼（例如 25）`;
}

async function answerNumber(number, ctx) {
  const p = await ctx.env.DB.prepare("SELECT * FROM pending WHERE chat_id = ? AND user_id = ?")
    .bind(ctx.chatId, ctx.userId).first();
  if (!p || p.expires_at < ctx.now) return null; // 沒有待填號碼：一般數字訊息不理會
  await ctx.env.DB.prepare("DELETE FROM pending WHERE chat_id = ? AND user_id = ?").bind(ctx.chatId, ctx.userId).run();
  if (number <= 0) return "號碼必須大於 0";
  return addTracking(ctx, { hosp: p.hosp, ampm: p.ampm, sid: p.service_id, number, label: p.label });
}

async function addTracking(ctx, { hosp, ampm, sid, number, label = null }) {
  const c = await findClinic(ctx, hosp, ampm, sid);
  if (!c) return "❌ 今天的列表中找不到這一診";
  const clinic = { ...c, hosp, ampm };

  const rows = await activeRows(ctx);
  if (rows.length >= MAX_ACTIVE_PER_CHAT) return `❌ 最多同時追蹤 ${MAX_ACTIVE_PER_CHAT} 筆，請先取消一些`;
  const dup = rows.find((r) => r.service_id === sid && r.my_number === number);
  if (dup) return `ℹ️ 已經在追蹤了：${title(dup)}，${number} 號`;
  // 依報到順序的診不照號碼叫，不用號碼大小擋
  if (!c.byCheckin && c.number !== null && c.number >= number) {
    return c.number === number
      ? `🔔 ${c.doctor}｜${where(clinic)} 目前燈號就是你的 ${number} 號，請直接到診間（不需要追蹤）`
      : `⚠️ ${c.doctor}｜${where(clinic)} 目前燈號 ${c.number} 已超過你的 ${number} 號，請盡速到診間報到（沒有加入追蹤）`;
  }

  let detail = null;
  try {
    detail = await getDetail(ctx, hosp, sid);
  } catch (e) {
    console.warn("燈號頁讀取失敗", e.message);
  }
  const ci = initialCheckin(detail, number);

  // 加入時的回覆已經告知剩幾號：已跨過的門檻視為通知過，避免下一分鐘重複推播
  const remaining = c.byCheckin
    ? (ci.state === "approx" ? ci.ahead.length : Infinity)
    : c.number === null ? Infinity : number - c.number;
  const sent = loadConfig(ctx.env).thresholds.filter((th) => remaining <= th).join(",");

  const res = await ctx.env.DB.prepare(
    `INSERT INTO trackings (chat_id, url, my_number, label, hosp, ampm, service_id, doctor, room,
       last_number, sent, by_checkin, checkin_state, ahead, ahead_left,
       fail_count, fail_alerted, drop_alerted, created_at, next_check_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
  ).bind(ctx.chatId, detailUrl(baseUrl(ctx.env), hosp, sid), number, label, hosp, ampm, sid, c.doctor, c.room,
    c.number, sent, c.byCheckin ? 1 : 0, ci.state, ci.ahead ? JSON.stringify(ci.ahead) : null,
    ci.ahead ? ci.ahead.length : null, ctx.now, ctx.now + 55_000).run();
  const row = { id: res.meta.last_row_id, doctor: c.doctor, room: c.room, hosp, ampm, label };

  const lines = [`✅ 已加入追蹤 ${title(row)}`, `你的號碼：${number}`];
  lines.push(c.number === null ? "目前尚未開始看診，開始後會通知"
    : c.byCheckin ? `目前燈號：${c.number}` : `目前燈號：${c.number}（還有 ${number - c.number} 號）`);
  if (ci.state === "no") lines.push(c.byCheckin ? "你目前：未報到（報到後開始計算前面還有幾位）" : "你目前：未報到");
  if (ci.state === "approx") {
    lines.push(c.byCheckin
      ? `你目前：已報到，前面最多 ${ci.ahead.length} 位（加入前就已報到，無法確定先後）`
      : "你目前：已報到");
  }
  if (c.byCheckin) lines.push("", "ℹ️ 此診依報到順序看診：會依「誰比你先報到」計算前面還有幾位，請盡早報到");
  const { results: bring } = await ctx.env.DB.prepare("SELECT text FROM notes WHERE chat_id = ? AND category = 'bring' ORDER BY id")
    .bind(ctx.chatId).all();
  if (bring.length) lines.push("", `🎒 記得帶：${bring.map((n) => n.text).join("、")}`);
  if (!label) lines.push("", `加備註：備註 ${row.id} 內容`);
  return lines.join("\n");
}

// ───────────────────────── 列表 / 取消 ─────────────────────────

async function activeRows(ctx) {
  const { results } = await ctx.env.DB.prepare("SELECT * FROM trackings WHERE chat_id = ? ORDER BY id").bind(ctx.chatId).all();
  return results;
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false });
}

async function listReply(ctx) {
  const rows = await activeRows(ctx);
  if (!rows.length) return "目前沒有追蹤中的看診。\n輸入「說明」看用法";
  const lines = [`📋 追蹤中 ${rows.length} 筆`];
  for (const r of rows) {
    const now = r.last_number === null ? "尚未開始看診" : `目前 ${r.last_number} 號`;
    let s;
    if (r.by_checkin) {
      s = r.checkin_state === "yes" || r.checkin_state === "approx"
        ? `${now}，已報到，前面${r.checkin_state === "approx" ? "最多" : "還有"} ${r.ahead_left ?? "?"} 位`
        : `${now}，未報到`;
    } else {
      s = r.last_number === null ? now : `${now}，剩 ${Math.max(r.my_number - r.last_number, 0)} 號`;
      if (r.checkin_state === "no") s += "，未報到";
    }
    const warn = (r.by_checkin ? "（依報到順序）" : "") + (r.fail_alerted ? "（⚠️ 讀取異常）" : "");
    lines.push("", title(r), `  你是 ${r.my_number} 號｜${s}${warn}｜${fmtTime(r.created_at)} 加入`);
  }
  const quick = rows.map((r) => quickText(`取消 #${r.id}`, `取消 ${r.id}`));
  return textMsg(lines.join("\n"), quick);
}

async function cancel(cmd, ctx) {
  const db = ctx.env.DB;
  if (cmd.all) {
    const r = await db.prepare("DELETE FROM trackings WHERE chat_id = ?").bind(ctx.chatId).run();
    return r.meta.changes ? `🗑 已取消全部 ${r.meta.changes} 筆追蹤` : "目前沒有追蹤中的看診";
  }
  const row = await db.prepare("SELECT * FROM trackings WHERE id = ? AND chat_id = ?").bind(cmd.id, ctx.chatId).first();
  if (!row) return `找不到 #${cmd.id}，輸入「列表」查看編號`;
  await db.prepare("DELETE FROM trackings WHERE id = ?").bind(cmd.id).run();
  return `🗑 已取消 ${title(row)}，${row.my_number} 號`;
}

// ───────────────────────── 選單卡片 ─────────────────────────

const HINTS = {
  lookup: textMsg("🔎 直接輸入「燈號 醫師名」\n例：燈號 戴季珊"),
  track: textMsg("🩺 直接輸入「追蹤 號碼 醫師名」最快\n例：追蹤 25 戴季珊\n\n或用按鈕一步一步選：", [quickText("用按鈕選", "追蹤")]),
  note: textMsg([
    "✏️ 直接打字就能記：",
    "　帶保鮮盒、買麵、買晚餐",
    "　記得帶健保卡",
    "　記得繳停車費",
    "",
    "記下後可以按「📷 附圖」加照片",
  ].join("\n")),
};

// 配色：天空藍、白、項圈紅、鈴鐺黃
const THEME = {
  blue: "#0A9FE8",
  blueDark: "#0577B8",
  blueSoft: "#E3F4FD",
  red: "#E60033",
  yellow: "#FFD400",
  ink: "#12324A",
  muted: "#5B7A90",
};

async function menuCard(ctx) {
  const db = ctx.env.DB;
  const [t, n] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS c FROM trackings WHERE chat_id = ?").bind(ctx.chatId).first(),
    db.prepare("SELECT COUNT(*) AS c FROM notes WHERE chat_id = ?").bind(ctx.chatId).first(),
  ]);

  const btn = (label, action, primary = false) => ({
    type: "button", height: "sm", flex: 1,
    style: primary ? "primary" : "secondary",
    color: primary ? THEME.blue : THEME.blueSoft,
    action: { label, ...action },
  });
  const msg = (label, text, primary) => btn(label, { type: "message", text }, primary);
  const hint = (label, k, primary) => btn(label, { type: "postback", data: JSON.stringify({ a: "hint", k }), displayText: label }, primary);
  const row = (...buttons) => ({ type: "box", layout: "horizontal", spacing: "sm", contents: buttons });
  const badge = (text) => ({
    type: "box", layout: "vertical", backgroundColor: THEME.yellow, cornerRadius: "xl",
    paddingStart: "md", paddingEnd: "md", paddingTop: "2px", paddingBottom: "2px", flex: 0,
    contents: [{ type: "text", text, size: "xxs", color: THEME.ink, weight: "bold" }],
  });
  const section = (title, badgeText) => ({
    type: "box", layout: "horizontal", margin: "lg", alignItems: "center",
    contents: [
      { type: "text", text: title, weight: "bold", size: "sm", color: THEME.ink, flex: 1 },
      badge(badgeText),
    ],
  });

  const bubble = {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box", layout: "vertical", paddingAll: "none", backgroundColor: THEME.blue,
      contents: [
        {
          type: "box", layout: "horizontal", paddingAll: "md", alignItems: "center",
          contents: [
            {
              type: "box", layout: "vertical", flex: 1,
              contents: [
                { type: "text", text: "☰ 選單", weight: "bold", size: "lg", color: "#FFFFFF" },
                { type: "text", text: "點按鈕操作，也可以直接打字", size: "xxs", color: "#D6F0FF" },
              ],
            },
            // 黃色鈴鐺
            { type: "box", layout: "vertical", width: "18px", height: "18px", cornerRadius: "xxl",
              backgroundColor: THEME.yellow, borderColor: "#C9A400", borderWidth: "1px", contents: [{ type: "filler" }] },
          ],
        },
        // 紅色項圈
        { type: "box", layout: "vertical", height: "6px", backgroundColor: THEME.red, contents: [{ type: "filler" }] },
      ],
    },
    body: {
      type: "box", layout: "vertical", spacing: "sm", paddingTop: "sm",
      contents: [
        section("🩺 看診", t.c ? `追蹤中 ${t.c} 筆` : "沒有追蹤"),
        row(hint("追蹤看診", "track", true), msg("追蹤列表", "列表")),
        row(hint("查燈號", "lookup"), msg("說明", "說明")),
        { type: "separator", margin: "lg", color: THEME.blueSoft },
        section("📝 記事", n.c ? `${n.c} 筆` : "空的"),
        row(msg("看記事", "記事", true), hint("記一筆", "note")),
      ],
    },
    styles: { header: { separator: false } },
  };
  return { type: "flex", altText: `☰ 選單（追蹤中 ${t.c} 筆、記事 ${n.c} 筆）`, contents: bubble };
}

// ───────────────────────── 記事本 / 備註 ─────────────────────────

const MAX_NOTES_PER_CHAT = 100;
const catOf = (key) => NOTE_CATEGORIES.find((c) => c.key === key) ?? NOTE_CATEGORIES.at(-1);

async function notesReply(ctx, header = null, extraQuick = []) {
  const { results } = await ctx.env.DB.prepare("SELECT * FROM notes WHERE chat_id = ? ORDER BY id").bind(ctx.chatId).all();
  if (!results.length) {
    return [header, "📝 記事本是空的。", "新增：記 買 尿布、牛奶　/　記 帶 健保卡　/　記 做 繳費"].filter(Boolean).join("\n");
  }
  const lines = header ? [header, ""] : [];
  lines.push(`📝 記事（${results.length}）`);
  for (const c of NOTE_CATEGORIES) {
    const items = results.filter((n) => n.category === c.key);
    if (!items.length) continue;
    lines.push("", `${c.icon} ${c.name}`, ...items.map((n) => `  #${n.id} ${n.text}${n.image_key ? " 📷" : ""}`));
  }
  lines.push("", "完成：完成 編號（可多筆）");
  const quick = [
    ...extraQuick,
    ...results.filter((n) => n.image_key).map((n) => quickText(`🖼 看圖 #${n.id} ${n.text}`, `看圖 ${n.id}`)),
    ...results.map((n) => quickText(`完成 #${n.id} ${n.text}`, `完成 ${n.id}`)),
  ];
  return textMsg(lines.join("\n"), quick);
}

async function noteAdd(cmd, ctx) {
  const db = ctx.env.DB;
  const entries = cmd.entries ?? cmd.items.map((text) => ({ category: cmd.category, text }));
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM notes WHERE chat_id = ?").bind(ctx.chatId).first()).n;
  if (count + entries.length > MAX_NOTES_PER_CHAT) return `❌ 記事最多 ${MAX_NOTES_PER_CHAT} 筆，請先完成一些`;
  const results = await db.batch(entries.map((e) =>
    db.prepare("INSERT INTO notes (chat_id, category, text, created_at) VALUES (?, ?, ?, ?)").bind(ctx.chatId, e.category, e.text, ctx.now)));

  // 依分類整理：「🎒 帶：保鮮盒｜🛒 買：麵、晚餐」
  const parts = NOTE_CATEGORIES
    .map((c) => ({ c, texts: entries.filter((e) => e.category === c.key).map((e) => e.text) }))
    .filter((x) => x.texts.length)
    .map(({ c, texts }) => `${c.icon} ${c.name}：${texts.join("、")}`);
  const head = `已記下 ${parts.join("｜")}`;
  const ids = results.map((r) => r.meta.last_row_id);
  // 附圖按鈕：一次記多項時，每項各一個（快速回覆最多 13 個）
  const photoQuick = ids.slice(0, 8).map((id, i) =>
    quickPostback(ids.length > 1 ? `📷 ${entries[i].text}` : "📷 附圖", { a: "photo", id }, `附圖給「${entries[i].text}」`));
  if (!cmd.natural) return notesReply(ctx, head, photoQuick);

  // 口語觸發：簡短回覆，附「撤銷」按鈕（萬一是誤記）
  return textMsg(head, [
    quickPostback("↩️ 撤銷", { a: "undo", ids }, "撤銷"),
    ...photoQuick,
    quickText("📝 看記事", "記事"),
  ]);
}

async function noteDone(cmd, ctx) {
  const db = ctx.env.DB;
  const marks = cmd.ids.map(() => "?").join(",");
  const { results } = await db.prepare(`SELECT * FROM notes WHERE chat_id = ? AND id IN (${marks})`).bind(ctx.chatId, ...cmd.ids).all();
  if (!results.length) return `找不到 ${cmd.ids.map((i) => `#${i}`).join("、")}，輸入「記事」查看編號`;
  await deleteImages(ctx.env, results);
  await db.prepare(`DELETE FROM notes WHERE chat_id = ? AND id IN (${marks})`).bind(ctx.chatId, ...cmd.ids).run();
  return notesReply(ctx, `✔️ 完成：${results.map((n) => n.text).join("、")}`);
}

async function noteClear(cmd, ctx) {
  const db = ctx.env.DB;
  const { results: withImg } = cmd.category
    ? await db.prepare("SELECT image_key FROM notes WHERE chat_id = ? AND category = ? AND image_key IS NOT NULL").bind(ctx.chatId, cmd.category).all()
    : await db.prepare("SELECT image_key FROM notes WHERE chat_id = ? AND image_key IS NOT NULL").bind(ctx.chatId).all();
  await deleteImages(ctx.env, withImg);
  const r = cmd.category
    ? await db.prepare("DELETE FROM notes WHERE chat_id = ? AND category = ?").bind(ctx.chatId, cmd.category).run()
    : await db.prepare("DELETE FROM notes WHERE chat_id = ?").bind(ctx.chatId).run();
  const what = cmd.category ? `「${catOf(cmd.category).name}」` : "全部記事";
  return r.meta.changes ? `🗑 已清空${what}（${r.meta.changes} 筆）` : `${what}本來就是空的`;
}

// ── 記事附圖 ──

const PHOTO_TTL = 5 * 60_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function photoAsk(id, ctx) {
  const note = await ctx.env.DB.prepare("SELECT * FROM notes WHERE id = ? AND chat_id = ?").bind(id, ctx.chatId).first();
  if (!note) return `找不到記事 #${id}，輸入「記事」查看編號`;
  if (!ctx.env.IMAGES) return "❌ 附圖功能尚未設定（wrangler.toml 缺少 IMAGES 的 KV 設定）";
  await ctx.env.DB.prepare("INSERT OR REPLACE INTO pending_photo (chat_id, user_id, note_id, expires_at) VALUES (?, ?, ?, ?)")
    .bind(ctx.chatId, ctx.userId, id, ctx.now + PHOTO_TTL).run();
  return textMsg(`📷 請在 5 分鐘內傳一張照片給「${note.text}」`, [quickCamera(), quickCameraRoll()]);
}

async function onImage(cmd, ctx) {
  const db = ctx.env.DB;
  const p = await db.prepare("SELECT * FROM pending_photo WHERE chat_id = ? AND user_id = ?").bind(ctx.chatId, ctx.userId).first();
  if (!p || p.expires_at < ctx.now) return null; // 一般照片：不理會
  await db.prepare("DELETE FROM pending_photo WHERE chat_id = ? AND user_id = ?").bind(ctx.chatId, ctx.userId).run();
  const note = await db.prepare("SELECT * FROM notes WHERE id = ? AND chat_id = ?").bind(p.note_id, ctx.chatId).first();
  if (!note) return "這筆記事已經不在了";

  const orig = await getContent(ctx.env, cmd.messageId);
  if (orig.body.byteLength > MAX_IMAGE_BYTES) return "❌ 圖片太大（上限 10MB）";
  let prev = orig;
  try {
    prev = await getContent(ctx.env, cmd.messageId, true);
  } catch {
    // 沒有預覽圖就用原圖
  }
  const key = crypto.randomUUID().replace(/-/g, "");
  await ctx.env.IMAGES.put(`img:${key}`, orig.body, { metadata: { type: orig.type } });
  await ctx.env.IMAGES.put(`img:${key}_p`, prev.body, { metadata: { type: prev.type } });
  if (note.image_key) await deleteImages(ctx.env, [note]);
  await db.prepare("UPDATE notes SET image_key = ? WHERE id = ?").bind(key, note.id).run();
  return textMsg(`📷 已附圖：#${note.id} ${note.text}`, [quickText("🖼 看圖", `看圖 ${note.id}`), quickText("📝 看記事", "記事")]);
}

async function photoShow(id, ctx) {
  const note = await ctx.env.DB.prepare("SELECT * FROM notes WHERE id = ? AND chat_id = ?").bind(id, ctx.chatId).first();
  if (!note) return `找不到記事 #${id}`;
  if (!note.image_key) return textMsg(`#${id} ${note.text} 還沒有附圖`, [quickPostback("📷 附圖", { a: "photo", id }, `附圖給「${note.text}」`)]);
  return [
    `🖼 #${note.id} ${note.text}`,
    imageMsg(`${ctx.origin}/img/${note.image_key}`, `${ctx.origin}/img/${note.image_key}_p`),
  ];
}

async function deleteImages(env, rows) {
  if (!env.IMAGES) return;
  await Promise.allSettled(rows.filter((r) => r.image_key).flatMap((r) =>
    [env.IMAGES.delete(`img:${r.image_key}`), env.IMAGES.delete(`img:${r.image_key}_p`)]));
}

async function serveImage(env, key) {
  if (!env.IMAGES) return new Response("Not found", { status: 404 });
  const { value, metadata } = await env.IMAGES.getWithMetadata(`img:${key}`, { type: "arrayBuffer" });
  if (!value) return new Response("Not found", { status: 404 });
  return new Response(value, {
    headers: { "Content-Type": metadata?.type ?? "image/jpeg", "Cache-Control": "private, max-age=86400" },
  });
}

async function setLabel(cmd, ctx) {
  const row = await ctx.env.DB.prepare("SELECT * FROM trackings WHERE id = ? AND chat_id = ?").bind(cmd.id, ctx.chatId).first();
  if (!row) return `找不到追蹤 #${cmd.id}，輸入「列表」查看編號`;
  await ctx.env.DB.prepare("UPDATE trackings SET label = ? WHERE id = ?").bind(cmd.text, cmd.id).run();
  const updated = { ...row, label: cmd.text };
  return cmd.text ? `📝 已加上備註：${title(updated)}\n之後的通知都會顯示這段備註` : `已清除 #${cmd.id} 的備註`;
}

// ───────────────────────── 排程 ─────────────────────────

export async function tick(env, now) {
  const cfg = loadConfig(env);
  await env.DB.prepare("DELETE FROM pending WHERE expires_at < ?").bind(now).run();
  await env.DB.prepare("DELETE FROM pending_photo WHERE expires_at < ?").bind(now).run();
  const { results } = await env.DB.prepare(
    "SELECT * FROM trackings WHERE next_check_at <= ? ORDER BY next_check_at LIMIT ?",
  ).bind(now, MAX_PER_TICK).all();
  if (!results.length) return;

  // 同院區同時段只抓一次列表
  const ctx = { env, now, tables: new Map() };
  const settled = await Promise.allSettled(results.map((row) => checkOne(row, cfg, ctx)));

  // 同一個群組在同一分鐘的通知合併成一則推播，節省額度
  const byChat = new Map();
  settled.forEach((s, i) => {
    if (s.status === "rejected") return console.error(`tracking #${results[i].id}:`, s.reason);
    if (!s.value.length) return;
    const chat = results[i].chat_id;
    byChat.set(chat, [...(byChat.get(chat) ?? []), ...s.value]);
  });
  // 快輪到時（剩 5 以內、預計叫號、輪到了），附上「帶」的記事
  for (const [chat, msgs] of byChat) {
    if (!msgs.some((m) => /🟠|🔴|預計叫號|輪到了/.test(m))) continue;
    const { results: bring } = await env.DB.prepare("SELECT text FROM notes WHERE chat_id = ? AND category = 'bring' ORDER BY id")
      .bind(chat).all();
    if (bring.length) msgs.push(`🎒 記得帶：${bring.map((n) => n.text).join("、")}`);
  }
  await Promise.allSettled([...byChat].map(([chat, msgs]) => push(env, chat, msgs)));
}

const merge = (a, b) => ({ ...a, ...b, update: { ...a.update, ...b.update }, messages: [...a.messages, ...b.messages] });

/** 依列表 + 個別燈號頁判斷一筆追蹤 */
async function evaluate(row, c, cfg, ctx) {
  let d = null;
  try {
    d = await getDetail(ctx, row.hosp, row.service_id);
  } catch (e) {
    console.warn(`#${row.id} 燈號頁讀取失敗，改用號碼判斷：${e.message}`);
  }

  if (d && c.byCheckin) {
    const r = onDetail(row, d, true, cfg, ctx.now);
    if (r.handled) {
      // 報到順序模式：補上「改為依報到順序」提醒與讀取恢復
      const head = { update: { fail_count: 0, fail_alerted: 0 }, messages: [] };
      if (!row.by_checkin) {
        head.update.by_checkin = 1;
        head.messages.push(`ℹ️ ${title(row)}｜${CHECKIN_NOTE}`);
      }
      if (row.fail_alerted) head.messages.push(`✅ ${title(row)}｜恢復讀取`);
      return merge(head, r);
    }
    return merge(r, onReading(row, c.number, cfg, ctx.now, true));
  }

  const base = onReading(row, c.number, cfg, ctx.now, c.byCheckin);
  if (!d || base.done) return base;
  const extra = onDetail(row, d, false, cfg, ctx.now);
  return { ...base, update: { ...extra.update, ...base.update }, messages: [...base.messages, ...extra.messages] };
}

/** 檢查一筆追蹤，更新資料庫，回傳要推播的訊息 */
async function checkOne(row, cfg, ctx) {
  const db = ctx.env.DB;
  if (!row.service_id || isExpired(row, cfg, ctx.now)) {
    await db.prepare("DELETE FROM trackings WHERE id = ?").bind(row.id).run();
    return [row.service_id
      ? `⏹ ${title(row)}｜已追蹤超過 ${cfg.maxHours} 小時，自動移除（最後燈號 ${row.last_number ?? "未知"}，你是 ${row.my_number} 號）`
      : `⏹ #${row.id}｜舊版追蹤資料，已移除，請重新追蹤`];
  }

  let result;
  try {
    const c = await findClinic(ctx, row.hosp, row.ampm, row.service_id);
    if (c?.fromDetail) c.byCheckin = !!row.by_checkin; // 燈號頁沒有這個標示：沿用上次列表的判斷
    result = c ? await evaluate(row, c, cfg, ctx) : onFailure(row, cfg, ctx.now, "列表中找不到這一診");
  } catch (e) {
    result = onFailure(row, cfg, ctx.now, e.message);
  }

  if (result.done) {
    await db.prepare("DELETE FROM trackings WHERE id = ?").bind(row.id).run();
  } else {
    const keys = Object.keys(result.update);
    if (keys.length) {
      await db.prepare(`UPDATE trackings SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
        .bind(...keys.map((k) => result.update[k]), row.id).run();
    }
  }
  return result.messages;
}

// 測試用
export const __menuCardForTest = (ctx) => menuCard(ctx);
