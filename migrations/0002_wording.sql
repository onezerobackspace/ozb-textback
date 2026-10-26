-- Wording versions: every greeting and first text a client has used, kept for
-- good (it's the record of what callers agreed to), and the version each call
-- heard. Clients edit their wording in the client portal (crm/src/portal.js),
-- which saves through /admin/clients/:id/wording.

CREATE TABLE wording_versions (
  id          INTEGER PRIMARY KEY,
  client_id   INTEGER NOT NULL REFERENCES clients(id),
  greeting    TEXT NOT NULL,
  first_text  TEXT NOT NULL,
  by          TEXT,                       -- 'setup', or the portal user's email
  at          TEXT NOT NULL
);
CREATE INDEX wording_versions_client ON wording_versions (client_id, id);

-- The version the caller heard (NULL for calls before this table existed).
ALTER TABLE calls ADD COLUMN wording_version INTEGER;

-- 0: the wording is quoted on a page we edit by hand (OZB's
-- onezerobackspace.com/texting/, checked by test/wording.test.mjs), so the
-- portal can't change it. 1: the published page is /texting/<id> on this
-- worker, built from the database, so it changes with the wording.
ALTER TABLE clients ADD COLUMN wording_editable INTEGER NOT NULL DEFAULT 1;
UPDATE clients SET wording_editable = 0 WHERE id = 1;

-- Each existing client's current wording is its first version.
INSERT INTO wording_versions (client_id, greeting, first_text, by, at)
  SELECT id, greeting, first_text, 'setup', created_at FROM clients;
