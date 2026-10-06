import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTable, parseDetail, parseDetailUrl, currentAmpm, hospitalByAlias } from "../src/ntuh.js";
import { parseCommand } from "../src/commands.js";
import { loadConfig, onReading, onFailure, onDetail, isExpired, title } from "../src/monitor.js";

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

// ── 個別燈號頁（真實頁面）與報到順序 ──
const realDetail = () => parseDetail(readFileSync(new URL("./fixtures/clinic-detail.html", import.meta.url), "utf8"));

test("detail: 解析真實燈號頁", () => {
  const d = realDetail();
  assert.equal(d.room, "兒童醫院 05診");
  assert.equal(d.current, 2);
  assert.equal(d.maxCalled, 3);
  assert.deepEqual(d.expected, [{ n: 2, type: "順號" }, { n: 3, type: "順號" }, { n: 79, type: "敬老號" }]);
  assert.equal(d.statuses.length, 57);
  assert.deepEqual(d.statuses.slice(0, 3), [{ n: 2, status: "oncall" }, { n: 3, status: "checkin" }, { n: 4, status: "notin" }]);
  assert.equal(d.statuses.find((s) => s.n === 33).status, "first");
});

// 小型頁面產生器：statuses 形如 { 2: "oncall", 3: "checkin", 13: "notin" }
const page = (statuses, { current = 2, maxCalled = 3, expected = [] } = {}) => ({
  current, maxCalled, expected: expected.map((n) => ({ n, type: "順號" })),
  statuses: Object.entries(statuses).map(([n, status]) => ({ n: +n, status })),
});
const ck = (o = {}) => row({ my_number: 13, by_checkin: 1, alerts: "", checkin_state: null, ahead: null, ...o });

test("checkin: 未報到 → 開診後提醒報到一次", () => {
  let r = onDetail(ck(), page({ 2: "oncall", 3: "checkin", 13: "notin" }), true, cfg, NOW);
  assert.equal(r.handled, true);
  assert.equal(r.update.checkin_state, "no");
  assert.match(r.messages[0], /還沒報到/);
  r = onDetail(ck({ checkin_state: "no", alerts: "R" }), page({ 2: "oncall", 13: "notin" }), true, cfg, NOW);
  assert.deepEqual(r.messages, []);
});
test("checkin: 報到那一刻記下前面的人；之後報到的不算", () => {
  // 報到時：2 看診中、3/5/7 已報到、4 未報到 → 前面 4 位
  let r = onDetail(ck({ checkin_state: "no", alerts: "R" }),
    page({ 2: "oncall", 3: "checkin", 4: "notin", 5: "checkin", 7: "checkin", 13: "checkin" }), true, cfg, NOW);
  assert.equal(r.update.checkin_state, "yes");
  assert.deepEqual(JSON.parse(r.update.ahead), [2, 3, 5, 7]);
  assert.match(r.messages[0], /已報到，前面還有 4 位/);
  assert.equal(r.update.sent, "10,5");  // 剛通知過 4 位，不再推「剩 5」

  // 之後：2、3 看完離開；4 和 20 後來才報到（排在你後面）
  const after = ck({ checkin_state: "yes", ahead: "[2,3,5,7]", sent: "10,5", alerts: "R" });
  r = onDetail(after, page({ 4: "checkin", 5: "oncall", 7: "checkin", 13: "checkin", 20: "checkin" }, { current: 5 }), true, cfg, NOW);
  assert.equal(r.update.ahead_left, 2);
  assert.match(r.messages[0], /🔴.*前面還有 2 位/);
});
test("checkin: 出現在預計叫號、輪到看診、看完離開", () => {
  const base = ck({ checkin_state: "yes", ahead: "[7]", sent: "10,5,2", alerts: "R" });
  let r = onDetail(base, page({ 7: "oncall", 13: "checkin" }, { expected: [7, 13] }), true, cfg, NOW);
  assert.match(r.messages[0], /預計叫號」第 2 位/);
  r = onDetail(base, page({ 13: "oncall" }), true, cfg, NOW);
  assert.equal(r.done, true);
  assert.match(r.messages[0], /輪到了/);
  r = onDetail(base, page({ 20: "checkin" }), true, cfg, NOW);
  assert.equal(r.done, true);
  assert.match(r.messages[0], /已不在候診清單/);
});
test("checkin: 加入前就已報到 → 標示「最多」", () => {
  const r = onDetail(ck(), page({ 2: "oncall", 3: "checkin", 13: "checkin" }), true, cfg, NOW);
  assert.equal(r.update.checkin_state, "approx");
  assert.match(r.messages[0], /最多 2 位/);
});
test("detail: 未報到且已叫最大號超過 → 過號提醒（一般診也適用）", () => {
  const r = onDetail(row({ my_number: 4, alerts: "" }), page({ 4: "notin", 6: "oncall" }, { current: 6, maxCalled: 6 }), false, cfg, NOW);
  assert.equal(r.handled, false);
  assert.match(r.messages[0], /已過號，請盡速插卡報到/);
});
test("detail: 一般診快輪到時提醒報到", () => {
  const r = onDetail(row({ my_number: 12, alerts: "" }), page({ 5: "oncall", 12: "notin" }, { current: 5, maxCalled: 5 }), false, cfg, NOW);
  assert.match(r.messages[0], /快輪到了.*還沒報到/);
});

// ── 記事本 / 備註 ──
test("notes: 新增（分類、多項、黏在一起的寫法）", () => {
  assert.deepEqual(parseCommand("記 買 尿布、牛奶，衛生紙"), { cmd: "noteAdd", category: "buy", items: ["尿布", "牛奶", "衛生紙"] });
  assert.deepEqual(parseCommand("記帶健保卡"), { cmd: "noteAdd", category: "bring", items: ["健保卡"] });
  assert.deepEqual(parseCommand("記做 繳停車費"), { cmd: "noteAdd", category: "todo", items: ["繳停車費"] });
  assert.deepEqual(parseCommand("記 下次問醫生報告"), { cmd: "noteAdd", category: "other", items: ["下次問醫生報告"] });
});
test("notes: 列出、完成、清空、備註；閒聊不觸發", () => {
  assert.deepEqual(parseCommand("記事"), { cmd: "notes" });
  assert.deepEqual(parseCommand("完成 #3 5"), { cmd: "noteDone", ids: [3, 5] });
  assert.deepEqual(parseCommand("記事 清空 買"), { cmd: "noteClear", category: "buy" });
  assert.deepEqual(parseCommand("備註 3 帶健保卡"), { cmd: "label", id: 3, text: "帶健保卡" });
  assert.deepEqual(parseCommand("備註 3"), { cmd: "label", id: 3, text: null });
  assert.equal(parseCommand("今天要買什麼"), null);
});

test("notes: 口語說法", () => {
  const n = (t) => parseCommand(t)?.entries?.map((e) => `${e.category}:${e.text}`);
  assert.deepEqual(n("帶保鮮盒、買麵、買晚餐"), ["bring:保鮮盒", "buy:麵", "buy:晚餐"]);
  assert.deepEqual(n("買麵、晚餐"), ["buy:麵", "buy:晚餐"]);
  assert.deepEqual(n("記得帶大保鮮盒"), ["bring:大保鮮盒"]);
  assert.deepEqual(n("記得要帶健保卡、抽血報告！"), ["bring:健保卡", "bring:抽血報告"]);
  assert.deepEqual(n("別忘了買一些牛奶，尿布"), ["buy:牛奶", "buy:尿布"]);
  assert.deepEqual(n("幫我買個便當"), ["buy:便當"]);
  assert.deepEqual(n("提醒大家記得帶口罩"), ["bring:口罩"]);
  assert.deepEqual(n("記得繳停車費喔"), ["todo:繳停車費"]);
  assert.equal(parseCommand("帶水壺").natural, true);
});
test("notes: 分類查詢", () => {
  const q = (t) => parseCommand(t);
  assert.deepEqual(q("記事"), { cmd: "notes" });
  for (const [t, c] of [["記事 買", "buy"], ["記事買", "buy"], ["記事 買什麼", "buy"], ["記事 買東西", "buy"], ["記事 要買的東西", "buy"],
    ["記事 帶", "bring"], ["記事 帶什麼", "bring"], ["記事 做", "todo"], ["記事 待辦", "todo"], ["記事 出國", "trip"],
    ["記事 出國帶什麼", "trip"], ["記事 其他", "other"],
    ["買什麼", "buy"], ["要買什麼？", "buy"], ["買東西", "buy"], ["要帶什麼", "bring"], ["帶啥", "bring"],
    ["出國帶什麼", "trip"], ["出國要帶什麼?", "trip"], ["出國要買什麼", "trip"]]) {
    assert.deepEqual(q(t), { cmd: "notes", category: c }, t);
  }
  assert.equal(q("記事本好用"), null);
  assert.deepEqual(q("記事 說明"), { cmd: "noteHelp" });
  assert.deepEqual(q("記事說明"), { cmd: "noteHelp" });
  assert.deepEqual(q("記事本 用法"), { cmd: "noteHelp" });
  assert.equal(q("今天要買什麼"), null);
});
test("notes: 出國分類", () => {
  const n = (t) => parseCommand(t)?.entries?.map((e) => `${e.category}:${e.text}`);
  assert.deepEqual(parseCommand("記 出國 護照、轉接頭"), { cmd: "noteAdd", category: "trip", items: ["護照", "轉接頭"] });
  assert.deepEqual(parseCommand("記出國護照"), { cmd: "noteAdd", category: "trip", items: ["護照"] });
  assert.deepEqual(parseCommand("記事 清空 出國"), { cmd: "noteClear", category: "trip" });
  assert.deepEqual(n("出國帶護照、轉接頭"), ["trip:護照", "trip:轉接頭"]);
  assert.deepEqual(n("出國帶 護照跟網卡"), ["trip:護照", "trip:網卡"]);
  assert.deepEqual(n("出國要帶感冒藥"), ["trip:感冒藥"]);
  assert.deepEqual(n("記得出國帶護照"), ["trip:護照"]);
  assert.deepEqual(n("帶護照出國"), ["trip:護照"]);
  assert.deepEqual(n("出國買面膜、帶保鮮盒"), ["trip:買面膜", "bring:保鮮盒"]);
  assert.equal(parseCommand("出國好累"), null);
});
test("notes: 口語說法（跟 / 去哪裡 / 某處要帶 / 多行）", () => {
  const n = (t) => parseCommand(t)?.entries?.map((e) => `${e.category}:${e.text}`);
  assert.deepEqual(n("帶月餅跟餅乾"), ["bring:月餅", "bring:餅乾"]);
  assert.deepEqual(n("帶一包濕紙巾去學校"), ["bring:濕紙巾（學校）"]);
  assert.deepEqual(n("學校要帶一包濕紙巾"), ["bring:濕紙巾（學校）"]);
  assert.deepEqual(n("明天要買牛奶和吐司"), ["buy:牛奶（明天）", "buy:吐司（明天）"]);
  assert.deepEqual(n("帶健保卡到醫院"), ["bring:健保卡（醫院）"]);
  assert.deepEqual(n("帶媽媽手冊"), ["bring:媽媽手冊"]);
  assert.deepEqual(n("買點心"), ["buy:點心"]);
  assert.deepEqual(n("帶很多愛"), ["bring:很多愛"]);
  assert.deepEqual(n("買好多水果"), ["buy:好多水果"]);
  assert.deepEqual(n("帶月餅跟餅乾，帶一包濕紙巾去學校，學校要帶一包濕紙巾"),
    ["bring:月餅", "bring:餅乾", "bring:濕紙巾（學校）"]);
  assert.deepEqual(n("帶月餅跟餅乾\n學校要帶一包濕紙巾"), ["bring:月餅", "bring:餅乾", "bring:濕紙巾（學校）"]);
});
test("notes: 口語說法不誤觸（問句、閒聊）", () => {
  for (const t of ["今天要買什麼？", "要買嗎", "記得嗎", "我要買午餐", "帶小孩去公園", "記得那天很好玩嗎", "哈哈記得帶傘",
    "買了晚餐", "買房子好貴", "帶他去看醫生", "買麵、我晚點回去", "我們要帶小孩去玩", "帶狗狗去散步", "你要買嗎", "買很好吃的", "帶很多不好"]) {
    assert.equal(parseCommand(t), null, t);
  }
});

test("notes: 附圖 / 看圖指令", () => {
  assert.deepEqual(parseCommand("附圖 3"), { cmd: "photoAsk", id: 3 });
  assert.deepEqual(parseCommand("看圖 #3"), { cmd: "photoShow", id: 3 });
  assert.equal(parseCommand("附圖").cmd, "usage");
});

test("menu: 選單指令", () => {
  assert.deepEqual(parseCommand("選單"), { cmd: "menu" });
  assert.deepEqual(parseCommand("menu"), { cmd: "menu" });
  assert.equal(parseCommand("選單好醜"), null);
});
