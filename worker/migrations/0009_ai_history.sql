-- AI 小幫手的對話紀錄（每個聊天室保留最近幾輪，讓追問接得上）
CREATE TABLE IF NOT EXISTS ai_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT    NOT NULL,
  role       TEXT    NOT NULL,   -- user / assistant
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_history_chat ON ai_history (chat_id, created_at);
