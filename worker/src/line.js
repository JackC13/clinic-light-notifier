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

/** 回覆使用者的指令：不計入每月推播額度 */
export function reply(env, replyToken, text) {
  return call(env, "/v2/bot/message/reply", {
    replyToken,
    messages: [{ type: "text", text: clip(text) }],
  });
}

/** 主動推播：計入每月額度（群組按人數計），多則合併成一則送出 */
export function push(env, to, texts) {
  if (!texts.length) return Promise.resolve(true);
  return call(env, "/v2/bot/message/push", {
    to,
    messages: [{ type: "text", text: clip(texts.join("\n")) }],
  });
}
