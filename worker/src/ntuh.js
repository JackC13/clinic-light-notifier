// 臺大醫院「當日看診進度」
//
//   GET  /WebReg/WebReg/ClinicCurrentLightNo?vHospCode=CH   → 頁面含 __RequestVerificationToken + cookie
//   POST /WebReg/WebReg/DeptLightTable                      → 該院區、該時段所有診的燈號（DeptCode 沒有作用）
//        body: __RequestVerificationToken, vHospitalCode, DeptCode, RegionCode, AmpmCode(1 上午 2 下午 3 夜間)
//   沒帶 token 會回 404。

export const HOSPITALS = [
  { code: "T0", name: "總院", aliases: ["總院", "台大", "臺大", "本院"] },
  { code: "CH", name: "兒童醫院", aliases: ["兒童", "兒醫", "兒童醫院", "兒童院"] },
  { code: "C0", name: "癌醫中心", aliases: ["癌醫", "癌醫中心"] },
  { code: "T2", name: "北護分院", aliases: ["北護"] },
  { code: "T3", name: "金山分院", aliases: ["金山"] },
  { code: "T4", name: "新竹醫院", aliases: ["新竹"] },
  { code: "T7", name: "生醫醫院", aliases: ["生醫", "竹北"] },
  { code: "Y0", name: "雲林分院", aliases: ["雲林"] },
];

export const AMPM = { 1: "上午", 2: "下午", 3: "夜間" };
const AMPM_ALIASES = { 上午: 1, 早上: 1, 早診: 1, 下午: 2, 午診: 2, 夜間: 3, 晚上: 3, 夜診: 3 };

export function hospitalByAlias(token) {
  return HOSPITALS.find((h) => h.aliases.includes(token) || h.name === token)?.code ?? null;
}
export const ampmByAlias = (token) => AMPM_ALIASES[token] ?? null;
export const hospitalName = (code) => HOSPITALS.find((h) => h.code === code)?.name ?? code;

/** 依台北時間推測目前時段 */
export function currentAmpm(now) {
  const h = parseInt(
    new Date(now).toLocaleString("en-US", { timeZone: "Asia/Taipei", hour: "numeric", hour12: false }),
    10,
  );
  return h < 12 ? 1 : h < 17 ? 2 : 3;
}

export function detailUrl(base, hosp, sid) {
  return `${base}/WebReg/WebReg/ClinicCurrentLightNoDetail?ServiceIDSE=${sid}&vHospitalCode=${hosp}`;
}

/** 解析燈號頁網址中的 ServiceIDSE / vHospitalCode */
export function parseDetailUrl(url) {
  try {
    const u = new URL(url);
    const sid = u.searchParams.get("ServiceIDSE");
    const hosp = u.searchParams.get("vHospitalCode") ?? u.searchParams.get("vHospCode");
    if (!sid || !/^\d+$/.test(sid) || !hosp) return null;
    return { host: u.hostname.toLowerCase(), sid, hosp: hosp.toUpperCase() };
  } catch {
    return null;
  }
}

// ───────────── 解析 DeptLightTable ─────────────

const strip = (s) =>
  s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;|　/g, " ").replace(/\s+/g, " ").trim();

export function parseTable(html) {
  const updatedAt = html.match(/最後更新時間[:：]\s*([\d\-: ]+)/)?.[1]?.trim() ?? null;
  const clinics = [];
  for (const block of html.split(/class="clinic-room-number/).slice(1)) {
    const sid = block.match(/ServiceIDSE=(\d+)/)?.[1];
    if (!sid) continue;
    const pick = (cls) => {
      const m = block.match(new RegExp(`class="${cls}[^"]*">([\\s\\S]*?)</div>`));
      return m ? strip(m[1]) : "";
    };
    const numText = pick("number");
    const digits = numText.replace(/\D/g, "");
    clinics.push({
      sid,
      hosp: block.match(/vHospitalCode=(\w+)/)?.[1] ?? null,
      room: pick("room-number").replace(/\s+/g, ""),
      doctor: pick("clinic-doc-name"),
      type: pick("clinic-type"),
      number: digits ? parseInt(digits, 10) : null, // null = 尚未開始看診
      note: pick("according-to-order"),
      byCheckin: /報到順序/.test(pick("according-to-order")), // 依報到順序看診：燈號不照號碼順序
    });
  }
  return { updatedAt, clinics };
}

// ───────────── 解析個別診的燈號頁 ClinicCurrentLightNoDetail ─────────────
//
//   目前燈號、已叫最大號、預計叫號（醫院排好的接下來幾位，含敬老號）、
//   所有燈號狀態（還沒看完的號碼：看診中 / 已報到 / 未報到 / 初診；看完的會消失）

const TAGS = { "onCall-tag": "oncall", "checkIn-tag": "checkin", "not-checkIn-tag": "notin", "first-tag": "first" };
const toInt = (s) => {
  const d = String(s ?? "").replace(/\D/g, "");
  return d ? parseInt(d, 10) : null;
};

export function parseDetail(html) {
  const section = (cls, endCls) => {
    const i = html.indexOf(`class="${cls}"`);
    if (i < 0) return "";
    const j = endCls ? html.indexOf(`class="${endCls}"`, i) : -1;
    return html.slice(i, j > i ? j : undefined);
  };
  const numberIn = (block) => toInt(block.match(/class="number">([\s\S]*?)<\/div>/)?.[1]);

  const nowBlock = section("now-number", "biggest-number");
  const expectedBlock = section("next-number", "clinic-progress");
  const progressBlock = section("clinic-progress", "number-explain");

  const statuses = [];
  const re = /class="progress-number">\s*(\d+)[\s\S]*?class="([\w-]+-tag)"/g;
  for (let m; (m = re.exec(progressBlock)); ) statuses.push({ n: parseInt(m[1], 10), status: TAGS[m[2]] ?? m[2] });

  const expected = [];
  const er = /class="expected-item">[\s\S]*?class="number">([^<]*)<\/span>[\s\S]*?class="type">([^<]*)<\/span>/g;
  for (let m; (m = er.exec(expectedBlock)); ) {
    const n = toInt(m[1]);
    if (n !== null) expected.push({ n, type: strip(m[2]).replace(/[()（）]/g, "") });
  }

  return {
    updatedAt: html.match(/最後更新時間[:：]\s*([\d\-: ]+)/)?.[1]?.trim() ?? null,
    room: strip(section("room-number", "doc-name").replace(/^[^>]*>/, "").split("</div>")[0] ?? ""),
    current: numberIn(nowBlock),
    maxCalled: numberIn(section("biggest-number", "next-number")),
    expected,
    statuses,
  };
}

// ───────────── 抓取（含 token / cookie） ─────────────

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const SESSION_TTL = 15 * 60_000;
let session = null; // 同一個 isolate 內重複使用

export const baseUrl = (env) => (env.NTUH_BASE || "https://reg.ntuh.gov.tw").replace(/\/$/, "");

function cookiesFrom(res) {
  const list =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : typeof res.headers.getAll === "function"
        ? res.headers.getAll("Set-Cookie")
        : [res.headers.get("Set-Cookie")].filter(Boolean);
  return list.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
}

let sessionPromise = null; // 同時多個查詢時共用同一次 token 請求

function getSession(env, force = false) {
  if (!force && session && Date.now() - session.at < SESSION_TTL) return Promise.resolve(session);
  if (!sessionPromise) {
    sessionPromise = loadSession(env).finally(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

async function loadSession(env) {
  const res = await fetch(`${baseUrl(env)}/WebReg/WebReg/ClinicCurrentLightNo?vHospCode=T0`, {
    headers: { "User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`取得查詢頁失敗 HTTP ${res.status}`);
  const html = await res.text();
  const input = html.match(/<input[^>]*name="__RequestVerificationToken"[^>]*>/)?.[0];
  const token = input?.match(/value="([^"]*)"/)?.[1];
  if (!token) throw new Error("查詢頁找不到驗證 token");
  session = { token, cookie: cookiesFrom(res), at: Date.now() };
  return session;
}

/** 取得某院區某時段的所有診；失敗會丟出例外 */
export async function fetchTable(env, hosp, ampm) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(env, attempt > 0);
    const body = new URLSearchParams({
      __RequestVerificationToken: s.token,
      vHospitalCode: hosp,
      DeptCode: "",
      RegionCode: "",
      AmpmCode: String(ampm),
    });
    const res = await fetch(`${baseUrl(env)}/WebReg/WebReg/DeptLightTable`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Accept-Language": "zh-TW,zh;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${baseUrl(env)}/WebReg/WebReg/ClinicCurrentLightNo?vHospCode=${hosp}`,
        ...(s.cookie ? { Cookie: s.cookie } : {}),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return parseTable(await res.text());
    // token 過期時醫院回 404/400：重新取 token 再試一次
    if (attempt === 0 && [400, 403, 404].includes(res.status)) continue;
    throw new Error(`HTTP ${res.status}`);
  }
}

/** 取得個別診的燈號頁（不需要 token）；失敗會丟出例外 */
export async function fetchDetail(env, hosp, sid) {
  const res = await fetch(detailUrl(baseUrl(env), hosp, sid), {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "zh-TW,zh;q=0.9",
      ...(session?.cookie ? { Cookie: session.cookie } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`燈號頁 HTTP ${res.status}`);
  return parseDetail(await res.text());
}

/** 測試用：清除快取的 token */
export function _resetSession() {
  session = null;
  sessionPromise = null;
}
