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

-- Guest replies to live invitations. A guest may reply more than once; the newest reply counts.
CREATE TABLE IF NOT EXISTS rsvps (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invitation_slug TEXT NOT NULL,
  guest_key       TEXT,
  name            TEXT NOT NULL,
  attending       TEXT NOT NULL,      -- yes | no
  count           INTEGER NOT NULL DEFAULT 0,
  meals           TEXT,               -- JSON array, one choice per guest
  dietary         TEXT,
  song            TEXT,
  message         TEXT,
  ip              TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rsvps_slug ON rsvps (invitation_slug, created_at);
CREATE INDEX IF NOT EXISTS rsvps_ip_time ON rsvps (ip, created_at);

-- Each live invitation's private couple-panel link and package.
CREATE TABLE IF NOT EXISTS invitation_access (
  invitation_slug TEXT PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,
  tier            TEXT NOT NULL DEFAULT 'basic',   -- basic | guests
  created_at      INTEGER NOT NULL
);

-- When each guest first opened their personal link.
CREATE TABLE IF NOT EXISTS guest_views (
  invitation_slug TEXT NOT NULL,
  key             TEXT NOT NULL,
  first_at        INTEGER NOT NULL,
  last_at         INTEGER NOT NULL,
  views           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (invitation_slug, key)
);
