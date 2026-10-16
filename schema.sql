-- Try-on previews. One row each time someone taps "Try with your names".
CREATE TABLE IF NOT EXISTS drafts (
  id          TEXT PRIMARY KEY,
  template    TEXT NOT NULL,
  email       TEXT NOT NULL,
  data        TEXT NOT NULL,          -- JSON: { couple, selectedEvents }
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_ip_time    ON drafts (ip, created_at);
CREATE INDEX IF NOT EXISTS drafts_email_time ON drafts (email, created_at);

-- Paid invitations, live at /<slug>.
CREATE TABLE IF NOT EXISTS invitations (
  slug        TEXT PRIMARY KEY,
  template    TEXT NOT NULL,
  data        TEXT NOT NULL,          -- JSON, merged over the theme's sample content
  status      TEXT NOT NULL DEFAULT 'live',   -- live | hidden
  draft_id    TEXT,
  email       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Guest links, live at /<slug>/<key>.
CREATE TABLE IF NOT EXISTS guests (
  invitation_slug TEXT NOT NULL,
  key             TEXT NOT NULL,
  name            TEXT NOT NULL,
  seats           INTEGER,
  events          TEXT,               -- JSON array of event keys, NULL = all
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (invitation_slug, key)
);
