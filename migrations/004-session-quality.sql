-- Reversible filtering: retain raw events, track qualification separately.
CREATE TABLE IF NOT EXISTS session_quality (
  session_id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  visible_ms INTEGER NOT NULL DEFAULT 0,
  qualified INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT 'unconfirmed'
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
