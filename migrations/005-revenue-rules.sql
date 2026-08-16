-- Per-site revenue attribution. Store money as integer minor units.
CREATE TABLE IF NOT EXISTS revenue_settings (
  site TEXT PRIMARY KEY,
  currency TEXT NOT NULL DEFAULT 'USD'
);
CREATE TABLE IF NOT EXISTS revenue_rules (
  site TEXT NOT NULL,
  event_name TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (site, event_name)
);
CREATE INDEX IF NOT EXISTS idx_revenue_rules_site_event ON revenue_rules (site, event_name);
