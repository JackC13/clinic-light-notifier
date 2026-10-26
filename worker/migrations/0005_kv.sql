-- 暫存臺大查詢頁的驗證 token 與 cookie，讓不同的 Worker 執行個體共用，減少請求
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
