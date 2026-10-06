// 解析句首的日期 / 時間（台北時間，UTC+8，無日光節約）
//
//   今天 明天 後天 大後天 今晚 明早 明晚
//   週五 / 星期五 / 禮拜五 / 下週一
//   10/8  10-8  2026/10/8  10月8日  10月8號  8號
//   早上 上午 中午 下午 傍晚 晚上 凌晨 半夜
//   8點 8點半 8點15分 八點 20:30
//   30分鐘後 半小時後 2小時後 3天後
//
// 回傳 { at, rest, hasTime, label } 或 null（句首不是日期時間）

const TZ = 8 * 3600_000;
const DAY = 86400_000;
const WEEK = "日一二三四五六";

const CN = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function num(s) {
  if (s == null || s === "") return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s === "半") return 0.5;
  // 十、十二、二十、二十三
  const m = s.match(/^([一二兩三四五六七八九])?(十)?([一二三四五六七八九])?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  if (!m[2]) return CN[m[1] ?? m[3]];
  return (m[1] ? CN[m[1]] : 1) * 10 + (m[3] ? CN[m[3]] : 0);
}

/** 台北時間的年月日時分 → epoch ms */
const toEpoch = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - TZ;
/** epoch ms → 台北時間的 {y, mo, d, dow, h, mi} */
export function local(ms) {
  const t = new Date(ms + TZ);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay(), h: t.getUTCHours(), mi: t.getUTCMinutes() };
}
const dayStart = (ms) => { const l = local(ms); return toEpoch(l.y, l.mo, l.d); };

export function formatWhen(ms, now = Date.now()) {
  const l = local(ms);
  const diff = Math.round((dayStart(ms) - dayStart(now)) / DAY);
  const rel = diff === 0 ? "今天 " : diff === 1 ? "明天 " : diff === 2 ? "後天 " : "";
  const hm = `${String(l.h).padStart(2, "0")}:${String(l.mi).padStart(2, "0")}`;
  return `${rel}${l.mo}/${l.d}（${WEEK[l.dow]}）${hm}`;
}

const N = "\\d{1,2}|[一二兩三四五六七八九十]{1,3}";
const RE = {
  rel: new RegExp(`^(\\d{1,3}|半|[一二兩三四五六七八九十]{1,3})\\s*(?:個)?\\s*(分鐘|分|小時|鐘頭|天)(?:之)?後`),
  word: /^(今天|今日|明天|明日|後天|大後天|今晚|明早|明晚)/,
  week: /^(下下|下個?|這個?|本)?\s*(?:週|周|星期|禮拜)([一二三四五六日天])/,
  ymd: /^(?:(\d{4})[/\-.])?(\d{1,2})[/\-.](\d{1,2})(?![\d/\-.])/,
  cnDate: new RegExp(`^(?:(${N})\\s*月\\s*)?(${N}|\\d{2})\\s*[日號号](?!子)`),
  period: /^(早上|早晨|上午|中午|下午|傍晚|晚上|凌晨|半夜)/,
  hm: /^(\d{1,2})\s*[:：]\s*(\d{2})/,
  cnTime: new RegExp(`^(${N})\\s*[點点時](?:\\s*(半|${N}|\\d{2})\\s*分?)?`),
};
const PERIOD_DEFAULT = { 早上: 8, 早晨: 8, 上午: 9, 中午: 12, 下午: 15, 傍晚: 18, 晚上: 20, 凌晨: 1, 半夜: 0 };

/**
 * @param {string} text
 * @param {number} now epoch ms
 * @param {number} defaultHour 只有日期時的提醒時間（預設 8 點）
 */
export function parseWhen(text, now = Date.now(), defaultHour = 8, defaultMinute = 0) {
  let s = String(text ?? "").trim();
  const take = (m) => { s = s.slice(m[0].length).replace(/^[\s,，、]+/, ""); };
  const today = local(now);

  // 相對時間：30分鐘後、2小時後、3天後
  let m = s.match(RE.rel);
  if (m) {
    const n = num(m[1]);
    if (!n) return null;
    take(m);
    if (m[2] === "天") {
      const at = dayStart(now) + n * DAY + (defaultHour * 60 + defaultMinute) * 60_000;
      return finish(at, false);
    }
    const mins = m[2].startsWith("分") ? n : n * 60;
    return finish(now + Math.round(mins * 60_000), true);
  }

  let date = null;      // 台北當天 00:00 的 epoch
  let weekday = false;  // 「週五」：今天已過就算下週
  let period = null, hour = null, minute = 0;

  if ((m = s.match(RE.word))) {
    take(m);
    const w = m[1];
    const add = /^(今)/.test(w) ? 0 : /^大後/.test(w) ? 3 : /^後/.test(w) ? 2 : 1;
    date = dayStart(now) + add * DAY;
    if (w === "今晚" || w === "明晚") period = "晚上";
    if (w === "明早") period = "早上";
  } else if ((m = s.match(RE.week))) {
    take(m);
    const target = m[2] === "天" ? 0 : WEEK.indexOf(m[2]);
    // 以週一為一週的開始
    const mon = (d) => (d + 6) % 7;
    const base = dayStart(now) - mon(today.dow) * DAY; // 本週一
    const prefix = m[1] ?? "";
    const weeks = prefix.startsWith("下下") ? 2 : prefix.startsWith("下") ? 1 : 0;
    date = base + (weeks * 7 + mon(target)) * DAY;
    weekday = !prefix;    // 沒寫「這 / 下」：已經過了就跳到下週
  } else if ((m = s.match(RE.ymd)) || (m = s.match(RE.cnDate))) {
    const y = m[1] && m[1].length === 4 ? parseInt(m[1], 10) : null;
    const isYmd = RE.ymd.test(m[0]);
    const mo = isYmd ? parseInt(m[2], 10) : m[1] ? num(m[1]) : today.mo;
    const d = isYmd ? parseInt(m[3], 10) : num(m[2]);
    if (!mo || !d || mo > 12 || d > 31) return null;
    take(m);
    let yy = y ?? today.y;
    let ms = toEpoch(yy, mo, d);
    if (local(ms).d !== d) return null; // 2/30 之類
    if (!y && ms < dayStart(now)) {
      // 已經過了：只寫「8號」→ 下個月；寫了月份 → 明年
      if (isYmd || m[1]) ms = toEpoch(++yy, mo, d);
      else {
        const nm = today.mo === 12 ? [today.y + 1, 1] : [today.y, today.mo + 1];
        ms = toEpoch(nm[0], nm[1], d);
        if (local(ms).d !== d) return null;
      }
    }
    date = ms;
  }

  if ((m = s.match(RE.period))) {
    period = m[1];
    take(m);
  }
  if ((m = s.match(RE.hm))) {
    hour = parseInt(m[1], 10);
    minute = parseInt(m[2], 10);
    take(m);
  } else if ((m = s.match(RE.cnTime))) {
    hour = num(m[1]);
    const mm = m[2] ? num(m[2]) : 0;
    minute = mm === 0.5 ? 30 : mm;
    take(m);
  }
  if (date === null && period === null && hour === null) return null;
  if (hour !== null && (hour > 24 || minute > 59)) return null;

  // 時段換算成 24 小時制
  const hasTime = hour !== null || period !== null;
  if (hour === null && period) hour = PERIOD_DEFAULT[period];
  else if (period && hour !== null) {
    if (["下午", "傍晚", "晚上"].includes(period) && hour < 12) hour += 12;
    if (period === "中午" && hour < 6) hour += 12;
    if (period === "半夜" && hour === 12) hour = 0;
  }
  if (hour === 24) hour = 0;

  // 「8點」沒寫早晚：今天早上的 8 點已過、晚上的還沒到 → 當成晚上 8 點
  if (!period && hour !== null && hour >= 1 && hour < 12 && (date === null || date === dayStart(now))) {
    const t = dayStart(now);
    if (t + (hour * 60 + minute) * 60_000 <= now && t + ((hour + 12) * 60 + minute) * 60_000 > now) {
      hour += 12;
      date = t;
    }
  }
  const h = hour ?? defaultHour;
  const mi = hour === null ? defaultMinute : minute;
  if (date === null) {
    // 只有時間：今天還沒到就是今天，否則明天
    date = dayStart(now);
    if (date + (h * 60 + mi) * 60_000 <= now) date += DAY;
  }
  let at = date + (h * 60 + mi) * 60_000;
  if (weekday && at <= now) at += 7 * DAY;
  return finish(at, hasTime);

  function finish(at, hasTime) {
    s = s.replace(/^(?:的時候|時|的)\s*/, "");
    return { at, rest: s, hasTime, label: formatWhen(at, now) };
  }
}
