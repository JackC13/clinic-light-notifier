-- 記事附圖：圖片存在 KV（IMAGES），這裡只記 key
ALTER TABLE notes ADD COLUMN image_key TEXT;

-- 按了「附圖」、等這個人傳照片
CREATE TABLE IF NOT EXISTS pending_photo (
  chat_id    TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  note_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
