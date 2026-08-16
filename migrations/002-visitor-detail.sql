-- Richer per-visitor detail + new-vs-returning classification.
-- Safe to re-run: D1 errors on a duplicate column, so run each line and ignore
-- "duplicate column name" if you have already applied it.

-- Stable identity, used ONLY to tell a first-time visitor from a returning one.
-- Unlike visitor_id (which rotates at UTC midnight so nobody can be followed
-- across days), this hash has no date in it. It is still a one-way hash of
-- salt+site+IP+UA — not reversible, not a cookie, nothing stored on the device.
ALTER TABLE events ADD COLUMN person_id TEXT;

-- 1 when this visit's person had been seen before the visit started.
-- Decided once at session start and copied to every event in the session.
-- Named is_returning because RETURNING is a reserved word in SQLite.
ALTER TABLE events ADD COLUMN is_returning INTEGER NOT NULL DEFAULT 0;

-- Network / ISP, e.g. "Vodafone Italia" or "Comcast". Tells carrier from
-- home broadband from datacenter (a good bot smell test).
ALTER TABLE events ADD COLUMN network TEXT;

-- Browser's preferred language, e.g. 'en-GB', from the Accept-Language header.
ALTER TABLE events ADD COLUMN language TEXT;

-- Viewport width in CSS pixels, reported by tracker.js. Bucketed for display.
ALTER TABLE events ADD COLUMN screen INTEGER;

-- IANA timezone, e.g. 'Europe/Rome' — often sharper than city-level geo.
ALTER TABLE events ADD COLUMN timezone TEXT;

-- 'EU' | 'NA' | 'AS' ... for continent rollups.
ALTER TABLE events ADD COLUMN continent TEXT;

-- Returning lookup on ingest: "has this person ever been seen before?"
CREATE INDEX IF NOT EXISTS idx_events_person ON events (person_id, ts);
