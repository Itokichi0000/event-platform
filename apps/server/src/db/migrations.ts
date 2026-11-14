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
];
