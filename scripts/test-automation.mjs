import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const sql = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const schema = sql('../schema.sql');
const migration = sql('../migrations/008-persistent-automation.sql');
let passed = 0;

function test(name, fn) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(schema);
    db.exec(migration);
    db.prepare(`INSERT INTO automation_rules(id,site,network,country,city,kind)
      VALUES ('example-cdn-batch','example.test','Example CDN','US','Example City','batch')`).run();
    db.prepare(`INSERT INTO automation_rules(id,site,network,country,city,kind,browser,os,device,screen,language)
      VALUES ('example-repeat','example.test','Example Hosting','US','Example Town','repeat','Chrome','Windows','Desktop',1600,'en-US')`).run();
    fn(db);
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  } finally { db.close(); }
}

function visit(db, id, overrides = {}) {
  const v = {
    site: 'example.test', ts: 1791181350, name: 'pageview', path: '/',
    visitor_id: id, session_id: id, country: 'US', network: 'Example CDN',
    city: 'Example City', channel: 'Direct', browser: 'Chrome', os: 'Windows',
    device: 'Desktop', screen: 1600, language: 'en-US', visible_ms: 30000,
    qualified: 1, reason: 'confirmed', ...overrides,
  };
  db.prepare(`INSERT INTO session_quality
    (session_id,site,visitor_id,first_ts,last_ts,visible_ms,qualified,reason,first_page)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(v.session_id,v.site,v.visitor_id,v.ts,v.ts,v.visible_ms,v.qualified,v.reason,v.path);
  event(db, v);
  return v;
}

function event(db, v) {
  const keys = ['site','ts','name','path','visitor_id','session_id','country','network','city','channel','browser','os','device','screen','language'];
  db.prepare(`INSERT INTO events (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => v[k] ?? null));
}

const excluded = (db) => db.prepare('SELECT DISTINCT session_id FROM session_automation_exclusions ORDER BY session_id').all().map((r) => r.session_id);
const reported = (db) => db.prepare('SELECT session_id FROM report_sessions ORDER BY session_id').all().map((r) => r.session_id);
const batch = (db, times = [0, 5, 10], durations = [30000, 30000, 30000], third = {}) =>
  times.map((offset, i) => visit(db, `b${i}`, { ts: 1791181350 + offset, visible_ms: durations[i], ...(i === 2 ? third : {}) }));
const repeat = (db, second = {}) => {
  const profile = { network: 'Example Hosting', city: 'Example Town', visible_ms: 15000 };
  return [visit(db, 'r0', profile), visit(db, 'r1', { ...profile, ts: 1791267750, ...second })];
};

test('three distinct visitors form a batch at the inclusive 10-second boundary', (db) => {
  batch(db);
  assert.deepEqual(excluded(db), ['b0','b1','b2']);
  assert.deepEqual(reported(db), []);
});
test('two sessions do not form a batch', (db) => {
  batch(db, [0,5], [30000,30000]);
  assert.deepEqual(excluded(db), []);
});
test('11-second batch spread stays included', (db) => {
  batch(db, [0,5,11]);
  assert.deepEqual(excluded(db), []);
});
test('0/9/18-second chain does not create a 20-second window', (db) => {
  batch(db, [0,9,18]);
  assert.deepEqual(excluded(db), []);
});
test('duration spread of exactly 2000ms qualifies', (db) => {
  batch(db, [0,1,2], [29000,30000,31000]);
  assert.equal(excluded(db).length, 3);
});
test('duration spread of 2001ms does not qualify', (db) => {
  batch(db, [0,1,2], [29000,30000,31001]);
  assert.deepEqual(excluded(db), []);
});
test('duration-centered chain does not allow a 4000ms spread', (db) => {
  batch(db, [0,1,2], [28000,30000,32000]);
  assert.deepEqual(excluded(db), []);
});
test('three sessions from only two distinct visitors stay included', (db) => {
  batch(db, undefined, undefined, { visitor_id: 'b0' });
  assert.deepEqual(excluded(db), []);
});

for (const [name, changes] of [
  ['other page', { path: '/pricing' }], ['referral', { channel: 'Referral' }],
  ['other network', { network: 'Residential ISP' }], ['other city', { city: 'London' }],
  ['other country', { country: 'GB' }], ['other site', { site: 'other.app' }],
  ['missing page', { path: null }], ['missing channel', { channel: null }],
  ['missing city', { city: null }], ['custom event', { name: 'scan_pick' }],
  ['unqualified', { qualified: 0 }], ['known bot', { qualified: 0, reason: 'known_bot' }],
  ['too short', { visible_ms: 1999 }], ['too long', { visible_ms: 120001 }],
]) {
  test(`batch rejects ${name}`, (db) => {
    batch(db, undefined, undefined, changes);
    assert.deepEqual(excluded(db), []);
  });
}

test('matching repeat with 10ms difference at exactly 30 days qualifies', (db) => {
  repeat(db, { ts: 1791181350 + 2592000, visible_ms: 15010 });
  assert.deepEqual(excluded(db), ['r0','r1']);
});
test('repeat more than 30 days apart stays included', (db) => {
  repeat(db, { ts: 1791181350 + 2592001 });
  assert.deepEqual(excluded(db), []);
});
test('repeat with 11ms difference stays included', (db) => {
  repeat(db, { visible_ms: 15011 });
  assert.deepEqual(excluded(db), []);
});
for (const [name, changes] of [
  ['wrong device', { device: 'Tablet' }], ['missing device', { device: null }],
  ['wrong browser', { browser: 'Firefox' }], ['missing browser', { browser: null }],
  ['wrong OS', { os: 'Linux' }], ['missing OS', { os: null }],
  ['wrong width', { screen: 1599 }], ['missing width', { screen: null }],
  ['wrong language', { language: 'en-GB' }], ['missing language', { language: null }],
  ['too short', { visible_ms: 4999 }], ['other network', { network: 'Residential ISP' }],
  ['other city', { city: 'Another City' }], ['other site', { site: 'other.example' }],
]) {
  test(`repeat rejects ${name}`, (db) => {
    repeat(db, changes);
    assert.deepEqual(excluded(db), []);
  });
}

test('custom action outside the historical report range rescues the whole session', (db) => {
  const [first] = repeat(db);
  assert.equal(excluded(db).length, 2);
  event(db, { ...first, ts: first.ts + 86400 * 40, name: 'scan_pick' });
  assert.deepEqual(excluded(db), []);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM events
    WHERE ts>=? AND ts<? AND session_id IN (SELECT session_id FROM report_sessions)`)
    .get(first.ts, first.ts + 1).n, 1);
});
test('later other-page event rescues a batch without changing its entry page', (db) => {
  const [first] = batch(db);
  event(db, { ...first, ts: first.ts + 20, path: '/pricing' });
  assert.deepEqual(excluded(db), []);
});
test('rule toggles restore reports, retain raw data, and survive migration replay', (db) => {
  batch(db);
  repeat(db);
  assert.equal(excluded(db).length, 5);
  db.exec('UPDATE automation_rules SET enabled=0');
  assert.deepEqual(excluded(db), []);
  assert.equal(reported(db).length, 5);
  db.exec(migration);
  assert.equal(reported(db).length, 5);
  assert.equal(db.prepare('SELECT SUM(enabled) AS n FROM automation_rules').get().n, 0);
  db.exec('UPDATE automation_rules SET enabled=1');
  assert.equal(excluded(db).length, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_quality WHERE qualified=1').get().n, 5);
});
console.log(`Automation SQL regression tests passed: ${passed}.`);
