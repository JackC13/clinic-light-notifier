-- 改用臺大「DeptLightTable」列表：記錄院區、時段、診次 ID、醫師、診間
ALTER TABLE trackings ADD COLUMN hosp TEXT;         -- 院區代碼，例如 CH
ALTER TABLE trackings ADD COLUMN ampm INTEGER;      -- 1 上午 2 下午 3 夜間
ALTER TABLE trackings ADD COLUMN service_id TEXT;   -- ServiceIDSE
ALTER TABLE trackings ADD COLUMN doctor TEXT;
ALTER TABLE trackings ADD COLUMN room TEXT;

-- 選好診、等使用者回覆號碼
CREATE TABLE IF NOT EXISTS pending (
  chat_id    TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  hosp       TEXT    NOT NULL,
  ampm       INTEGER NOT NULL,
  service_id TEXT    NOT NULL,
  label      TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
