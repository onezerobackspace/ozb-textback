-- Spending protection and usage warnings (src/spend.js).

-- Set when a client's Twilio spend this month reaches the pause level
-- (SPEND_PAUSE_AT): callers then hear a greeting without the texting promise
-- and leave a voicemail, and no texts go to callers until it's cleared
-- (POST /admin/clients/:id/texting, or Resume texting in the CRM).
-- Texts to the owner still go, under their own caps.
ALTER TABLE clients ADD COLUMN texts_paused_at TEXT;
ALTER TABLE clients ADD COLUMN texts_paused_why TEXT;

-- The 80% and 100% usage emails, once each per client per month.
ALTER TABLE usage ADD COLUMN warned_80 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN warned_100 INTEGER NOT NULL DEFAULT 0;

-- Each Twilio usage-trigger callback, once (Twilio may retry a callback).
CREATE TABLE spend_alerts (
  id            INTEGER PRIMARY KEY,
  account_sid   TEXT NOT NULL,
  trigger_sid   TEXT,
  trigger_value REAL,
  current_value REAL,
  idempotency   TEXT UNIQUE,
  action        TEXT NOT NULL,              -- 'alert' or 'pause'
  at            TEXT NOT NULL
);
