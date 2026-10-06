-- 指定時間提醒（「提醒 明天 8點 帶傘」，或帶日期的記事「10/8 帶月餅」）
CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  due_at     INTEGER NOT NULL,
  note_ids   TEXT,             -- 連結的記事（逗號分隔）；記事都完成了就不提醒
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (due_at);
CREATE INDEX IF NOT EXISTS idx_reminders_chat ON reminders (chat_id);
