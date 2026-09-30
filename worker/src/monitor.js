// 單筆追蹤的狀態判斷（純函式，方便測試）
//
// row 欄位：id, my_number, label, last_number, sent, fail_count, fail_alerted,
//           drop_alerted, created_at, next_check_at

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

export function title(row) {
  return row.label ? `#${row.id} ${row.label}` : `#${row.id}`;
}

function parseSent(s) {
  return new Set(String(s ?? "").split(",").filter(Boolean).map(Number));
}

/**
 * 取得頁面後呼叫。
 * current: 解析出的號碼；null 表示頁面有抓到但沒有號碼（多半是尚未開診）
 * 回傳 { update, messages, done }
 */
export function onReading(row, current, cfg, now) {
  const messages = [];
  const update = {};
  const t = title(row);
  const my = row.my_number;

  // 還沒開診（從沒讀到過號碼）→ 安靜等待
  if (current === null && row.last_number === null) {
    update.next_check_at = now + cfg.farMinutes * MIN - SLACK;
    return { update, messages, done: false };
  }
  // 讀到過號碼卻突然沒了 → 視同失敗
  if (current === null) return onFailure(row, cfg, now, "頁面上找不到燈號");

  if (row.fail_alerted) messages.push(`✅ ${t}｜恢復讀取，目前 ${current} 號`);
  update.fail_count = 0;
  update.fail_alerted = 0;

  if (row.last_number !== null && current < row.last_number && !row.drop_alerted) {
    messages.push(`⚠️ ${t}｜燈號從 ${row.last_number} 變成 ${current}（變小了），請確認網址是否為今天這一診`);
    update.drop_alerted = 1;
  }
  update.last_number = current;

  const remaining = my - current;
  if (remaining <= 0) {
    messages.push(
      remaining === 0
        ? `🔔 ${t}｜輪到了！目前 ${current} 號`
        : `🚨 ${t}｜燈號 ${current} 已超過 ${my} 號，請立刻到診間報到`,
    );
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

/** 抓取失敗（網路錯誤、HTTP 錯誤、或開診後號碼消失） */
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
