// 看診燈號 LINE 機器人（Cloudflare Worker）
//   fetch     : 接收 LINE webhook，處理群組指令
//   scheduled : 每分鐘檢查到期的追蹤，抓燈號、推播

import { parseCommand, HELP } from "./commands.js";
import { verifySignature, reply, push } from "./line.js";
import { parseLightNo, digitLines, DEFAULT_REGEX } from "./parser.js";
import { loadConfig, onReading, onFailure, isExpired, title } from "./monitor.js";

const MAX_ACTIVE_PER_CHAT = 10;
const MAX_PER_TICK = 20;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("clinic-light-bot OK");
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

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

// ───────────────────────── 指令 ─────────────────────────

function chatIdOf(source) {
  return source?.groupId ?? source?.roomId ?? source?.userId ?? null;
}

function allowedChats(env) {
  return String(env.ALLOWED_CHAT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function handleEvent(event, env) {
  if (event.type !== "message" || event.message?.type !== "text") return;
  const chatId = chatIdOf(event.source);
  const cmd = parseCommand(event.message.text);
  if (!cmd || !chatId) return;

  const allowed = allowedChats(env);
  if (allowed.length === 0) {
    // 尚未設定白名單：只回報聊天室 ID，方便設定
    return reply(env, event.replyToken,
      `🔒 尚未設定授權聊天室。\n這個聊天室的 ID：\n${chatId}\n請加到 ALLOWED_CHAT_IDS 後重新部署。`);
  }
  if (!allowed.includes(chatId)) return; // 不在白名單：不理會

  const text = await runCommand(cmd, chatId, env, Date.now()).catch((e) => {
    console.error(e);
    return `❌ 發生錯誤：${e.message}`;
  });
  if (text) await reply(env, event.replyToken, text);
}

async function runCommand(cmd, chatId, env, now) {
  switch (cmd.cmd) {
    case "help":
      return HELP;
    case "usage":
      return `❓ ${cmd.reason}\n\n輸入「說明」看完整用法`;
    case "list":
      return listText(await activeRows(env, chatId), env);
    case "cancel":
      return cancel(cmd, chatId, env);
    case "test":
      return testUrl(cmd.url, env);
    case "add":
      return add(cmd, chatId, env, now);
  }
  return null;
}

function checkHost(url, env) {
  let host;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return "只接受 http/https 網址";
    host = u.hostname.toLowerCase();
  } catch {
    return "網址格式不正確";
  }
  const hosts = String(env.ALLOWED_HOSTS ?? "reg.ntuh.gov.tw").split(",").map((s) => s.trim().toLowerCase());
  return hosts.includes(host) ? null : `只接受這些網站的燈號頁：${hosts.join("、")}`;
}

async function add(cmd, chatId, env, now) {
  const hostErr = checkHost(cmd.url, env);
  if (hostErr) return `❌ ${hostErr}`;

  const rows = await activeRows(env, chatId);
  if (rows.length >= MAX_ACTIVE_PER_CHAT) return `❌ 最多同時追蹤 ${MAX_ACTIVE_PER_CHAT} 筆，請先取消一些`;
  const dup = rows.find((r) => r.url === cmd.url && r.my_number === cmd.number);
  if (dup) return `ℹ️ 已經在追蹤了：${title(dup)}（${dup.my_number} 號）`;

  // 先抓一次：確認網址可用，也順便回報目前號碼
  let current = null;
  let fetchErr = null;
  try {
    current = await readCurrent(cmd.url, env);
  } catch (e) {
    fetchErr = e.message;
  }
  if (current !== null && current >= cmd.number) {
    return `⚠️ 目前燈號 ${current} 已經到/超過 ${cmd.number} 號，沒有加入追蹤`;
  }

  const res = await env.DB.prepare(
    `INSERT INTO trackings (chat_id, url, my_number, label, last_number, sent, fail_count, fail_alerted, drop_alerted, created_at, next_check_at)
     VALUES (?, ?, ?, ?, ?, '', 0, 0, 0, ?, ?)`,
  ).bind(chatId, cmd.url, cmd.number, cmd.label, current, now, now + 55_000).run();
  const id = res.meta.last_row_id;
  const t = cmd.label ? `#${id} ${cmd.label}` : `#${id}`;

  const lines = [`✅ 已加入追蹤 ${t}`, `你的號碼：${cmd.number}`];
  if (fetchErr) lines.push(`⚠️ 目前讀不到網頁（${fetchErr}），會持續重試`);
  else if (current === null) lines.push("目前還沒有燈號（可能尚未開診），開診後開始通知");
  else lines.push(`目前燈號：${current}（還有 ${cmd.number - current} 號）`);
  return lines.join("\n");
}

async function cancel(cmd, chatId, env) {
  if (cmd.all) {
    const r = await env.DB.prepare("DELETE FROM trackings WHERE chat_id = ?").bind(chatId).run();
    return r.meta.changes ? `🗑 已取消全部 ${r.meta.changes} 筆追蹤` : "目前沒有追蹤中的看診";
  }
  const row = await env.DB.prepare("SELECT * FROM trackings WHERE id = ? AND chat_id = ?").bind(cmd.id, chatId).first();
  if (!row) return `找不到 #${cmd.id}，輸入「列表」查看編號`;
  await env.DB.prepare("DELETE FROM trackings WHERE id = ?").bind(cmd.id).run();
  return `🗑 已取消 ${title(row)}（${row.my_number} 號）`;
}

async function testUrl(url, env) {
  const hostErr = checkHost(url, env);
  if (hostErr) return `❌ ${hostErr}`;
  try {
    const html = await fetchPage(url);
    const n = parseLightNo(html, env.LIGHT_REGEX || DEFAULT_REGEX);
    if (n !== null) return `✅ 讀得到燈號：目前 ${n} 號`;
    const lines = digitLines(html);
    return ["⚠️ 網頁抓到了，但解析不到燈號（尚未開診，或需要調整解析規則）。", "頁面中含數字的文字：", ...lines].join("\n");
  } catch (e) {
    return `❌ 抓不到網頁：${e.message}`;
  }
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false });
}

function listText(rows) {
  if (!rows.length) return "目前沒有追蹤中的看診。\n輸入「說明」看用法";
  const lines = [`📋 追蹤中 ${rows.length} 筆`];
  for (const r of rows) {
    const status =
      r.last_number === null
        ? "尚未開診"
        : `目前 ${r.last_number} 號，剩 ${Math.max(r.my_number - r.last_number, 0)} 號`;
    const warn = r.fail_alerted ? "（⚠️ 讀取異常）" : "";
    lines.push("", `${title(r)}｜你是 ${r.my_number} 號`, `  ${status}${warn}｜${fmtTime(r.created_at)} 加入`);
  }
  lines.push("", "取消：取消 編號");
  return lines.join("\n");
}

async function activeRows(env, chatId) {
  const { results } = await env.DB.prepare("SELECT * FROM trackings WHERE chat_id = ? ORDER BY id").bind(chatId).all();
  return results;
}

// ───────────────────────── 排程 ─────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
      "Accept-Language": "zh-TW,zh;q=0.9",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function readCurrent(url, env) {
  return parseLightNo(await fetchPage(url), env.LIGHT_REGEX || DEFAULT_REGEX);
}

export async function tick(env, now) {
  const cfg = loadConfig(env);
  const { results } = await env.DB.prepare(
    "SELECT * FROM trackings WHERE next_check_at <= ? ORDER BY next_check_at LIMIT ?",
  ).bind(now, MAX_PER_TICK).all();

  const settled = await Promise.allSettled(results.map((row) => checkOne(row, cfg, env, now)));

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
async function checkOne(row, cfg, env, now) {
  if (isExpired(row, cfg, now)) {
    await env.DB.prepare("DELETE FROM trackings WHERE id = ?").bind(row.id).run();
    return [
      `⏹ ${title(row)}｜已追蹤超過 ${cfg.maxHours} 小時，自動移除（最後燈號 ${row.last_number ?? "未知"}，你是 ${row.my_number} 號）`,
    ];
  }

  let result;
  try {
    result = onReading(row, await readCurrent(row.url, env), cfg, now);
  } catch (e) {
    result = onFailure(row, cfg, now, e.message);
  }

  if (result.done) {
    await env.DB.prepare("DELETE FROM trackings WHERE id = ?").bind(row.id).run();
  } else {
    const keys = Object.keys(result.update);
    if (keys.length) {
      await env.DB.prepare(`UPDATE trackings SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
        .bind(...keys.map((k) => result.update[k]), row.id).run();
    }
  }
  return result.messages;
}
