-- 依報到順序計算：報到狀態、報到當下排在前面的號碼、一次性提醒
ALTER TABLE trackings ADD COLUMN checkin_state TEXT;   -- NULL / no / yes / approx
ALTER TABLE trackings ADD COLUMN ahead TEXT;           -- JSON 陣列
ALTER TABLE trackings ADD COLUMN ahead_left INTEGER;   -- 前面還剩幾位
ALTER TABLE trackings ADD COLUMN alerts TEXT NOT NULL DEFAULT '';
