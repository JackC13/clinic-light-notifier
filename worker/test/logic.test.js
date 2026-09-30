import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLightNo } from "../src/parser.js";
import { parseCommand } from "../src/commands.js";
import { loadConfig, onReading, onFailure, isExpired } from "../src/monitor.js";

const cfg = loadConfig({});
const NOW = 1_800_000_000_000;
const row = (o = {}) => ({
  id: 3, my_number: 25, label: "小孩", last_number: null, sent: "",
  fail_count: 0, fail_alerted: 0, drop_alerted: 0, created_at: NOW, next_check_at: NOW, ...o,
});

// ── parser ──
test("parser: 同一行的標籤與號碼", () => {
  assert.equal(parseLightNo('<div>目前號碼&nbsp;:&nbsp;<b>8</b></div>'), 8);
  assert.equal(parseLightNo("<div>目前看診號：<span>23</span></div>"), 23);
});
test("parser: 表格表頭與號碼不同行時不誤抓診間號", () => {
  const html = "<table><tr><th>診間</th><th>目前燈號</th></tr><tr><td>12診</td><td>17</td></tr></table>";
  assert.equal(parseLightNo(html), null);
});
test("parser: 沒燈號回傳 null", () => assert.equal(parseLightNo("<div>尚未開診</div>"), null));

// ── commands ──
test("command: 追蹤（號碼、網址順序不拘，含備註）", () => {
  const u = "https://reg.ntuh.gov.tw/x?ServiceIDSE=1&vHospitalCode=CH";
  assert.deepEqual(parseCommand(`追蹤 25 ${u} 小孩 腸胃科`), { cmd: "add", number: 25, url: u, label: "小孩 腸胃科" });
  assert.deepEqual(parseCommand(`追蹤　${u}　25號`), { cmd: "add", number: 25, url: u, label: null });
  assert.equal(parseCommand("追蹤 25").cmd, "usage");
});
test("command: 列表 / 取消 / 說明 / 閒聊", () => {
  assert.deepEqual(parseCommand("列表"), { cmd: "list" });
  assert.deepEqual(parseCommand("取消 #3"), { cmd: "cancel", id: 3 });
  assert.deepEqual(parseCommand("取消 全部"), { cmd: "cancel", all: true });
  assert.equal(parseCommand("取消").cmd, "usage");
  assert.deepEqual(parseCommand("說明"), { cmd: "help" });
  assert.equal(parseCommand("今天要追蹤什麼"), null);
  assert.equal(parseCommand("列表很長"), null);
});

// ── monitor ──
test("monitor: 尚未開診安靜等待", () => {
  const r = onReading(row(), null, cfg, NOW);
  assert.deepEqual(r.messages, []);
  assert.equal(r.done, false);
});
test("monitor: 跳號跨多門檻只推一則，且不重複", () => {
  let r = onReading(row({ last_number: 10 }), 21, cfg, NOW); // 剩 4 → 跨過 10、5
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
  const r = onReading(row({ last_number: 20 }), 3, cfg, NOW);
  assert.match(r.messages[0], /變小/);
  assert.equal(onReading(row({ last_number: 20, drop_alerted: 1 }), 3, cfg, NOW).messages.length, 0);
});
test("monitor: 連續失敗第 3 次警告、恢復時通知", () => {
  assert.equal(onFailure(row({ fail_count: 1 }), cfg, NOW, "x").messages.length, 0);
  const r = onFailure(row({ fail_count: 2 }), cfg, NOW, "HTTP 500");
  assert.match(r.messages[0], /連續 3 次/);
  const rec = onReading(row({ last_number: 5, fail_alerted: 1, fail_count: 3 }), 6, cfg, NOW);
  assert.match(rec.messages[0], /恢復/);
});
test("monitor: 開診後號碼消失視為失敗", () => {
  const r = onReading(row({ last_number: 10, fail_count: 2 }), null, cfg, NOW);
  assert.equal(r.update.fail_count, 3);
});
test("monitor: 逾時", () => {
  assert.equal(isExpired(row({ created_at: NOW - 9 * 3600e3 }), cfg, NOW), true);
  assert.equal(isExpired(row(), cfg, NOW), false);
});
