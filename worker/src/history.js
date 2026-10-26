// 歷史紀錄：記事、追蹤的新增 / 完成 / 刪除 / 修改，記下是誰、什麼時候
import { getMemberName } from "./line.js";
import { formatWhen } from "./when.js";

const NAME_TTL = 7 * 86400_000;
export const SYSTEM_NAME = "🤖 系統";

/** 成員顯示名稱（快取 7 天） */
export async function memberName(env, chatId, userId) {
  if (!userId) return SYSTEM_NAME;
  const db = env.DB;
  const row = await db.prepare("SELECT name, updated_at FROM members WHERE chat_id = ? AND user_id = ?").bind(chatId, userId).first();
  const now = Date.now();
  if (row && now - row.updated_at < NAME_TTL) return row.name;
  const name = await getMemberName(env, chatId, userId);
  if (!name) return row?.name ?? "（某人）";
  await db.prepare("INSERT OR REPLACE INTO members (chat_id, user_id, name, updated_at) VALUES (?, ?, ?, ?)")
    .bind(chatId, userId, name, now).run();
  return name;
}

/**
 * 寫入歷史紀錄（失敗不影響主要功能）
 * @param {{env, chatId, userId?, now}} ctx
 * @param {{kind: "note"|"track", action: string, ref_id?: number, text: string}[]} items
 * @param {{system?: boolean}} opt  system=true 表示機器人自己做的（到號、超時）
 */
export async function logHistory(ctx, items, opt = {}) {
  if (!items?.length) return;
  try {
    const userId = opt.system ? null : ctx.userId || null;
    const name = opt.system ? SYSTEM_NAME : await memberName(ctx.env, ctx.chatId, userId);
    const db = ctx.env.DB;
    await db.batch(items.map((it) => db.prepare(
      "INSERT INTO history (chat_id, kind, action, ref_id, text, user_id, user_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(ctx.chatId, it.kind, it.action, it.ref_id ?? null, String(it.text).slice(0, 80), userId, name, ctx.now)));
  } catch (e) {
    console.error("history:", e);
  }
}

export const ACTION_LABEL = {
  "note:add": "＋ 記下", "note:done": "✔️ 完成", "note:delete": "🗑 刪除", "note:undo": "↩️ 撤銷",
  "note:edit": "✏️ 修改", "note:clear": "🧹 清空",
  "track:add": "🩺 開始追蹤", "track:cancel": "⏹ 取消追蹤", "track:end": "🏁 結束追蹤",
};

export function formatHistoryLine(h, now) {
  const when = formatWhen(h.created_at, now).replace(/（.）/, " ");
  const label = ACTION_LABEL[`${h.kind}:${h.action}`] ?? h.action;
  return `${when}｜${h.user_name ?? SYSTEM_NAME}｜${label} ${h.text}`;
}

const MAX_SHOW = 25;

/** 「歷史」「歷史 記事」「歷史 追蹤」「歷史 牛奶」 */
export async function historyReply(ctx, { kind = null, keyword = null } = {}) {
  const where = ["chat_id = ?"];
  const args = [ctx.chatId];
  if (kind) { where.push("kind = ?"); args.push(kind); }
  if (keyword) { where.push("(text LIKE ? OR user_name LIKE ?)"); args.push(`%${keyword}%`, `%${keyword}%`); }
  const { results } = await ctx.env.DB.prepare(
    `SELECT * FROM history WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(...args, MAX_SHOW).all();
  const title = keyword ? `📜 「${keyword}」的紀錄` : kind === "note" ? "📜 記事紀錄" : kind === "track" ? "📜 追蹤紀錄" : "📜 最近紀錄";
  if (!results.length) return `${title}\n\n還沒有紀錄。`;
  return [`${title}（最近 ${results.length} 筆）`, "", ...results.map((h) => formatHistoryLine(h, ctx.now))].join("\n");
}

/** 給 AI 看的最近紀錄（精簡） */
export async function recentHistoryText(ctx, limit = 15) {
  const { results } = await ctx.env.DB.prepare("SELECT * FROM history WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .bind(ctx.chatId, limit).all();
  return results.map((h) => formatHistoryLine(h, ctx.now)).join("；");
}
