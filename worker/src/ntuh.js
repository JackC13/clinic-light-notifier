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
    doctor: strip(section("doc-name", "now-number").replace(/^[^>]*>/, "").split("</div>")[0] ?? ""),
    current: numberIn(nowBlock),
    maxCalled: numberIn(section("biggest-number", "next-number")),
    expected,
    statuses,
  };
}

// ───────────── 抓取（含 token / cookie） ─────────────

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const SESSION_TTL = 20 * 60_000;
let session = null; // 同一個 isolate 內重複使用

export const baseUrl = (env) => (env.NTUH_BASE || "https://reg.ntuh.gov.tw").replace(/\/$/, "");

function setCookies(res) {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  if (typeof res.headers.getAll === "function") return res.headers.getAll("Set-Cookie");
  const one = res.headers.get("Set-Cookie");
  return one ? [one] : [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 5xx 或連線失敗時重試（醫院網站偶爾回 520），最多 3 次 */
async function withRetry(fn, trace = null) {
  const delays = [1000, 2000];
  for (let i = 0; ; i++) {
    try {
      const res = await fn();
      if (res.status < 500 || i >= delays.length) return res;
      trace?.push(`↻ HTTP ${res.status}，${delays[i] / 1000} 秒後重試`);
    } catch (e) {
      if (i >= delays.length) throw e;
      trace?.push(`↻ ${e.message}，${delays[i] / 1000} 秒後重試`);
    }
    await sleep(delays[i]);
  }
}

/** 簡易 cookie jar：手動跟隨轉址，保留每一站設定的 cookie（瀏覽器的行為） */
async function jarFetch(jar, url, init = {}, trace = null) {
  let current = url;
  let opts = { ...init };
  for (let hop = 0; hop < 6; hop++) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(current, {
      ...opts,
      redirect: "manual",
      headers: { ...(opts.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    const names = [];
    for (const c of setCookies(res)) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (i > 0) {
        jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        names.push(pair.slice(0, i).trim());
      }
    }
    const loc = res.headers.get("Location");
    trace?.push(`${opts.method ?? "GET"} ${new URL(current).pathname} → ${res.status}${loc ? ` ⇒ ${loc}` : ""}${names.length ? `｜cookie: ${names.join(", ")}` : ""}`);
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      if (res.status !== 307 && res.status !== 308) opts = { ...opts, method: "GET", body: undefined };
      continue;
    }
    return res;
  }
  throw new Error("轉址次數過多");
}

let sessionPromise = null; // 同時多個查詢時共用同一次 token 請求

function getSession(env, force = false) {
  if (!force && session && Date.now() - session.at < SESSION_TTL) return Promise.resolve(session);
  if (!sessionPromise) {
    sessionPromise = (async () => {
      if (!force) {
        const saved = await loadSavedSession(env);
        if (saved) return (session = saved);
      }
      const s = await loadSession(env);
      await saveSession(env, s);
      return s;
    })().finally(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

const KV_KEY = "ntuh_session";

async function loadSavedSession(env) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare("SELECT value, updated_at FROM kv WHERE key = ?").bind(KV_KEY).first();
    if (!row || Date.now() - row.updated_at > SESSION_TTL) return null;
    const v = JSON.parse(row.value);
    return { token: v.token, jar: new Map(v.jar), at: row.updated_at };
  } catch {
    return null; // 還沒建 kv 表等情況：當作沒有
  }
}

async function saveSession(env, s) {
  if (!env.DB) return;
  try {
    await env.DB.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(KV_KEY, JSON.stringify({ token: s.token, jar: [...s.jar] }), s.at).run();
  } catch (e) {
    console.warn("儲存 token 失敗", e.message);
  }
}

async function loadSession(env, trace = null) {
  const jar = new Map();
  const res = await withRetry(() => jarFetch(jar, `${baseUrl(env)}/WebReg/WebReg/ClinicCurrentLightNo?vHospCode=T0`, {
    headers: { "User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9" },
  }, trace), trace);
  if (!res.ok) throw new Error(`臺大查詢頁暫時沒有回應（HTTP ${res.status}），請稍後再試`);
  const html = await res.text();
  const input = html.match(/<input[^>]*name="__RequestVerificationToken"[^>]*>/)?.[0];
  const token = input?.match(/value="([^"]*)"/)?.[1];
  trace?.push(`查詢頁 ${html.length} 字元｜token ${token ? `${token.length} 字元` : "找不到"}`);
  if (!token) throw new Error("查詢頁找不到驗證 token");
  session = { token, jar, at: Date.now() };
  return session;
}

async function postTable(env, s, hosp, ampm, trace = null) {
  const body = new URLSearchParams({
    __RequestVerificationToken: s.token,
    vHospitalCode: hosp,
    DeptCode: "",
    RegionCode: "",
    AmpmCode: String(ampm),
  });
  return withRetry(() => jarFetch(s.jar, `${baseUrl(env)}/WebReg/WebReg/DeptLightTable`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Accept-Language": "zh-TW,zh;q=0.9",
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Origin: baseUrl(env),
      Referer: `${baseUrl(env)}/WebReg/WebReg/ClinicCurrentLightNo?vHospCode=${hosp}`,
    },
    body,
  }, trace), trace);
}

/** 取得某院區某時段的所有診；失敗會丟出例外 */
export async function fetchTable(env, hosp, ampm) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(env, attempt > 0);
    const res = await postTable(env, s, hosp, ampm);
    if (res.ok) return parseTable(await res.text());
    // token 過期時醫院回 404/400：重新取 token 再試一次
    if (attempt === 0 && [400, 403, 404].includes(res.status)) continue; // getSession(force) 會重取並存回
    const snippet = strip(await res.text()).slice(0, 120);
    console.error(`DeptLightTable ${hosp}/${ampm} HTTP ${res.status}: ${snippet}`);
    throw new Error(`HTTP ${res.status}`);
  }
}

/** 診斷：一步一步記錄與醫院的往來 */
export async function diagnose(env, hosp, ampm) {
  const trace = [];
  try {
    const s = await loadSession(env, trace);
    trace.push(`cookie jar：${[...s.jar.keys()].join(", ") || "（空）"}`);
    const res = await postTable(env, s, hosp, ampm, trace);
    const html = await res.text();
    if (!res.ok) {
      trace.push(`列表回應：${strip(html).slice(0, 150) || "（空）"}`);
      return trace;
    }
    const t = parseTable(html);
    trace.push(`列表：${t.clinics.length} 診｜更新 ${t.updatedAt ?? "?"}`);
    const c = t.clinics.find((x) => x.number !== null) ?? t.clinics[0];
    if (c) {
      const d = await fetchDetail(env, hosp, c.sid);
      trace.push(`燈號頁 ${c.room} ${c.doctor}：燈號 ${d.current ?? "－"}｜最大號 ${d.maxCalled ?? "－"}｜清單 ${d.statuses.length} 個號碼`);
    }
  } catch (e) {
    trace.push(`❌ ${e.message}`);
  }
  return trace;
}

/** 取得個別診的燈號頁（不需要 token）；失敗會丟出例外 */
export async function fetchDetail(env, hosp, sid) {
  const res = await withRetry(() => fetch(detailUrl(baseUrl(env), hosp, sid), {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "zh-TW,zh;q=0.9",
      ...(session?.jar?.size ? { Cookie: [...session.jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  }));
  if (!res.ok) throw new Error(`燈號頁 HTTP ${res.status}`);
  return parseDetail(await res.text());
}

/** 測試用：清除快取的 token */
export function _resetSession() {
  session = null;
  sessionPromise = null;
}
