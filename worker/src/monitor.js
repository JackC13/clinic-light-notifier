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

export function isExpired(row, cfg, now) {
  return now - row.created_at > cfg.maxHours * 60 * MIN;
}
