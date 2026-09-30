// LINE Messaging API：簽章驗證、reply（免費）、push（計入每月額度）

const enc = new TextEncoder();

function apiBase(env) {
  return env.LINE_API_BASE || "https://api.line.me";
}

export async function verifySignature(secret, body, signature) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  const expected = btoa(bin);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function call(env, path, payload) {
  const res = await fetch(apiBase(env) + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`LINE ${path} ${res.status}: ${body}`);
  }
  return res.ok;
}

// LINE 單則文字上限 5000 字
const clip = (t) => (t.length > 4900 ? t.slice(0, 4900) + "…" : t);

/** 文字訊息，可附快速回覆按鈕（最多 13 個） */
export function textMsg(text, quickItems = []) {
  const msg = { type: "text", text: clip(text) };
  if (quickItems.length) msg.quickReply = { items: quickItems.slice(0, 13) };
  return msg;
}

/** 快速回覆：按下後送出 postback（displayText 會以使用者名義顯示在聊天室） */
export function quickPostback(label, data, displayText) {
  return {
    type: "action",
    action: { type: "postback", label: label.slice(0, 20), data: JSON.stringify(data), displayText },
  };
}

/** 快速回覆：按下後直接送出一段文字 */
export function quickText(label, text) {
  return { type: "action", action: { type: "message", label: label.slice(0, 20), text } };
}

/** 回覆使用者：不計入每月推播額度。msgs 可以是字串或訊息物件（最多 5 則） */
export function reply(env, replyToken, msgs) {
  const messages = (Array.isArray(msgs) ? msgs : [msgs])
    .map((m) => (typeof m === "string" ? textMsg(m) : m))
    .slice(0, 5);
  return call(env, "/v2/bot/message/reply", { replyToken, messages });
}

/** 主動推播：計入每月額度（群組按人數計），多則合併成一則送出 */
export function push(env, to, texts) {
  if (!texts.length) return Promise.resolve(true);
  return call(env, "/v2/bot/message/push", {
    to,
    messages: [{ type: "text", text: clip(texts.join("\n")) }],
  });
}
