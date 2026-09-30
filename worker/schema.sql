-- 追蹤中的看診（到號、取消或逾時後刪除）
CREATE TABLE IF NOT EXISTS trackings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       TEXT    NOT NULL,           -- 群組 / 聊天室 / 使用者 ID
  url           TEXT    NOT NULL,           -- 燈號頁網址
  my_number     INTEGER NOT NULL,
  label         TEXT,                       -- 備註，例如「小孩腸胃科」
  last_number   INTEGER,                    -- 最後讀到的燈號；NULL = 尚未開診
  sent          TEXT    NOT NULL DEFAULT '',-- 已推播過的門檻，例如 "10,5"
  fail_count    INTEGER NOT NULL DEFAULT 0,
  fail_alerted  INTEGER NOT NULL DEFAULT 0,
  drop_alerted  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,           -- epoch ms
  next_check_at INTEGER NOT NULL            -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_trackings_next ON trackings (next_check_at);
CREATE INDEX IF NOT EXISTS idx_trackings_chat ON trackings (chat_id);
