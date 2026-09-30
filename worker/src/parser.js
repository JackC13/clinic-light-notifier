// 從燈號頁 HTML 解析出目前號碼（與 .NET 版 LightNoParser 相同邏輯）

export const DEFAULT_REGEX =
  "(?:目前|現在) ?(?:燈號|號碼|看診號碼?|叫號) ?[:：]? ?(\\d{1,4})(?! ?診)";

/** 把 HTML 轉成一行一段的純文字，讓 Regex 不受標籤干擾 */
export function htmlToText(html) {
  let s = html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?(tr|p|div|li|h\d|table|tbody|thead|section|br)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s).replace(/ /g, " ");
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}

/** 回傳目前號碼，解析不到回傳 null */
export function parseLightNo(html, pattern = DEFAULT_REGEX) {
  const m = new RegExp(pattern).exec(htmlToText(html));
  if (!m) return null;
  const digits = (m[1] ?? m[0]).replace(/\D/g, "");
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

/** --dump 用：列出含數字的文字行，方便調整 Regex */
export function digitLines(html, max = 15) {
  return htmlToText(html)
    .split("\n")
    .filter((l) => /\d/.test(l))
    .slice(0, max)
    .map((l) => (l.length > 60 ? l.slice(0, 60) + "…" : l));
}
