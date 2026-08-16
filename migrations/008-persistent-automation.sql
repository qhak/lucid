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

