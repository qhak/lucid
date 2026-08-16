-- Fresh start: drop imported history entirely (it was the source of most of
-- the confusion — mismatched export files, approximate day-splits, numbers
-- that silently depended on which filter was on screen when you exported).
-- Everything from here on is live-tracked only.

DELETE FROM events;
DROP TABLE IF EXISTS imported;

-- Self-serve place exclusion. Replaces the wrangler.toml EXCLUDE_REGIONS var,
-- which required editing a file and redeploying every time you wanted to add
-- or remove somewhere — now it's a list you manage from the dashboard.
--
-- One flat list, matched case-insensitively against country name, region, OR
-- city at ingest time. Deliberately not split into "country list" vs "region
-- list" — you just type the place, whatever level it is.
CREATE TABLE IF NOT EXISTS excluded (
  place    TEXT PRIMARY KEY COLLATE NOCASE,
  created  INTEGER NOT NULL
);
