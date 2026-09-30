import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTable, parseDetailUrl, currentAmpm, hospitalByAlias } from "../src/ntuh.js";
import { parseCommand } from "../src/commands.js";
import { loadConfig, onReading, onFailure, isExpired, title } from "../src/monitor.js";

const cfg = loadConfig({});
const NOW = 1_800_000_000_000;
const row = (o = {}) => ({
  id: 3, my_number: 25, label: null, doctor: "戴季珊", room: "01診", hosp: "CH", ampm: 2,
  last_number: null, sent: "", fail_count: 0, fail_alerted: 0, drop_alerted: 0,
  created_at: NOW, next_check_at: NOW, ...o,
});

// ── 臺大 DeptLightTable（真實回應節錄） ──
test("ntuh: 解析真實列表", () => {
  const html = readFileSync(new URL("./fixtures/dept-light-table.html", import.meta.url), "utf8");
  const { updatedAt, clinics } = parseTable(html);
  assert.equal(updatedAt, "2026-09-30 13:50:51");
  assert.equal(clinics.length, 5);
  assert.deepEqual(clinics[0], {
    sid: "8052029", hosp: "CH", room: "01診", doctor: "何冠頤", type: "普通門診", number: 4, note: "", byCheckin: false,
  });
  assert.equal(clinics[1].note, "依報到順序看診");
  assert.equal(clinics[1].byCheckin, true);
  assert.equal(clinics[2].doctor, "總醫師(代)");
  assert.equal(clinics[3].number, null); // 全形空白 = 尚未開始
  assert.equal(clinics[4].number, 25);   // 沒補零的號碼
});
test("ntuh: 網址、院區別名、時段", () => {
  assert.deepEqual(
    parseDetailUrl("https://reg.ntuh.gov.tw/WebReg/WebReg/ClinicCurrentLightNoDetail?ServiceIDSE=8049502&vHospitalCode=CH"),
    { host: "reg.ntuh.gov.tw", sid: "8049502", hosp: "CH" });
  assert.equal(parseDetailUrl("https://reg.ntuh.gov.tw/x"), null);
  assert.equal(hospitalByAlias("兒醫"), "CH");
  assert.equal(hospitalByAlias("台大"), "T0");
  // 台北 09:00 / 14:00 / 19:00
  assert.equal(currentAmpm(Date.UTC(2026, 8, 30, 1)), 1);
  assert.equal(currentAmpm(Date.UTC(2026, 8, 30, 6)), 2);
  assert.equal(currentAmpm(Date.UTC(2026, 8, 30, 11)), 3);
});

// ── 指令 ──
test("command: 用醫師名追蹤", () => {
  assert.deepEqual(parseCommand("追蹤 25 戴季珊"), { cmd: "add", number: 25, hosp: null, ampm: null, doctor: "戴季珊" });
  assert.deepEqual(parseCommand("追蹤　戴季珊醫師 兒童 下午 25號"), { cmd: "add", number: 25, hosp: "CH", ampm: 2, doctor: "戴季珊" });
  assert.deepEqual(parseCommand("追蹤 戴季珊"), { cmd: "add", number: null, hosp: null, ampm: null, doctor: "戴季珊" });
});
test("command: 按鈕流程與網址", () => {
  assert.deepEqual(parseCommand("追蹤"), { cmd: "guide", number: null, hosp: null, ampm: null, doctor: null });
  assert.deepEqual(parseCommand("追蹤 25 兒童"), { cmd: "guide", number: 25, hosp: "CH", ampm: null, doctor: null });
  const u = "https://reg.ntuh.gov.tw/x?ServiceIDSE=1&vHospitalCode=CH";
  assert.deepEqual(parseCommand(`追蹤 ${u} 25 小孩`), { cmd: "addUrl", url: u, number: 25, label: "小孩" });
});
test("command: 燈號 / 列表 / 取消 / 號碼 / 閒聊", () => {
  assert.deepEqual(parseCommand("燈號 戴季珊"), { cmd: "lookup", hosp: null, ampm: null, doctor: "戴季珊" });
  assert.equal(parseCommand("燈號").cmd, "usage");
  assert.deepEqual(parseCommand("列表"), { cmd: "list" });
  assert.deepEqual(parseCommand("取消 #3"), { cmd: "cancel", id: 3 });
  assert.deepEqual(parseCommand("取消 全部"), { cmd: "cancel", all: true });
  assert.deepEqual(parseCommand("25"), { cmd: "number", number: 25 });
  assert.deepEqual(parseCommand("25號"), { cmd: "number", number: 25 });
  assert.equal(parseCommand("今天要追蹤什麼"), null);
  assert.equal(parseCommand("列表很長"), null);
});

// ── 監控邏輯 ──
test("monitor: 標題", () => {
  assert.equal(title(row()), "#3 戴季珊（兒童醫院 下午 01診）");
  assert.equal(title(row({ label: "小孩" })), "#3 戴季珊（兒童醫院 下午 01診） 小孩");
});
test("monitor: 尚未開始看診安靜等待", () => {
  const r = onReading(row(), null, cfg, NOW);
  assert.deepEqual(r.messages, []);
  assert.equal(r.done, false);
});
test("monitor: 跳號跨多門檻只推一則，且不重複", () => {
  let r = onReading(row({ last_number: 10 }), 21, cfg, NOW);
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0], /剩 4 號/);
  assert.equal(r.update.sent, "10,5");
  r = onReading(row({ last_number: 21, sent: "10,5" }), 21, cfg, NOW);
  assert.deepEqual(r.messages, []);
});
test("monitor: 到號與過號結束", () => {
  assert.equal(onReading(row({ last_number: 24 }), 25, cfg, NOW).done, true);
  const r = onReading(row({ last_number: 24 }), 27, cfg, NOW);
  assert.equal(r.done, true);
  assert.match(r.messages[0], /已超過/);
});
test("monitor: 輪詢間隔接近時 1 分、遠時 2 分", () => {
  assert.equal(onReading(row({ last_number: 1 }), 2, cfg, NOW).update.next_check_at, NOW + 2 * 60000 - 5000);
  assert.equal(onReading(row({ last_number: 16, sent: "10" }), 16, cfg, NOW).update.next_check_at, NOW + 60000 - 5000);
});
test("monitor: 燈號變小只警告一次", () => {
  assert.match(onReading(row({ last_number: 20 }), 3, cfg, NOW).messages[0], /變小/);
  assert.equal(onReading(row({ last_number: 20, drop_alerted: 1 }), 3, cfg, NOW).messages.length, 0);
});
test("monitor: 連續失敗第 3 次警告、恢復時通知", () => {
  assert.equal(onFailure(row({ fail_count: 1 }), cfg, NOW, "x").messages.length, 0);
  assert.match(onFailure(row({ fail_count: 2 }), cfg, NOW, "HTTP 500").messages[0], /連續 3 次/);
  assert.match(onReading(row({ last_number: 5, fail_alerted: 1, fail_count: 3 }), 6, cfg, NOW).messages[0], /恢復/);
  assert.match(onReading(row({ fail_alerted: 1, fail_count: 3 }), null, cfg, NOW).messages[0], /恢復/);
});
test("monitor: 開始看診後號碼消失視為失敗", () => {
  assert.equal(onReading(row({ last_number: 10, fail_count: 2 }), null, cfg, NOW).update.fail_count, 3);
});
test("monitor: 逾時", () => {
  assert.equal(isExpired(row({ created_at: NOW - 9 * 3600e3 }), cfg, NOW), true);
  assert.equal(isExpired(row(), cfg, NOW), false);
});

// ── 依報到順序看診 ──
test("checkin: 看診途中改為依報到順序 → 提醒一次", () => {
  const r = onReading(row({ last_number: 5 }), 6, cfg, NOW, true);
  assert.equal(r.update.by_checkin, 1);
  assert.match(r.messages[0], /依報到順序/);
  assert.equal(onReading(row({ last_number: 6, by_checkin: 1 }), 7, cfg, NOW, true).messages.length, 0);
});
test("checkin: 燈號變小不警告", () => {
  assert.deepEqual(onReading(row({ last_number: 20, by_checkin: 1, sent: "10,5,2" }), 12, cfg, NOW, true).messages, []);
});
test("checkin: 超過號碼時提醒確認報到，不說過號", () => {
  const r = onReading(row({ last_number: 24, by_checkin: 1, sent: "10,5,2" }), 27, cfg, NOW, true);
  assert.equal(r.done, true);
  assert.match(r.messages[0], /不一定是過號/);
  assert.doesNotMatch(r.messages[0], /立刻到診間/);
});
