-- 該診是否「依報到順序看診」（燈號不照號碼順序）
ALTER TABLE trackings ADD COLUMN by_checkin INTEGER NOT NULL DEFAULT 0;
