-- 記事與追蹤的歷史紀錄（誰、什麼時候、做了什麼）
CREATE TABLE IF NOT EXISTS history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT    NOT NULL,
  kind       TEXT    NOT NULL,   -- note / track
  action     TEXT    NOT NULL,   -- add / done / delete / undo / edit / clear / cancel / end
  ref_id     INTEGER,
  text       TEXT    NOT NULL,
  user_id    TEXT,
  user_name  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_chat ON history (chat_id, created_at);

-- 成員顯示名稱快取（LINE 個人資料）
CREATE TABLE IF NOT EXISTS members (
  chat_id    TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

-- 每個人最近傳的一張照片（只記訊息編號，給「小弟 幫我看這張」用）
CREATE TABLE IF NOT EXISTS last_media (
  chat_id    TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  message_id TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
