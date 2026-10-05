-- 群組記事本：買 / 帶 / 做 / 其他
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT    NOT NULL,
  category   TEXT    NOT NULL,   -- buy / bring / todo / other
  text       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_chat ON notes (chat_id);
