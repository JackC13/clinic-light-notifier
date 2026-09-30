// 單筆追蹤的狀態判斷（純函式，方便測試）
//
// row 欄位：id, my_number, label, doctor, room, hosp, ampm, last_number, sent,
//           fail_count, fail_alerted, drop_alerted, created_at, next_check_at

import { AMPM, hospitalName } from "./ntuh.js";

const MIN = 60_000;
// cron 每分鐘觸發，提早幾秒讓下一次 cron 一定會挑到
const SLACK = 5_000;

export function loadConfig(env) {
  const thresholds = String(env.THRESHOLDS ?? "10,5,2")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => n > 0);
  return {
    thresholds: [...new Set(thresholds)].sort((a, b) => b - a),
    nearWithin: int(env.NEAR_WITHIN, 10),
    farMinutes: int(env.FAR_INTERVAL_MINUTES, 2),
    nearMinutes: 1,
    alertAfterFailures: int(env.ALERT_AFTER_FAILURES, 3),
    maxHours: int(env.MAX_HOURS, 8),
  };
}

function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** 例：#3 戴季珊（兒童醫院 下午 01診）小孩 */
export function title(row) {
  const where = [row.hosp && hospitalName(row.hosp), row.ampm && AMPM[row.ampm], row.room]
    .filter(Boolean)
    .join(" ");
  const who = row.doctor ? `${row.doctor}${where ? `（${where}）` : ""}` : where;
  return [`#${row.id}`, who, row.label].filter(Boolean).join(" ");
}

function parseSent(s) {
  return new Set(String(s ?? "").split(",").filter(Boolean).map(Number));
}

export const CHECKIN_NOTE = "此診依報到順序看診，燈號不一定照號碼順序，通知僅供參考，請記得先報到";

/**
 * 讀到該診資料後呼叫。
 * current: 目前燈號；null 表示尚未開始看診
 * byCheckin: 該診目前是否標示「依報到順序看診」
 * 回傳 { update, messages, done }
 */
export function onReading(row, current, cfg, now, byCheckin = !!row.by_checkin) {
  const messages = [];
  const update = {};
  const t = title(row);
  const my = row.my_number;

  // 看診途中才改成依報到順序：提醒一次
  if (byCheckin !== !!row.by_checkin) {
    update.by_checkin = byCheckin ? 1 : 0;
    if (byCheckin) messages.push(`ℹ️ ${t}｜${CHECKIN_NOTE}`);
  }

  // 還沒開始看診（從沒讀到過號碼）→ 安靜等待
  if (current === null && row.last_number === null) {
    if (row.fail_alerted) messages.push(`✅ ${t}｜恢復讀取，目前尚未開始看診`);
    Object.assign(update, { fail_count: 0, fail_alerted: 0, next_check_at: now + cfg.farMinutes * MIN - SLACK });
    return { update, messages, done: false };
  }
  // 讀到過號碼卻突然沒了 → 視同失敗
  if (current === null) {
    const f = onFailure(row, cfg, now, "燈號消失了");
    return { ...f, update: { ...update, ...f.update }, messages: [...messages, ...f.messages] };
  }

  if (row.fail_alerted) messages.push(`✅ ${t}｜恢復讀取，目前 ${current} 號`);
  update.fail_count = 0;
  update.fail_alerted = 0;

  // 依報到順序看診時燈號本來就會前後跳，不警告
  if (!byCheckin && row.last_number !== null && current < row.last_number && !row.drop_alerted) {
    messages.push(`⚠️ ${t}｜燈號從 ${row.last_number} 變成 ${current}（變小了），請確認是否為今天這一診`);
    update.drop_alerted = 1;
  }
  update.last_number = current;

  const remaining = my - current;
  if (remaining <= 0) {
    if (byCheckin) {
      messages.push(
        remaining === 0
          ? `🔔 ${t}｜燈號到 ${current} 號了（此診依報到順序看診，請以現場叫號為準）`
          : `🚨 ${t}｜燈號 ${current} 已超過你的 ${my} 號。此診依報到順序看診，不一定是過號：請確認是否已報到，或詢問護理站`,
      );
    } else {
      messages.push(
        remaining === 0
          ? `🔔 ${t}｜輪到了！目前 ${current} 號`
          : `🚨 ${t}｜燈號 ${current} 已超過 ${my} 號，請立刻到診間報到`,
      );
    }
    return { update, messages, done: true };
  }

  // 用 <= 判斷避免跳號錯過；一次跨過多個門檻只推一則
  const sent = parseSent(row.sent);
  const crossed = cfg.thresholds.filter((th) => remaining <= th && !sent.has(th));
  if (crossed.length > 0) {
    crossed.forEach((th) => sent.add(th));
    update.sent = [...sent].join(",");
    const emoji = remaining <= 2 ? "🔴" : remaining <= 5 ? "🟠" : "🟡";
    messages.push(`${emoji} ${t}｜剩 ${remaining} 號（目前 ${current}，你是 ${my} 號）`);
  }

  const minutes = remaining <= cfg.nearWithin ? cfg.nearMinutes : cfg.farMinutes;
  update.next_check_at = now + minutes * MIN - SLACK;
  return { update, messages, done: false };
}

/** 讀取失敗（網路錯誤、HTTP 錯誤、列表中找不到該診、或開診後號碼消失） */
export function onFailure(row, cfg, now, reason) {
  const messages = [];
  const failCount = (row.fail_count ?? 0) + 1;
  const update = { fail_count: failCount };

  if (failCount >= cfg.alertAfterFailures && !row.fail_alerted) {
    messages.push(`⚠️ ${title(row)}｜已連續 ${failCount} 次讀不到燈號（${reason}），請自己看一下網頁；仍會繼續重試`);
    update.fail_alerted = 1;
  }

  // 退避：1 → 2 → 4 分鐘；接近自己的號碼時最多 1 分鐘
  const near = row.last_number !== null && row.my_number - row.last_number <= cfg.nearWithin;
  const backoff = near ? 1 : Math.min(2 ** (failCount - 1), 4);
  update.next_check_at = now + backoff * MIN - SLACK;
  return { update, messages, done: false };
}

// ───────────── 個別診燈號頁（報到狀態、預計叫號） ─────────────
//
// 新欄位：checkin_state  null=還沒看過 / 'no'=看到未報到 / 'yes'=看到報到的那一刻 / 'approx'=第一次看到就已報到
//         ahead          報到那一刻排在前面的號碼（JSON 陣列）
//         ahead_left     前面還剩幾位（列表顯示用）
//         alerts         已發過的一次性提醒：P 過號、E 預計叫號、R 提醒報到

const ACTIVE = new Set(["checkin", "oncall"]);
const keys = (s) => new Set(String(s ?? "").split(",").filter(Boolean));

/**
 * 讀到個別燈號頁後呼叫（通常接在 onReading 之後，或取代 onReading）。
 * byCheckin=true 時改用「報到順序」計算前面還有幾位，回傳 handled=true；
 * 否則只補上一次性提醒（過號、預計叫號、提醒報到）。
 */
export function onDetail(row, d, byCheckin, cfg, now) {
  const t = title(row);
  const my = row.my_number;
  const messages = [];
  const update = {};
  const alerts = keys(row.alerts);
  const me = d.statuses.find((s) => s.n === my);
  const notIn = me && (me.status === "notin" || me.status === "first");
  const started = d.current !== null || d.statuses.some((s) => s.status === "oncall");

  if (notIn && row.checkin_state !== "no") update.checkin_state = "no";

  // 一次性提醒
  if (notIn && d.maxCalled !== null && d.maxCalled > my && !alerts.has("P")) {
    alerts.add("P");
    messages.push(`⚠️ ${t}｜已叫最大號 ${d.maxCalled} 超過你的 ${my} 號，你還沒報到：已過號，請盡速插卡報到`);
  }
  const idx = d.expected.findIndex((e) => e.n === my);
  if (idx >= 0 && me?.status !== "oncall" && !alerts.has("E")) {
    alerts.add("E");
    messages.push(`🔔 ${t}｜你在「預計叫號」第 ${idx + 1} 位，請到診間外準備`);
  }
  const nearByNumber = d.current !== null && my - d.current <= cfg.nearWithin;
  if (notIn && !alerts.has("R") && !alerts.has("P") && (byCheckin ? started : nearByNumber)) {
    alerts.add("R");
    messages.push(
      byCheckin
        ? `📝 ${t}｜已開始看診，你還沒報到。此診依報到順序，越早報到越早看`
        : `📝 ${t}｜快輪到了（目前 ${d.current} 號），你還沒報到，請先報到`,
    );
  }
  if (alerts.size !== keys(row.alerts).size) update.alerts = [...alerts].join(",");

  if (!byCheckin) return { update, messages, done: false, handled: false };

  // ── 依報到順序：看誰比你先報到 ──
  if (d.current !== null) update.last_number = d.current;
  const next = (min) => (update.next_check_at = now + min * 60_000 - 5_000);

  if (me?.status === "oncall") {
    messages.push(`🔔 ${t}｜輪到了！你的 ${my} 號看診中`);
    return { update, messages, done: true, handled: true };
  }
  const checkedBefore = row.checkin_state === "yes" || row.checkin_state === "approx";
  if (!me) {
    if (checkedBefore) {
      messages.push(`✅ ${t}｜你的 ${my} 號已不在候診清單，應已看診完畢`);
      return { update, messages, done: true, handled: true };
    }
    if (!started || d.statuses.length === 0) {
      next(cfg.farMinutes);
      return { update, messages, done: false, handled: true };
    }
    return { handled: false, update, messages, done: false }; // 清單裡找不到：交給號碼邏輯
  }

  let ahead = row.ahead ? JSON.parse(row.ahead) : null;
  let state = row.checkin_state;
  if (me.status === "checkin" && !checkedBefore) {
    // 報到的這一刻：已報到 / 看診中的其他人都排在你前面
    ahead = d.statuses.filter((s) => s.n !== my && ACTIVE.has(s.status)).map((s) => s.n);
    state = row.checkin_state === "no" ? "yes" : "approx";
    update.checkin_state = state;
    update.ahead = JSON.stringify(ahead);
  }

  if (state === "yes" || state === "approx") {
    const present = new Set(d.statuses.filter((s) => ACTIVE.has(s.status)).map((s) => s.n));
    const left = ahead.filter((n) => present.has(n)).length;
    update.ahead_left = left;
    const most = state === "approx" ? "最多 " : "";
    const sent = new Set(String(row.sent ?? "").split(",").filter(Boolean).map(Number));

    if (!checkedBefore) {
      messages.push(
        state === "yes"
          ? `✅ ${t}｜已報到，前面還有 ${left} 位（依報到順序）`
          : `✅ ${t}｜已報到，前面${most}${left} 位（加入追蹤前就已報到，無法確定先後）`,
      );
      cfg.thresholds.filter((th) => left <= th).forEach((th) => sent.add(th)); // 剛通知過，不重複
    } else {
      const crossed = cfg.thresholds.filter((th) => left <= th && !sent.has(th));
      if (crossed.length) {
        crossed.forEach((th) => sent.add(th));
        const emoji = left <= 2 ? "🔴" : left <= 5 ? "🟠" : "🟡";
        messages.push(`${emoji} ${t}｜前面還有 ${most}${left} 位（依報到順序）`);
      }
    }
    update.sent = [...sent].join(",");
    next(left <= cfg.nearWithin ? cfg.nearMinutes : cfg.farMinutes);
  } else {
    next(started ? cfg.nearMinutes : cfg.farMinutes); // 還沒報到：每分鐘看，才抓得到報到的那一刻
  }
  return { update, messages, done: false, handled: true };
}

export function isExpired(row, cfg, now) {
  return now - row.created_at > cfg.maxHours * 60 * MIN;
}
