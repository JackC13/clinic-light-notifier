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
 * @param {{mime: string, data: string}[]} images 附在最後一則使用者訊息的圖片（base64）
 * @returns {Promise<string>}
 */
export async function chat(env, system, messages, images = []) {
  const provider = aiProvider(env);
  if (!provider) throw new Error("尚未設定 AI 金鑰");
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  return provider === "claude" ? claude(env, system, messages, signal, images) : gemini(env, system, messages, signal, images);
}

/** 語音轉文字（只有 Gemini 能聽語音） */
export async function transcribe(env, data, mime = "audio/m4a") {
  if (!env.GEMINI_API_KEY) throw new Error("語音需要 Gemini 金鑰");
  const base = env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com";
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const res = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: mime, data } },
          { text: "把這段語音逐字聽寫成繁體中文（台灣用語）。只輸出聽寫的文字，不要加說明、引號或標點以外的符號。聽不清楚就輸出空字串。" },
        ],
      }],
      generationConfig: { maxOutputTokens: 512 },
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini API ${res.status}：${j.error?.message ?? "未知錯誤"}`);
  return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
}

/** ArrayBuffer → base64（Workers 沒有 Buffer） */
export function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function claude(env, system, messages, signal, images = []) {
  if (images.length) {
    const last = messages.at(-1);
    messages = [...messages.slice(0, -1), {
      role: "user",
      content: [
        ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mime, data: im.data } })),
        { type: "text", text: last.content },
      ],
    }];
  }
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

async function gemini(env, system, messages, signal, images = []) {
  const base = env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com";
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const res = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m, i) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [
          ...(i === messages.length - 1 ? images.map((im) => ({ inlineData: { mimeType: im.mime, data: im.data } })) : []),
          { text: m.content },
        ],
      })),
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

export function buildSystemPrompt({ nowText, notes, reminders, trackings, history = "" }) {
  return [
    "你是這個 LINE 家庭群組的辦事小弟，大家叫你「小弟」「辦事小弟」或「小幫手」。",
    "個性：Z 世代、做事很專心、講話直率不囉嗦。交代的事就確實辦好，辦完簡單回報，不邀功也不客套。",
    "說話風格：",
    "・像跟熟的家人講話，輕鬆口語，可以用「收到」「OK 處理好了」「欸這個…」「老實說」「真的假的」這類說法，偶爾一個 emoji 就好。",
    "・直接講重點，先給答案再補一句理由；不說「很高興為您服務」「請問還有什麼需要」這種客服話。",
    "・覺得不妥會直接講（例如東西重複記了、時間怪怪的、藥的事要問醫生），但語氣是提醒，不是說教。",
    "・不知道就說不知道，不要硬掰；不用敬語「您」，用「你」。",
    "・可以有一點小吐槽或幽默，但正事（看診、用藥、小孩的事）要認真，不開玩笑。",
    "用繁體中文（台灣用語），回答簡短，適合在手機上看；一般 1～3 句，需要列清單才列。",
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
    `【最近紀錄】（誰在什麼時間新增 / 完成了什麼，回答「誰買了」「什麼時候記的」這類問題時參考）${history || "（沒有）"}`,
    "",
    "使用者有時會附上照片（學校通知單、藥袋、帳單、收據、截圖…）：",
    "・先用一兩句講重點（日期、時間、金額、要帶 / 要做的事），看不清楚就直說。",
    "・使用者要你記下、整理或提醒時，把裡面要帶的、要買的、要做的事用 actions 新增，有日期就填 at。",
    "・只是問內容的話就回答，最後問一句要不要幫忙記下來。",
    "・藥袋只轉述上面寫的用法用量，不要自己給建議。",
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
