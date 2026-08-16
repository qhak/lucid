-- Analytics schema (Cloudflare D1 / SQLite)
--
-- One row per event. A "pageview" is just an event named 'pageview'.
-- Sessions and all derived metrics (bounce rate, duration, entry/exit pages)
-- are computed at query time from this table — nothing is pre-aggregated,
-- so you can always re-slice historical data differently.

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,

  site          TEXT    NOT NULL,          -- e.g. 'example.com'
  ts            INTEGER NOT NULL,          -- unix seconds (UTC)
  name          TEXT    NOT NULL,          -- 'pageview' | 'scan_pick' | ...

  -- page
  path          TEXT,                      -- '/pricing' (query string stripped)
  referrer      TEXT,                      -- full referrer URL
  ref_domain    TEXT,                      -- 'instagram.com'
  channel       TEXT,                      -- Direct | Referral | Organic Search | Organic Social | Paid

  -- campaign tagging
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,

  -- identity (no cookies — see worker.js visitorId())
  visitor_id    TEXT    NOT NULL,          -- daily-rotating hash, resets at UTC midnight
  session_id    TEXT    NOT NULL,          -- 30-min inactivity window
  person_id     TEXT,                      -- stable hash, ONLY for new-vs-returning
  is_returning  INTEGER NOT NULL DEFAULT 0,-- decided at session start, copied to the session

  -- geo (free from Cloudflare on every request)
  country       TEXT,                      -- 'GB'
  region        TEXT,                      -- 'England'
  city          TEXT,                      -- 'Chester'
  continent     TEXT,                      -- 'EU'
  timezone      TEXT,                      -- 'Europe/London'

  -- client
  browser       TEXT,                      -- 'Safari' | 'Instagram' | 'Chrome' ...
  os            TEXT,                      -- 'iOS' | 'macOS' | 'Android' ...
  device        TEXT,                      -- 'Mobile' | 'Desktop' | 'Tablet'
  network       TEXT,                      -- ISP / AS org, e.g. 'Vodafone Italia'
  language      TEXT,                      -- 'en-GB', from Accept-Language
  screen        INTEGER,                   -- viewport width in CSS pixels

  props         TEXT                       -- JSON blob of custom event properties
);

-- Range scans per site (every dashboard query starts here)
CREATE INDEX IF NOT EXISTS idx_events_site_ts     ON events (site, ts);

-- Session rollups (bounce rate, duration, entry/exit)
CREATE INDEX IF NOT EXISTS idx_events_session     ON events (session_id, ts);
-- Session stitching on ingest (find this visitor's last event)
CREATE INDEX IF NOT EXISTS idx_events_visitor_ts  ON events (visitor_id, ts);
-- Goals / custom event breakdowns
CREATE INDEX IF NOT EXISTS idx_events_site_name   ON events (site, name, ts);
-- "Has this person been seen before?" on session start
CREATE INDEX IF NOT EXISTS idx_events_person      ON events (person_id, ts);


-- ------------------------------------------------------------------------
-- Self-serve place exclusion. One flat list, managed from the dashboard
-- (no wrangler.toml edit + redeploy needed to add or remove somewhere).
-- Matched case-insensitively against country name, region, OR city at
-- ingest — whatever level the place is, you just type it.
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS excluded (
  place    TEXT PRIMARY KEY COLLATE NOCASE,
  created  INTEGER NOT NULL
);


-- ------------------------------------------------------------------------
-- Registered sites. ALLOWED_SITES in wrangler.toml still works as a
-- bootstrap list; the dashboard's "Add website" writes here.
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sites (
  domain   TEXT PRIMARY KEY,
  created  INTEGER NOT NULL
);

-- Per-site revenue attribution. Amounts are stored as integer minor units
-- (cents/pence) to avoid floating-point rounding in totals.
CREATE TABLE IF NOT EXISTS revenue_settings (
  site      TEXT PRIMARY KEY,
  currency  TEXT NOT NULL DEFAULT 'USD'
);
CREATE TABLE IF NOT EXISTS revenue_rules (
  site         TEXT NOT NULL,
  event_name   TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (site, event_name)
);
CREATE INDEX IF NOT EXISTS idx_revenue_rules_site_event ON revenue_rules (site, event_name);

-- Reversible filtering: retain raw events, track qualification separately.
CREATE TABLE IF NOT EXISTS session_quality (
  session_id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  visible_ms INTEGER NOT NULL DEFAULT 0,
  qualified INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT 'unconfirmed',
  first_page TEXT,
  second_page TEXT
);
CREATE INDEX IF NOT EXISTS idx_quality_site_time ON session_quality(site, first_ts);
CREATE INDEX IF NOT EXISTS idx_quality_visitor_time ON session_quality(visitor_id, last_ts);
-- Existing single-timestamp visits cannot prove actual dwell time.
INSERT OR IGNORE INTO session_quality
  (session_id,site,visitor_id,first_ts,last_ts,visible_ms,qualified,reason)
SELECT session_id,site,visitor_id,MIN(ts),MAX(ts),
       (MAX(ts)-MIN(ts))*1000,
       CASE WHEN MAX(ts)-MIN(ts)>=1 THEN 1 ELSE 0 END,
       CASE WHEN MAX(ts)-MIN(ts)>=1 THEN 'legacy_confirmed' ELSE 'legacy_unverified' END
FROM events GROUP BY session_id;
UPDATE session_quality
SET first_page=(SELECT path FROM events e WHERE e.session_id=session_quality.session_id AND e.name='pageview' AND e.path IS NOT NULL ORDER BY e.ts,e.id LIMIT 1),
    second_page=(SELECT path FROM events e WHERE e.session_id=session_quality.session_id AND e.name='pageview' AND e.path IS NOT NULL AND e.path!=(SELECT e2.path FROM events e2 WHERE e2.session_id=session_quality.session_id AND e2.name='pageview' AND e2.path IS NOT NULL ORDER BY e2.ts,e2.id LIMIT 1) ORDER BY e.ts,e.id LIMIT 1)
WHERE EXISTS (SELECT 1 FROM events e WHERE e.session_id=session_quality.session_id AND e.name='pageview' AND e.path IS NOT NULL);
UPDATE session_quality
SET qualified=CASE WHEN visible_ms>=2000 OR second_page IS NOT NULL THEN 1 ELSE 0 END,
    reason=CASE WHEN reason='known_bot' THEN 'known_bot'
                WHEN visible_ms>=2000 OR second_page IS NOT NULL THEN 'confirmed'
                WHEN reason LIKE 'legacy_%' THEN reason
                ELSE 'unconfirmed' END
WHERE reason!='known_bot';


-- Live, reversible rules: no event deletion and no destructive reclassification.
CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  network TEXT NOT NULL COLLATE NOCASE,
  country TEXT NOT NULL,
  city TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('batch','repeat')),
  browser TEXT,
  os TEXT,
  device TEXT,
  screen INTEGER,
  language TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_automation_rules_site ON automation_rules(site,enabled);
CREATE INDEX IF NOT EXISTS idx_events_automation_network ON events(site,network,country,city,session_id);
-- Aggregate the WHOLE session, before any report date/dimension filters.
-- Only enabled, reviewed networks enter this computation. Every event is
-- checked, so a later product action or other page immediately rescues it.
CREATE VIEW IF NOT EXISTS automation_candidates AS
SELECT r.id AS rule_id,r.kind,q.session_id,q.site,q.visitor_id,q.first_ts,q.visible_ms,
       r.network,r.country,r.city,MIN(e.browser) AS browser,MIN(e.os) AS os,
       MIN(e.screen) AS screen,MIN(e.language) AS language
FROM automation_rules r
JOIN session_quality q ON q.site=r.site AND q.qualified=1
JOIN events e ON e.session_id=q.session_id
WHERE r.enabled=1 AND q.visible_ms BETWEEN 2000 AND 120000
AND EXISTS (SELECT 1 FROM events seed WHERE seed.session_id=q.session_id
            AND seed.network=r.network COLLATE NOCASE AND seed.country=r.country AND seed.city=r.city)
GROUP BY r.id,q.session_id
HAVING SUM(CASE WHEN e.site=r.site AND e.name='pageview' AND e.path='/' AND e.channel='Direct'
                    AND e.network=r.network COLLATE NOCASE AND e.country=r.country AND e.city=r.city
                    AND (r.kind='batch' OR (e.browser=r.browser AND e.os=r.os AND e.device=r.device AND e.screen=r.screen AND e.language=r.language))
                THEN 0 ELSE 1 END)=0;

-- Independent time and duration anchors keep BOTH total spreads bounded.
-- A 0/9/18-second chain is not a single ten-second batch.
CREATE VIEW IF NOT EXISTS automation_batch_windows AS
SELECT t.rule_id,t.first_ts AS window_start,d.visible_ms AS duration_floor
FROM automation_candidates t
JOIN automation_candidates d ON d.rule_id=t.rule_id AND d.first_ts BETWEEN t.first_ts AND t.first_ts+10
JOIN automation_candidates b ON b.rule_id=t.rule_id AND b.first_ts BETWEEN t.first_ts AND t.first_ts+10
                              AND b.visible_ms BETWEEN d.visible_ms AND d.visible_ms+2000
WHERE t.kind='batch'
GROUP BY t.rule_id,t.first_ts,d.visible_ms
HAVING COUNT(DISTINCT b.session_id)>=3 AND COUNT(DISTINCT b.visitor_id)>=3;

CREATE VIEW IF NOT EXISTS session_automation_exclusions AS
SELECT c.session_id,c.site,c.first_ts,c.visible_ms,c.network,c.city,c.rule_id,'network_batch' AS reason
FROM automation_candidates c
WHERE c.kind='batch' AND EXISTS (
  SELECT 1 FROM automation_batch_windows w WHERE w.rule_id=c.rule_id
  AND c.first_ts BETWEEN w.window_start AND w.window_start+10
  AND c.visible_ms BETWEEN w.duration_floor AND w.duration_floor+2000
)
UNION ALL
SELECT c.session_id,c.site,c.first_ts,c.visible_ms,c.network,c.city,c.rule_id,'reviewed_repeat' AS reason
FROM automation_candidates c
WHERE c.kind='repeat' AND c.visible_ms>=5000 AND EXISTS (
  SELECT 1 FROM automation_candidates p WHERE p.rule_id=c.rule_id AND p.session_id!=c.session_id
  AND ABS(p.first_ts-c.first_ts)<=2592000 AND ABS(p.visible_ms-c.visible_ms)<=10
  AND p.visible_ms>=5000
);

CREATE VIEW IF NOT EXISTS report_sessions AS
SELECT q.session_id FROM session_quality q WHERE q.qualified=1
AND NOT EXISTS (SELECT 1 FROM session_automation_exclusions a WHERE a.session_id=q.session_id);
