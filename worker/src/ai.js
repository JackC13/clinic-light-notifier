// 串接 LLM（Claude / Gemini）：群組小幫手對話，可順手記事、設提醒
//
// 設定（wrangler secret）：ANTHROPIC_API_KEY 或 GEMINI_API_KEY（兩個都設時看 AI_PROVIDER）
// 設定（wrangler.toml [vars]）：AI_PROVIDER = "claude" | "gemini"、CLAUDE_MODEL、GEMINI_MODEL、AI_DAILY_LIMIT

const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";
const MAX_OUTPUT_TOKENS = 1024;
const TIMEOUT_MS = 25_000;

export function aiProvider(env) {
  const want = String(env.AI_PROVIDER ?? "").toLowerCase();
  if (want === "claude" && env.ANTHROPIC_API_KEY) return "claude";
  if (want === "gemini" && env.GEMINI_API_KEY) return "gemini";
  if (env.ANTHROPIC_API_KEY) return "claude";
  if (env.GEMINI_API_KEY) return "gemini";
  return null;
}

/**
 * @param {object} env
 * @param {string} system
 * @param {{role: "user"|"assistant", content: string}[]} messages
 * @returns {Promise<string>}
 */
export async function chat(env, system, messages) {
  const provider = aiProvider(env);
  if (!provider) throw new Error("尚未設定 AI 金鑰");
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  return provider === "claude" ? claude(env, system, messages, signal) : gemini(env, system, messages, signal);
}

async function claude(env, system, messages, signal) {
  const base = env.ANTHROPIC_API_BASE || "https://api.anthropic.com";
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude API ${res.status}：${j.error?.message ?? "未知錯誤"}`);
  return (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
}

async function gemini(env, system, messages, signal) {
  const base = env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com";
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const res = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, responseMimeType: "application/json" },
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini API ${res.status}：${j.error?.message ?? "未知錯誤"}`);
  return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

/** 從模型輸出取出 JSON：{ reply, actions } ；不是 JSON 就整段當回覆 */
export function parseAiOutput(raw) {
  const text = String(raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(text.slice(start, end + 1));
      if (typeof j.reply === "string") {
        return { reply: j.reply.trim(), actions: Array.isArray(j.actions) ? j.actions.slice(0, 10) : [] };
      }
    } catch { /* 落到下面 */ }
  }
  return { reply: text.replace(/^```\w*\n?|```$/g, "").trim(), actions: [] };
}

/** "2026-10-09 08:00"（台北時間）→ epoch ms；格式不對回傳 null */
export function parseTaipeiTime(s) {
  const m = String(s ?? "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, h ? +h : 8, mi ? +mi : 0) - 8 * 3600_000;
  return Number.isFinite(ms) ? ms : null;
}

export function buildSystemPrompt({ nowText, notes, reminders, trackings }) {
  return [
    "你是一個 LINE 家庭群組裡的小幫手，名字叫「小幫手」。",
    "用繁體中文（台灣用語）回答，口氣自然友善，簡短扼要，適合在手機上閱讀。",
    "不要用 Markdown（不要 **粗體**、# 標題、表格），需要條列時用「・」或數字。",
    "醫療、用藥相關問題可以提供一般資訊，但要提醒以醫師、藥師的指示為準。",
    "不知道或不確定的事（例如即時新聞、天氣、營業時間）要直說你無法查即時資訊，不要編造。",
    "",
    `現在時間（台北）：${nowText}`,
    "",
    "群組目前的資料（回答「還要買什麼」「明天要帶什麼」這類問題時參考）：",
    `【記事】${notes || "（沒有）"}`,
    `【提醒】${reminders || "（沒有）"}`,
    `【看診追蹤】${trackings || "（沒有）"}`,
    "",
    "你可以幫忙新增記事或提醒，但只在使用者明確要你記下、提醒時才做，不要自作主張。",
    "記事分類：buy（買）、bring（帶）、todo（做）、trip（出國）、other（其他）。",
    "你不能刪除或修改資料；使用者要刪除時，請他用「刪除 編號」、修改用「改 編號 新內容」。",
    "",
    "一律只輸出一個 JSON 物件，不要有其他文字：",
    '{"reply":"給使用者看的回覆","actions":[]}',
    "actions 可以放：",
    '  {"type":"note","category":"bring","text":"健保卡","at":"2026-10-09 08:00"}  （at 可省略；有日期才填，會在那時提醒）',
    '  {"type":"remind","text":"繳停車費","at":"2026-10-09 18:00"}',
    "時間格式一律是台北時間的 YYYY-MM-DD HH:mm；使用者只說日期沒說時間就用 08:00。",
    "做了動作時，reply 裡簡短說明你記了什麼即可（系統會另外附上確認）。",
  ].join("\n");
}
