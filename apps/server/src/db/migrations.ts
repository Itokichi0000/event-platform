/**
 * Schema migrations, applied in order and tracked with PRAGMA user_version.
 * Any change here must be reflected in docs/PRIVACY.md in the same commit.
 *
 * Note what is absent: there is no table describing participants, and no column links an
 * issuance to a payment, a redemption, an IP address or a time of entry.
 */
export const MIGRATIONS: string[] = [
  /* 1: phase 1 (free events) */ `
  CREATE TABLE hosts (
    pubkey TEXT PRIMARY KEY
  ) WITHOUT ROWID;

  CREATE TABLE events (
    id                  TEXT PRIMARY KEY,
    host_pubkey         TEXT NOT NULL REFERENCES hosts(pubkey),
    title               TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    starts_at           INTEGER NOT NULL,
    ends_at             INTEGER NOT NULL,
    location            TEXT NOT NULL DEFAULT '',
    location_visibility TEXT NOT NULL DEFAULT 'public'
                        CHECK (location_visibility IN ('public', 'ticket_holders')),
    capacity            INTEGER NOT NULL CHECK (capacity > 0),
    issue_policy        TEXT NOT NULL DEFAULT 'pow' CHECK (issue_policy IN ('pow')),
    price_msat          INTEGER NOT NULL DEFAULT 0,
    issued_count        INTEGER NOT NULL DEFAULT 0,
    redeemed_count      INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'cancelled')),
    cover_image         BLOB,
    cover_mime          TEXT,
    cover_version       INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );
  CREATE INDEX events_host ON events(host_pubkey);

  CREATE TABLE keysets (
    id              TEXT PRIMARY KEY,
    event_id        TEXT REFERENCES events(id) ON DELETE CASCADE,
    host_pubkey     TEXT REFERENCES hosts(pubkey),
    kind            TEXT NOT NULL CHECK (kind IN ('ticket', 'room', 'stamp')),
    public_key      TEXT NOT NULL,
    private_key_enc TEXT,
    CHECK ((event_id IS NULL) <> (host_pubkey IS NULL))
  );
  CREATE INDEX keysets_event ON keysets(event_id);

  -- WITHOUT ROWID: rows are ordered by key, so storage order does not reveal redemption order.
  CREATE TABLE spent (
    keyset_id TEXT NOT NULL REFERENCES keysets(id) ON DELETE CASCADE,
    y         TEXT NOT NULL,
    PRIMARY KEY (keyset_id, y)
  ) WITHOUT ROWID;

  -- Aggregate check-ins per 15 minutes for the dashboard chart. Counts only; no link to spent.y.
  CREATE TABLE checkin_buckets (
    event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    bucket_start INTEGER NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, bucket_start)
  ) WITHOUT ROWID;

  CREATE TABLE announcements (
    id         TEXT PRIMARY KEY,
    event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX announcements_event ON announcements(event_id, created_at);

  CREATE TABLE scanner_links (
    id         TEXT PRIMARY KEY,
    event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    label      TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX scanner_links_event ON scanner_links(event_id);
  `,
  /* 2: phase 2 (paid tickets, invite codes, co-hosts, offline check-in, returns) */ `
  CREATE TABLE events_v2 (
    id                  TEXT PRIMARY KEY,
    host_pubkey         TEXT NOT NULL REFERENCES hosts(pubkey),
    title               TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    starts_at           INTEGER NOT NULL,
    ends_at             INTEGER NOT NULL,
    location            TEXT NOT NULL DEFAULT '',
    location_visibility TEXT NOT NULL DEFAULT 'public'
                        CHECK (location_visibility IN ('public', 'ticket_holders')),
    capacity            INTEGER NOT NULL CHECK (capacity > 0),
    issue_policy        TEXT NOT NULL DEFAULT 'pow' CHECK (issue_policy IN ('pow', 'invite', 'paid')),
    price_msat          INTEGER NOT NULL DEFAULT 0 CHECK (price_msat >= 0),
    issued_count        INTEGER NOT NULL DEFAULT 0,
    redeemed_count      INTEGER NOT NULL DEFAULT 0,
    returned_count      INTEGER NOT NULL DEFAULT 0,
    offline_checkin     INTEGER NOT NULL DEFAULT 0 CHECK (offline_checkin IN (0, 1)),
    nwc_enc             TEXT,
    status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'cancelled')),
    cover_image         BLOB,
    cover_mime          TEXT,
    cover_version       INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );
  INSERT INTO events_v2 (id, host_pubkey, title, description, starts_at, ends_at, location,
    location_visibility, capacity, issue_policy, price_msat, issued_count, redeemed_count,
    status, cover_image, cover_mime, cover_version, created_at, updated_at)
  SELECT id, host_pubkey, title, description, starts_at, ends_at, location,
    location_visibility, capacity, issue_policy, price_msat, issued_count, redeemed_count,
    status, cover_image, cover_mime, cover_version, created_at, updated_at FROM events;
  DROP TABLE events;
  ALTER TABLE events_v2 RENAME TO events;
  CREATE INDEX events_host ON events(host_pubkey);

  CREATE TABLE event_cohosts (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    pubkey   TEXT NOT NULL,
    PRIMARY KEY (event_id, pubkey)
  ) WITHOUT ROWID;
  CREATE INDEX event_cohosts_pubkey ON event_cohosts(pubkey);

  -- One row per Lightning invoice. Holds no blinded message and nothing about the payer.
  CREATE TABLE quotes (
    id           TEXT PRIMARY KEY,
    event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    payment_hash TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('unpaid', 'paid', 'issued', 'expired')),
    expires_at   INTEGER NOT NULL
  );
  CREATE INDEX quotes_event_state ON quotes(event_id, state);

  CREATE TABLE invite_codes (
    id         TEXT PRIMARY KEY,
    event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL UNIQUE,
    label      TEXT NOT NULL DEFAULT '',
    max_uses   INTEGER NOT NULL CHECK (max_uses > 0),
    uses_left  INTEGER NOT NULL CHECK (uses_left >= 0)
  );
  CREATE INDEX invite_codes_event ON invite_codes(event_id);
  `,
];
