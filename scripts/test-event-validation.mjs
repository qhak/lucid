import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL, Response, Headers, crypto: globalThis.crypto });
vm.runInContext(source.replace('export default {', 'var worker = {'), context);
const { validateEvent, originAllowed, handleEvent } = context;
const origin = 'https://example.com';
const valid = { d: 'example.com', u: origin + '/pricing', n: 'pageview', delta_ms: 0 };
let checks = 0;
function check(value, expected) { assert.equal(value, expected); checks++; }
check(validateEvent(valid, origin), null);
check(validateEvent({ ...valid, u: 'https://www.example.com/a' }, 'https://www.example.com'), null);
check(validateEvent({ ...valid, n: '__lucid_engagement', delta_ms: 2000 }, origin), null);
check(validateEvent({ ...valid, n: 'purchase completed' }, origin), null);
check(validateEvent({ d: valid.d, u: valid.u }, origin), null); // legacy default pageview
for (const body of [null, [], 1, 'event', { ...valid, d: {} }, { ...valid, u: null },
  { ...valid, u: 'file:///pricing' }, { ...valid, u: 'https://user:pass@example.com/' },
  { ...valid, d: 'other.com' }, { ...valid, u: 'https://other.com/' },
  { ...valid, u: 'https://example.com.attacker.test/' },
  { ...valid, n: {} }, { ...valid, n: '' }, { ...valid, n: 'x'.repeat(65) },
  { ...valid, n: 'bad\nname' }, { ...valid, n: '__lucid_fake' },
  { ...valid, delta_ms: -1 }, { ...valid, delta_ms: '2000' }, { ...valid, delta_ms: Infinity }]) {
  assert.ok(validateEvent(body, origin)); checks++;
}
check(validateEvent(valid, 'https://example.com:8443'), 'site/origin mismatch');

let writes = 0;
const env = { ALLOWED_SITES: 'example.com,other.com', DB: { prepare(sql) {
  if (!sql.startsWith('SELECT domain FROM sites')) { writes++; throw new Error('Unexpected database access: ' + sql); }
  return { all: async () => ({ results: [] }) };
} } };
for (const badOrigin of [null, 'null', 'https://evil.test', 'https://example.com.evil.test', 'https://example.com/path', 'ftp://example.com']) {
  check(await originAllowed(badOrigin, env), false);
}
check(await originAllowed(origin, env), true);
check(await originAllowed('https://www.example.com', env), true);
for (const [requestOrigin, body, expected] of [
  [null, valid, 403], ['https://evil.test', valid, 403],
  [origin, { ...valid, d: 'other.com' }, 400],
  [origin, { ...valid, u: 'https://other.com/' }, 400],
  [origin, null, 400], [origin, { ...valid, n: '__lucid_fake' }, 400],
]) {
  const request = new Request('https://analytics.example/event', {
    method: 'POST', headers: requestOrigin ? { Origin: requestOrigin } : {}, body: JSON.stringify(body),
  });
  check((await handleEvent(request, env, {})).status, expected);
}
check(writes, 0);
console.log(`${checks} validation checks passed; rejected events caused no session or event database access.`);
