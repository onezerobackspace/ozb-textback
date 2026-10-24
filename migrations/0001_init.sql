-- Missed-call text-back. One row in clients per business; OZB itself is #1.
-- Times are ISO 8601 UTC strings. Phone numbers are E.164 (+14125550123).

CREATE TABLE clients (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL,              -- as callers know it; the first text starts with it
  legal_name            TEXT NOT NULL,              -- as on the toll-free verification
  owner_name            TEXT NOT NULL,
  owner_cell            TEXT NOT NULL,              -- gets voicemails and callers' texts; replies from it are relayed
  owner_email           TEXT,                       -- gets every voicemail by email too: works before the number is verified
  support_email         TEXT,                       -- named in the HELP reply
  support_phone         TEXT,                       -- named in the HELP reply (E.164)
  twilio_subaccount_sid TEXT,                       -- NULL: the number is on OZB's main account
  number                TEXT NOT NULL UNIQUE,       -- the client's Twilio number (toll-free)
  greeting              TEXT NOT NULL,              -- read to the caller; must disclose the text (src/rules.js)
  first_text            TEXT NOT NULL,              -- sent exactly as written: it must match the verified sample
  lookup_landlines      INTEGER NOT NULL DEFAULT 0, -- 1: Twilio Lookup each caller ($0.008) and skip landlines
  twilio_opt_out        INTEGER NOT NULL DEFAULT 1, -- 1: Twilio answers STOP/START/HELP itself, so we don't
  daily_text_cap        INTEGER NOT NULL DEFAULT 15,-- first texts in any 24 hours, a brake on spoofed-call floods
  hourly_text_cap       INTEGER NOT NULL DEFAULT 8, -- first texts in any hour; past it the owner is told once
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at            TEXT NOT NULL,
  paused_at             TEXT,
  notes                 TEXT
);

-- Each forwarded call that reached the greeting.
CREATE TABLE calls (
  id               INTEGER PRIMARY KEY,
  client_id        INTEGER NOT NULL REFERENCES clients(id),
  call_sid         TEXT NOT NULL UNIQUE,
  from_number      TEXT NOT NULL,              -- as Twilio gave it: may be "anonymous" or a short code
  to_number        TEXT NOT NULL,
  forwarded_from   TEXT,
  stir_verstat     TEXT,                       -- Twilio's StirVerstat (caller ID check), as given
  heard_disclosure INTEGER NOT NULL DEFAULT 0, -- 1: the greeting played through the texting disclosure (/voice/heard)
  at               TEXT NOT NULL,
  answered         INTEGER NOT NULL DEFAULT 0, -- 1 once Twilio reports the call completed
  call_status      TEXT,
  seconds          INTEGER,
  recording_sid    TEXT,
  voicemail_url    TEXT,                       -- Twilio's RecordingUrl (needs credentials; owners get /vm/ links)
  voicemail_seconds INTEGER,
  recording_deleted_at TEXT,                   -- the retention cron deleted it at Twilio
  owner_notified   INTEGER NOT NULL DEFAULT 0,
  texted           INTEGER NOT NULL DEFAULT 0, -- 1: the first text was sent for this call
  why_not_texted   TEXT                        -- e.g. hung-up-in-greeting, opted-out, recent, anonymous, owner, send-failed
);
CREATE INDEX calls_client_from ON calls (client_id, from_number, at);
CREATE INDEX calls_at ON calls (at);

-- direction: in    = a text to the client number
--            out   = written by this worker (first text, voicemail notice, confirmations)
--            relay = someone else's words passed on (owner -> caller, caller -> owner)
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY,
  client_id   INTEGER NOT NULL REFERENCES clients(id),
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out', 'relay')),
  kind        TEXT NOT NULL,                  -- first, voicemail, notice, receipt, held, confirm, help, inbound, owner, forward, reply
  call_id     INTEGER,
  from_number TEXT NOT NULL,
  to_number   TEXT NOT NULL,
  body        TEXT NOT NULL,
  twilio_sid  TEXT UNIQUE,
  status      TEXT,
  error_code  TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX messages_client_at ON messages (client_id, at);
CREATE INDEX messages_at ON messages (at);

-- Kept when everything else is deleted: an opt-out must outlive the 90 days.
CREATE TABLE opt_outs (
  client_id INTEGER NOT NULL REFERENCES clients(id),
  phone     TEXT NOT NULL,
  at        TEXT NOT NULL,
  keyword   TEXT NOT NULL,                    -- what they sent, or "error-21610" when Twilio refused a send
  UNIQUE (client_id, phone)
);

-- Per client per Eastern calendar month ("2026-10"), for the plan's allowance.
CREATE TABLE usage (
  client_id     INTEGER NOT NULL REFERENCES clients(id),
  month         TEXT NOT NULL,
  texts_out     INTEGER NOT NULL DEFAULT 0,
  texts_in      INTEGER NOT NULL DEFAULT 0,
  voice_minutes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, month)
);
