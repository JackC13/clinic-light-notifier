// 看診燈號 LINE 機器人（Cloudflare Worker，臺大醫院）
//   fetch     : 接收 LINE webhook，處理群組指令與按鈕
//   scheduled : 每分鐘檢查到期的追蹤，抓燈號、推播

import { parseCommand, HELP } from "./commands.js";
import { verifySignature, reply, push, textMsg, quickPostback, quickText } from "./line.js";
import {
  HOSPITALS, AMPM, hospitalName, currentAmpm, fetchTable, parseDetailUrl, detailUrl, baseUrl,
} from "./ntuh.js";
import { loadConfig, onReading, onFailure, isExpired, title, CHECKIN_NOTE } from "./monitor.js";

const MAX_ACTIVE_PER_CHAT = 10;
const MAX_PER_TICK = 30;
const PENDING_TTL = 10 * 60_000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("clinic-light-bot OK");
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
    ctx.waitUntil(Promise.allSettled(events.map((e) => handleEvent(e, env))));
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

async function handleEvent(event, env) {
  const src = event.source ?? {};
  const chatId = src.groupId ?? src.roomId ?? src.userId;
  if (!chatId || !event.replyToken) return;

  let cmd = null;
  if (event.type === "message" && event.message?.type === "text") cmd = parseCommand(event.message.text);
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
    if (cmd.cmd === "number") return;
    return reply(env, event.replyToken,
      `🔒 尚未設定授權聊天室。\n這個聊天室的 ID：\n${chatId}\n請加到 ALLOWED_CHAT_IDS 後重新部署。`);
  }
  if (!allowed.includes(chatId)) return;

  const ctx = { env, chatId, userId: src.userId ?? "", now: Date.now(), tables: new Map() };
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
    case "help": return HELP;
    case "usage": return `❓ ${cmd.reason}\n\n輸入「說明」看完整用法`;
    case "list": return listReply(ctx);
    case "cancel": return cancel(cmd, ctx);
    case "lookup": return lookup(cmd, ctx);
    case "add": return addByDoctor(cmd, ctx);
    case "guide": return guide(cmd, ctx);
    case "addUrl": return addByUrl(cmd, ctx);
    case "number": return answerNumber(cmd.number, ctx);
    case "postback": return onPostback(cmd.data, ctx);
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
  if (d.a === "s") {
    if (d.n) return addTracking(ctx, { hosp: d.h, ampm: d.p, sid: d.s, number: d.n });
    const table = await getTable(ctx, d.h, d.p);
    const c = table.clinics.find((x) => x.sid === d.s);
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
  const table = await getTable(ctx, hosp, ampm);
  const c = table.clinics.find((x) => x.sid === sid);
  if (!c) return "❌ 今天的列表中找不到這一診";
  const clinic = { ...c, hosp, ampm };

  const rows = await activeRows(ctx);
  if (rows.length >= MAX_ACTIVE_PER_CHAT) return `❌ 最多同時追蹤 ${MAX_ACTIVE_PER_CHAT} 筆，請先取消一些`;
  const dup = rows.find((r) => r.service_id === sid && r.my_number === number);
  if (dup) return `ℹ️ 已經在追蹤了：${title(dup)}，${number} 號`;
  if (c.number !== null && c.number >= number) {
    return `⚠️ ${c.doctor}｜${where(clinic)} 目前燈號 ${c.number}，已經到/超過 ${number} 號，沒有加入追蹤`;
  }

  // 加入時的回覆已經告知剩幾號：已跨過的門檻視為通知過，避免下一分鐘重複推播
  const remaining = c.number === null ? Infinity : number - c.number;
  const sent = loadConfig(ctx.env).thresholds.filter((th) => remaining <= th).join(",");

  const res = await ctx.env.DB.prepare(
    `INSERT INTO trackings (chat_id, url, my_number, label, hosp, ampm, service_id, doctor, room,
       last_number, sent, by_checkin, fail_count, fail_alerted, drop_alerted, created_at, next_check_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
  ).bind(ctx.chatId, detailUrl(baseUrl(ctx.env), hosp, sid), number, label, hosp, ampm, sid, c.doctor, c.room,
    c.number, sent, c.byCheckin ? 1 : 0, ctx.now, ctx.now + 55_000).run();
  const row = { id: res.meta.last_row_id, doctor: c.doctor, room: c.room, hosp, ampm, label };

  const lines = [`✅ 已加入追蹤 ${title(row)}`, `你的號碼：${number}`];
  lines.push(c.number === null ? "目前尚未開始看診，開始後會通知" : `目前燈號：${c.number}（還有 ${number - c.number} 號）`);
  if (c.byCheckin) lines.push("", `ℹ️ ${CHECKIN_NOTE}`);
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
    const s = r.last_number === null ? "尚未開始看診" : `目前 ${r.last_number} 號，剩 ${Math.max(r.my_number - r.last_number, 0)} 號`;
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

// ───────────────────────── 排程 ─────────────────────────

export async function tick(env, now) {
  const cfg = loadConfig(env);
  await env.DB.prepare("DELETE FROM pending WHERE expires_at < ?").bind(now).run();
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
  await Promise.allSettled([...byChat].map(([chat, msgs]) => push(env, chat, msgs)));
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
    const table = await getTable(ctx, row.hosp, row.ampm);
    const c = table.clinics.find((x) => x.sid === row.service_id);
    result = c ? onReading(row, c.number, cfg, ctx.now, c.byCheckin) : onFailure(row, cfg, ctx.now, "列表中找不到這一診");
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
