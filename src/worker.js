/**
 * Lucid Analytics worker.
 *
 *   POST   /event         public  — receives events from tracker.js
 *   GET    /tracker.js    public  — the script embedded on tracked sites
 *   GET    /api/sites     private — site cards for the index page (24h sparkline)
 *   POST   /api/sites     private — register a new site to track
 *   DELETE /api/sites     private — remove a site (its events are kept)
 *   GET    /api/stats     private — everything the dashboard renders
 *   GET/POST/DELETE /api/revenue-settings private — per-site revenue rules
 *   GET    /api/journey   private — "what happens next" for a chosen start step
 *   GET    /api/visits    private — individual visits, newest first
 *   GET    /api/events    private — individual custom events + their properties
 *   GET    /api/excluded  private — list of places dropped at ingest
 *   POST   /api/excluded  private — add a place to drop
 *   DELETE /api/excluded  private — stop dropping a place
 *   GET    /*             private — dashboard UI (served from ./public)
 *
 * Everything except /event and /tracker.js sits behind HTTP Basic Auth.
 *
 * Sites live in the D1 `sites` table so they can be added from the UI;
 * ALLOWED_SITES in wrangler.toml still works as a bootstrap list and the two
 * are unioned. No cookies are set on visitors — identity is a daily-rotating
 * hash (salt + UTC date + site + IP + UA), the same approach Plausible uses.
 *
 * Live-only, on purpose: there is no import feature. An importer that has to
 * guess which of two export formats it received, and whether the numbers were
 * filtered when they were exported, is a worse source of truth than a graph
 * that starts at zero and only ever shows what actually happened.
 */

const SESSION_GAP = 30 * 60; // seconds of inactivity that ends a visit

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return preflight(request, env);

    if (url.pathname === "/event") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleEvent(request, env, ctx);
    }

    // The tracker is loaded by browsers on the tracked sites, so it is the one
    // asset that must stay public. Everything else requires the password.
    if (url.pathname === "/tracker.js") {
      const res = await env.ASSETS.fetch(request);
      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      // Short on purpose: this file changes during active development, and a
      // long cache here means a fix can be deployed and still silently not
      // reach a real browser for up to an hour. Once this is stable, this can
      // safely go back up — a few seconds of staleness on a script this small
      // isn't worth thinking about either way.
      headers.set("Cache-Control", "public, max-age=60");
      // The browser has no way to know this worker's own origin from inside
      // a same-file script tag, so it's baked in at serve time instead of
      // being read off the <script> element (see tracker.js for why that
      // used to be fragile).
      const text = (await res.text()).replace("__LUCID_ENDPOINT__", url.origin);
      return new Response(text, { status: res.status, headers });
    }

    // Everything below is private.
    const challenge = requireAuth(request, env);
    if (challenge) return challenge;

    if (url.pathname === "/api/sites") {
      if (request.method === "GET") return handleSitesSummary(env);
      if (request.method === "POST") return handleSiteAdd(request, env, url);
      if (request.method === "DELETE") return handleSiteRemove(env, url);
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/api/stats") return handleStats(request, env, url);
    if (url.pathname === '/api/automation') return handleAutomation(request, env, url);
    if (url.pathname === "/api/revenue-settings") {
      if (request.method === "GET") return handleRevenueSettings(env, url);
      if (request.method === "POST") return handleRevenueSettingsSave(request, env, url);
      if (request.method === "DELETE") return handleRevenueRuleRemove(env, url);
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/api/journey") return handleJourney(env, url);
    if (url.pathname === "/api/visits") return handleVisits(env, url);
    if (url.pathname === "/api/events") return handleEvents(env, url);
    if (url.pathname === "/api/excluded") {
      if (request.method === "GET") return handleExcludedList(env);
      if (request.method === "POST") return handleExcludedAdd(request, env);
      if (request.method === "DELETE") return handleExcludedRemove(env, url);
      return new Response("Method not allowed", { status: 405 });
    }

    // The dashboard shell itself: no cache headers were being set here, so
    // Cloudflare's edge was free to keep serving an old build after a deploy
    // (observed: cf-cache-status: HIT with no Cache-Control at all). This is
    // the whole app's entry point and it's behind a password, so it must
    // never be cached — force a revalidate on every request.
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("Cache-Control", "no-store, must-revalidate");
    return new Response(asset.body, { status: asset.status, headers });
  },
};

/* ------------------------------------------------------------------ */
/* auth                                                                */
/* ------------------------------------------------------------------ */

function requireAuth(request, env) {
  const expected = env.DASH_PASSWORD;
  if (!expected) {
    return json({ error: "DASH_PASSWORD secret is not set. Run: npx wrangler secret put DASH_PASSWORD" }, 500);
  }
  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = atob(header.slice(6));
    } catch {
      decoded = "";
    }
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (timingSafeEqual(password, expected)) return null;
  }
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Lucid Analytics", charset="UTF-8"' },
  });
}

// Constant-time compare so the password can't be guessed byte by byte.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* site registry (D1 `sites` table ∪ ALLOWED_SITES var)                */
/* ------------------------------------------------------------------ */

let siteCache = { list: null, at: 0 };

async function allowedSites(env) {
  const now = Date.now();
  if (siteCache.list && now - siteCache.at < 60_000) return siteCache.list;

  const fromVar = (env.ALLOWED_SITES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  let fromDb = [];
  try {
    const { results } = await env.DB.prepare(`SELECT domain FROM sites`).all();
    fromDb = (results || []).map((r) => r.domain);
  } catch {
    /* table may not exist yet — the var list still works */
  }

  siteCache = { list: [...new Set([...fromVar, ...fromDb])], at: now };
  return siteCache.list;
}

function normalizeDomain(input) {
  let d = String(input || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  d = d.split("/")[0].split("?")[0].split(":")[0];
  return d;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function snippetFor(domain, origin) {
  // No data-domain attribute needed — the tracker reads location.hostname.
  // domain is only used here to label which site this snippet is for.
  return `<script defer src="${origin}/tracker.js"><\/script> <!-- ${domain} -->`;
}

async function handleSiteAdd(request, env, url) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const domain = normalizeDomain(body.domain);
  if (!DOMAIN_RE.test(domain)) return json({ error: "That doesn't look like a domain." }, 400);

  await env.DB.prepare(`INSERT OR IGNORE INTO sites (domain, created) VALUES (?, ?)`)
    .bind(domain, Math.floor(Date.now() / 1000))
    .run();
  siteCache.at = 0; // new site takes effect immediately

  return json({ ok: true, domain, snippet: snippetFor(domain, url.origin) });
}

async function handleSiteRemove(env, url) {
  const domain = normalizeDomain(url.searchParams.get("domain"));
  if (!domain) return json({ error: "domain is required" }, 400);
  await env.DB.prepare(`DELETE FROM sites WHERE domain = ?`).bind(domain).run();
  siteCache.at = 0;
  // Events are deliberately kept — remove only stops new collection/listing.
  return json({ ok: true, removed: domain, eventsKept: true });
}

/** Site cards for the index page: 24h visitors, delta vs the 24h before, sparkline. */
async function handleSitesSummary(env) {
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const twoDaysAgo = now - 2 * 86400;
  const excluded = await automationSessionIds(env);

  const [cur, prev, spark, withEvents] = await env.DB.batch([
    env.DB.prepare(
      `SELECT site, COUNT(DISTINCT visitor_id) v FROM events WHERE session_id IN (SELECT session_id FROM session_quality WHERE qualified=1) AND session_id NOT IN (SELECT value FROM json_each(?)) AND ts >= ? GROUP BY site`
    ).bind(excluded,dayAgo),
    env.DB.prepare(
      `SELECT site, COUNT(DISTINCT visitor_id) v FROM events WHERE session_id IN (SELECT session_id FROM session_quality WHERE qualified=1) AND session_id NOT IN (SELECT value FROM json_each(?)) AND ts >= ? AND ts < ? GROUP BY site`
    ).bind(excluded,twoDaysAgo, dayAgo),
    env.DB.prepare(
      `SELECT site, strftime('%Y-%m-%dT%H', ts, 'unixepoch') h, COUNT(DISTINCT visitor_id) v
         FROM events WHERE session_id IN (SELECT session_id FROM session_quality WHERE qualified=1) AND session_id NOT IN (SELECT value FROM json_each(?)) AND ts >= ? GROUP BY site, h ORDER BY h`
    ).bind(excluded,dayAgo),
    env.DB.prepare(`SELECT DISTINCT site FROM events`),
  ]);

  const curMap = Object.fromEntries((cur.results || []).map((r) => [r.site, r.v]));
  const prevMap = Object.fromEntries((prev.results || []).map((r) => [r.site, r.v]));
  const sparkMap = {};
  for (const r of spark.results || []) (sparkMap[r.site] ||= []).push({ t: r.h, v: r.v });

  const domains = new Set([
    ...(await allowedSites(env)),
    ...(withEvents.results || []).map((r) => r.site),
  ]);

  const sites = [...domains].sort().map((d) => ({
    domain: d,
    visitors24h: curMap[d] || 0,
    prev24h: prevMap[d] || 0,
    delta: pctChange(curMap[d] || 0, prevMap[d] || 0),
    spark: sparkMap[d] || [],
  }));

  sites.sort((a, b) => b.visitors24h - a.visitors24h);
  return json({ sites });
}

/* ------------------------------------------------------------------ */
/* excluded places (D1 `excluded` table, self-serve from the dashboard) */
/* ------------------------------------------------------------------ */

// ISO2 → full name, so typing "Spain" excludes country code 'ES' too. Only
// needed in the direction of matching a typed name against Cloudflare's code;
// the dashboard already has the reverse map (world-data.js) for display.
const COUNTRY_NAME = {
  AF:"Afghanistan",AL:"Albania",DZ:"Algeria",AR:"Argentina",AM:"Armenia",AU:"Australia",
  AT:"Austria",AZ:"Azerbaijan",BH:"Bahrain",BD:"Bangladesh",BY:"Belarus",BE:"Belgium",
  BO:"Bolivia",BA:"Bosnia and Herzegovina",BR:"Brazil",BG:"Bulgaria",KH:"Cambodia",
  CM:"Cameroon",CA:"Canada",CL:"Chile",CN:"China",CO:"Colombia",CR:"Costa Rica",
  HR:"Croatia",CU:"Cuba",CY:"Cyprus",CZ:"Czechia",DK:"Denmark",DO:"Dominican Republic",
  EC:"Ecuador",EG:"Egypt",SV:"El Salvador",EE:"Estonia",ET:"Ethiopia",FI:"Finland",
  FR:"France",GE:"Georgia",DE:"Germany",GH:"Ghana",GR:"Greece",GT:"Guatemala",
  HN:"Honduras",HK:"Hong Kong",HU:"Hungary",IS:"Iceland",IN:"India",ID:"Indonesia",
  IR:"Iran",IQ:"Iraq",IE:"Ireland",IL:"Israel",IT:"Italy",CI:"Ivory Coast",JM:"Jamaica",
  JP:"Japan",JO:"Jordan",KZ:"Kazakhstan",KE:"Kenya",XK:"Kosovo",KW:"Kuwait",
  KG:"Kyrgyzstan",LA:"Laos",LV:"Latvia",LB:"Lebanon",LY:"Libya",LT:"Lithuania",
  LU:"Luxembourg",MY:"Malaysia",MT:"Malta",MX:"Mexico",MD:"Moldova",MN:"Mongolia",
  ME:"Montenegro",MA:"Morocco",MM:"Myanmar",NP:"Nepal",NL:"Netherlands",
  NZ:"New Zealand",NI:"Nicaragua",NG:"Nigeria",MK:"North Macedonia",NO:"Norway",
  OM:"Oman",PK:"Pakistan",PA:"Panama",PY:"Paraguay",PE:"Peru",PH:"Philippines",
  PL:"Poland",PT:"Portugal",PR:"Puerto Rico",QA:"Qatar",RO:"Romania",RU:"Russia",
  SA:"Saudi Arabia",SN:"Senegal",RS:"Serbia",SG:"Singapore",SK:"Slovakia",SI:"Slovenia",
  ZA:"South Africa",KR:"South Korea",ES:"Spain",LK:"Sri Lanka",SE:"Sweden",
  CH:"Switzerland",SY:"Syria",TW:"Taiwan",TZ:"Tanzania",TH:"Thailand",TN:"Tunisia",
  TR:"Turkey",UG:"Uganda",UA:"Ukraine",AE:"United Arab Emirates",GB:"United Kingdom",
  US:"United States",UY:"Uruguay",UZ:"Uzbekistan",VE:"Venezuela",VN:"Vietnam",
  YE:"Yemen",ZM:"Zambia",ZW:"Zimbabwe",
};

let excludedCache = { set: null, at: 0 };

async function excludedPlaces(env) {
  const now = Date.now();
  if (excludedCache.set && now - excludedCache.at < 60_000) return excludedCache.set;
  const { results } = await env.DB.prepare(`SELECT place FROM excluded`).all();
  excludedCache = {
    set: new Set((results || []).map((r) => r.place.toLowerCase())),
    at: now,
  };
  return excludedCache.set;
}

/** True if this request's country, region, or city is on the exclude list. */
function isExcludedPlace(excluded, cf) {
  if (!excluded.size) return false;
  const candidates = [
    cf.region, cf.city, cf.country, COUNTRY_NAME[cf.country],
  ].filter(Boolean).map((s) => s.toLowerCase());
  return candidates.some((c) => excluded.has(c));
}

async function handleExcludedList(env) {
  const { results } = await env.DB.prepare(`SELECT place, created FROM excluded ORDER BY place`).all();
  return json({ places: (results || []).map((r) => r.place) });
}

async function handleExcludedAdd(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const place = String(body.place || "").trim();
  if (!place) return json({ error: "place is required" }, 400);
  if (place.length > 80) return json({ error: "that's too long to be a place name" }, 400);

  await env.DB.prepare(`INSERT OR IGNORE INTO excluded (place, created) VALUES (?, ?)`)
    .bind(place, Math.floor(Date.now() / 1000))
    .run();
  excludedCache.at = 0;
  return json({ ok: true, place });
}

async function handleExcludedRemove(env, url) {
  const place = String(url.searchParams.get("place") || "").trim();
  if (!place) return json({ error: "place is required" }, 400);
  await env.DB.prepare(`DELETE FROM excluded WHERE place = ?`).bind(place).run();
  excludedCache.at = 0;
  return json({ ok: true, removed: place });
}

const REVENUE_CURRENCIES = new Set(["USD", "GBP", "EUR", "CAD", "AUD"]);

async function revenueSite(url, env) {
  const site = normalizeDomain(url.searchParams.get("site"));
  if (!site || !(await allowedSites(env)).includes(site)) return null;
  return site;
}

async function handleRevenueSettings(env, url) {
  const site = await revenueSite(url, env);
  if (!site) return json({ error: "A registered site is required." }, 400);
  const [setting, rules] = await Promise.all([
    env.DB.prepare(`SELECT currency FROM revenue_settings WHERE site = ?`).bind(site).first(),
    env.DB.prepare(`SELECT event_name AS eventName, amount_minor AS amountMinor FROM revenue_rules WHERE site = ? ORDER BY event_name`).bind(site).all(),
  ]);
  return json({ currency: setting?.currency || "USD", rules: rules.results || [] });
}

async function handleRevenueSettingsSave(request, env, url) {
  const site = await revenueSite(url, env);
  if (!site) return json({ error: "A registered site is required." }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const currency = String(body.currency || "USD").toUpperCase();
  if (!REVENUE_CURRENCIES.has(currency)) return json({ error: "Choose USD, GBP, EUR, CAD, or AUD." }, 400);
  if (body.eventName == null || body.eventName === "") {
    await env.DB.prepare(`INSERT INTO revenue_settings (site, currency) VALUES (?, ?) ON CONFLICT(site) DO UPDATE SET currency=excluded.currency`).bind(site, currency).run();
    return json({ ok: true, currency });
  }
  const eventName = String(body.eventName).trim();
  const amount = Number(body.amount);
  if (!/^[a-zA-Z0-9:_-]{1,64}$/.test(eventName) || eventName.startsWith("__lucid_") || eventName === "pageview") {
    return json({ error: "Use a custom event name (letters, numbers, _, -, or :)." }, 400);
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return json({ error: "Enter an amount greater than 0 and at most 1,000,000." }, 400);
  const amountMinor = Math.round(amount * 100);
  if (amountMinor < 1) return json({ error: "Enter at least 0.01." }, 400);
  await env.DB.prepare(`INSERT INTO revenue_settings (site, currency) VALUES (?, ?) ON CONFLICT(site) DO UPDATE SET currency=excluded.currency`).bind(site, currency).run();
  await env.DB.prepare(`INSERT INTO revenue_rules (site, event_name, amount_minor) VALUES (?, ?, ?) ON CONFLICT(site, event_name) DO UPDATE SET amount_minor=excluded.amount_minor`).bind(site, eventName, amountMinor).run();
  return json({ ok: true, currency, eventName, amountMinor });
}

async function handleRevenueRuleRemove(env, url) {
  const site = await revenueSite(url, env);
  const eventName = String(url.searchParams.get("event") || "").trim();
  if (!site || !eventName) return json({ error: "A registered site and event are required." }, 400);
  await env.DB.prepare(`DELETE FROM revenue_rules WHERE site = ? AND event_name = ?`).bind(site, eventName).run();
  return json({ ok: true, removed: eventName });
}

/* ------------------------------------------------------------------ */
/* CORS (only /event is cross-origin)                                  */
/* ------------------------------------------------------------------ */

async function originAllowed(origin, env) {
  if (!origin) return false;
  let host;
  try {
    const parsed = new URL(origin);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (env.ALLOW_LOCAL_DEV === "1" && (host === "localhost" || host === "127.0.0.1")) return true;
  const sites = await allowedSites(env);
  return sites.some((site) => host === site || host === `www.${site}`);
}

async function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!(await originAllowed(origin, env))) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    // navigator.sendBeacon() always sends cross-origin requests with
    // credentials included — there's no way to opt out of that from the
    // client. That flips the browser into strict CORS mode, which refuses to
    // accept ANY response (even a successful one already written to D1)
    // unless this header is explicitly "true". No actual cookie is ever set
    // or read here — this is purely satisfying the browser's CORS contract
    // for a request shape sendBeacon forces, not a change in what's tracked.
    "Access-Control-Allow-Credentials": "true",
  };
}

async function preflight(request, env) {
  return new Response(null, { status: 204, headers: await corsHeaders(request, env) });
}

/* ------------------------------------------------------------------ */
/* ingest                                                              */
/* ------------------------------------------------------------------ */

// These are consistency checks, not proof of a human: non-browser clients
// can forge Origin. Check before any quality/session/event writes.
function validateEvent(body, origin) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid event';
  if (typeof body.d !== 'string' || !DOMAIN_RE.test(body.d)) return 'invalid site';
  if (typeof body.u !== 'string') return 'invalid page URL';
  try {
    const page = new URL(body.u);
    if (!['https:', 'http:'].includes(page.protocol) || page.username || page.password) return 'invalid page URL';
    if (page.origin !== origin || normalizeDomain(page.hostname) !== normalizeDomain(body.d)) return 'site/origin mismatch';
  } catch { return 'invalid page URL'; }
  if (body.n !== undefined && (typeof body.n !== 'string' || !body.n.trim() || body.n.length > 64 || /[\u0000-\u001f\u007f]/.test(body.n))) return 'invalid event name';
  if (typeof body.n === 'string' && body.n.startsWith('__lucid_') && body.n !== '__lucid_engagement') return 'reserved event name';
  if (body.delta_ms !== undefined && (!Number.isFinite(body.delta_ms) || body.delta_ms < 0)) return 'invalid engagement time';
  return null;
}

async function handleEvent(request, env, ctx) {
  const cors = await corsHeaders(request, env);
  if (!cors['Access-Control-Allow-Origin']) return json({ error: 'origin not allowed' }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400, cors);
  }
  const validationError = validateEvent(body, request.headers.get('Origin'));
  if (validationError) return json({ error: validationError }, 400, cors);

  // Ignore explicit owner visits before storing any event or quality record.
  try {
    const switches = new URL(body.u).searchParams;
    if (switches.get('lucidignore') === 'true' || switches.has('exclude_me')) return json({ok:true,ignored:'self'},202,cors);
  } catch {}
  // Resolve the site from the payload, and verify it is one we track.
  const site = normalizeDomain(body.d);
  if (!site || !(await allowedSites(env)).includes(site)) {
    return json({ error: "unknown site" }, 403, cors);
  }

  const cf = request.cf || {};
  const region = cf.region || null;

  // Drop excluded places before they are ever stored. Managed from the
  // dashboard (Excluded Places), not a config file — takes effect within 60s.
  if (isExcludedPlace(await excludedPlaces(env), cf)) {
    return json({ ok: true, ignored: "place" }, 202, cors);
  }

  const ua = request.headers.get("User-Agent") || "";
  const knownBot = looksLikeBot(ua);

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const name = String(body.n || "pageview").slice(0, 64);

  // Page + campaign data
  let path = null;
  let utm = { source: null, medium: null, campaign: null };
  try {
    const pageUrl = new URL(body.u);
    path = pageUrl.pathname.replace(/\/+$/, "") || "/";
    utm = {
      source: pageUrl.searchParams.get("utm_source"),
      medium: pageUrl.searchParams.get("utm_medium"),
      campaign: pageUrl.searchParams.get("utm_campaign"),
    };
  } catch {
    /* leave nulls */
  }

  let referrer = body.r || null;
  let refDomain = domainOf(referrer, site);
  let channel = classifyChannel(refDomain, utm);
  const client = parseUA(ua);

  const now = Math.floor(Date.now() / 1000);
  const salt = env.ID_SALT || "";
  const visitor = await visitorId(ip, ua, site, salt);
  const person = await personId(ip, ua, site, salt);

  // Stitch into an existing visit if this visitor was active recently.
  const recent = await env.DB.prepare(
    `SELECT session_id, channel, referrer, ref_domain, utm_source, utm_medium, utm_campaign, is_returning
       FROM events
      WHERE visitor_id = ? AND ts >= ?
      ORDER BY ts DESC LIMIT 1`
  )
    .bind(visitor, now - SESSION_GAP)
    .first();

  const qualityVisit = await env.DB.prepare('SELECT session_id FROM session_quality WHERE visitor_id = ? AND last_ts >= ? ORDER BY last_ts DESC LIMIT 1').bind(visitor,now - SESSION_GAP).first();
  const session = recent?.session_id || qualityVisit?.session_id || crypto.randomUUID();
  // Each tracker message carries only newly elapsed visible milliseconds.
  const deltaMs = !knownBot && Number.isFinite(body.delta_ms) ? Math.max(0,Math.min(Math.floor(body.delta_ms),SESSION_GAP*1000)) : 0;
  // A fast navigation to a distinct page proves this was not an instant
  // single-page bounce. Store the first two paths on the quality row so the
  // decision stays atomic even if pageview beacons arrive close together.
  const pagePath = name === 'pageview' ? path : null;
  await env.DB.prepare(`INSERT INTO session_quality(session_id,site,visitor_id,first_ts,last_ts,visible_ms,qualified,reason,first_page,second_page)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
    last_ts=excluded.last_ts,
    visible_ms=session_quality.visible_ms+excluded.visible_ms,
    first_page=COALESCE(session_quality.first_page,excluded.first_page),
    second_page=COALESCE(session_quality.second_page,CASE WHEN session_quality.first_page IS NOT NULL AND excluded.first_page IS NOT NULL AND session_quality.first_page!=excluded.first_page THEN excluded.first_page ELSE NULL END),
    qualified=CASE WHEN session_quality.reason IN ('known_bot','suspected_automation_batch') THEN 0 ELSE MAX(session_quality.qualified,CASE WHEN session_quality.visible_ms+excluded.visible_ms>=2000 OR session_quality.second_page IS NOT NULL OR (session_quality.first_page IS NOT NULL AND excluded.first_page IS NOT NULL AND session_quality.first_page!=excluded.first_page) THEN 1 ELSE 0 END) END,
    reason=CASE WHEN session_quality.reason IN ('known_bot','suspected_automation_batch') THEN session_quality.reason WHEN session_quality.visible_ms+excluded.visible_ms>=2000 OR session_quality.second_page IS NOT NULL OR (session_quality.first_page IS NOT NULL AND excluded.first_page IS NOT NULL AND session_quality.first_page!=excluded.first_page) THEN 'confirmed' ELSE session_quality.reason END`)
    .bind(session,site,visitor,now,now,deltaMs,knownBot?0:deltaMs>=2000?1:0,knownBot?'known_bot':deltaMs>=2000?'confirmed':'unconfirmed',pagePath,null).run();
  if (knownBot) return json({ok:true,ignored:'bot'},202,cors);
  // Engagement confirms dwell time; it is never a goal or an extra pageview.
  if (name === '__lucid_engagement') return json({ok:true},202,cors);
  if (name.startsWith('__lucid_')) return json({error:'reserved event name'},400,cors);

  // New vs returning is a property of the visit, decided once when it starts
  // and then carried by every event in it. Mid-visit events must not re-check,
  // or they would all count as "returning" the moment the first one is stored.
  let isReturning = 0;
  if (recent) {
    isReturning = recent.is_returning || 0;
  } else {
    const seen = await env.DB.prepare(
      `SELECT 1 FROM events WHERE person_id = ? AND session_id IN (SELECT session_id FROM report_sessions) LIMIT 1`
    ).bind(person).first();
    isReturning = seen ? 1 : 0;
  }

  // Where a visit came from is a property of the visit, not of each hit inside
  // it. A custom event fired mid-visit carries no referrer, so left alone it
  // would be filed under "Direct" and quietly credit the wrong channel for a
  // visitor who actually arrived from Instagram. Inherit the visit's original
  // attribution instead.
  if (recent) {
    channel = recent.channel || channel;
    referrer = recent.referrer || referrer;
    refDomain = recent.ref_domain || refDomain;
    utm = {
      source: recent.utm_source || utm.source,
      medium: recent.utm_medium || utm.medium,
      campaign: recent.utm_campaign || utm.campaign,
    };
  }

  // Primary language only — "en-GB,en;q=0.9,it;q=0.8" becomes "en-GB".
  const language = (request.headers.get("Accept-Language") || "")
    .split(",")[0].trim().slice(0, 12) || null;

  const screen = Number.isFinite(+body.w) && +body.w > 0 ? Math.min(+body.w, 20000) : null;

  const insert = env.DB.prepare(
    `INSERT INTO events
       (site, ts, name, path, referrer, ref_domain, channel,
        utm_source, utm_medium, utm_campaign,
        visitor_id, session_id, person_id, is_returning,
        country, region, city, continent, timezone,
        browser, os, device, network, language, screen, props)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    site,
    now,
    name,
    path,
    referrer,
    refDomain,
    channel,
    utm.source,
    utm.medium,
    utm.campaign,
    visitor,
    session,
    person,
    isReturning,
    cf.country || null,
    region,
    cf.city || null,
    cf.continent || null,
    cf.timezone || null,
    client.browser,
    client.os,
    client.device,
    cf.asOrganization || null,
    language,
    screen,
    body.p ? JSON.stringify(body.p).slice(0, 2000) : null
  );

  // Respond immediately; the write finishes in the background.
  await insert.run();
  return json({ ok: true }, 202, cors);
}

/** Daily-rotating, non-reversible visitor hash. No cookie, no stored IP. */
async function visitorId(ip, ua, site, salt) {
  const day = new Date().toISOString().slice(0, 10); // UTC date
  return sha256Hex(`${salt}|${day}|${site}|${ip}|${ua}`);
}

/**
 * Stable, non-reversible hash used only to answer "have we seen this person
 * before?". No date component, so unlike visitorId it survives midnight.
 *
 * Still nothing stored on the device and still not reversible, but it is
 * genuinely persistent linking, so it is kept in its own column and is never
 * used for the unique-visitor count — that stays on the daily hash.
 *
 * It is also naturally lossy: mobile carriers reassign IPs constantly and any
 * browser update changes the UA, both of which mint a new person. Returning
 * visitors are therefore under-counted, never over-counted.
 */
async function personId(ip, ua, site, salt) {
  return sha256Hex(`person|${salt}|${site}|${ip}|${ua}`);
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ */
/* classification                                                      */
/* ------------------------------------------------------------------ */

function domainOf(referrer, site) {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
    if (host === site || host.endsWith(`.${site}`)) return null; // internal navigation
    return host;
  } catch {
    return null;
  }
}

const SEARCH_ENGINES = [
  "google", "bing", "duckduckgo", "yahoo", "yandex", "baidu",
  "ecosia", "startpage", "qwant", "search.brave",
];

const SOCIAL_NETWORKS = [
  "instagram", "facebook", "fb.com", "tiktok", "twitter", "x.com", "t.co",
  "linkedin", "reddit", "youtube", "pinterest", "snapchat", "threads",
  "discord", "whatsapp", "telegram", "tumblr", "quora",
];

function classifyChannel(refDomain, utm) {
  const medium = (utm.medium || "").toLowerCase();
  if (["cpc", "ppc", "paid", "paidsearch", "paid-social", "display"].includes(medium)) return "Paid";
  if (medium === "email") return "Email";

  if (!refDomain) return "Direct";
  if (SEARCH_ENGINES.some((s) => refDomain.includes(s))) return "Organic Search";
  if (SOCIAL_NETWORKS.some((s) => refDomain.includes(s))) return "Organic Social";
  return "Referral";
}

/**
 * Compact user-agent parser.
 *
 * In-app browsers are named specifically (Instagram, TikTok, ...) rather than
 * lumped into a single "Mobile App" bucket, because for an Instagram-driven
 * funnel that distinction is the whole point — it tells you which platform is
 * actually sending traffic even when the referrer is stripped.
 */
function parseUA(ua) {
  const s = ua || "";
  let browser = "Unknown";

  if (/Instagram/i.test(s)) browser = "Instagram";
  else if (/BytedanceWebview|TikTok|musical_ly/i.test(s)) browser = "TikTok";
  else if (/FBAN|FBAV|FB_IAB/i.test(s)) browser = "Facebook";
  else if (/Snapchat/i.test(s)) browser = "Snapchat";
  else if (/LinkedInApp/i.test(s)) browser = "LinkedIn";
  else if (/Twitter/i.test(s)) browser = "X";
  else if (/Pinterest/i.test(s)) browser = "Pinterest";
  else if (/Edg\//i.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(s)) browser = "Opera";
  else if (/SamsungBrowser/i.test(s)) browser = "Samsung Internet";
  else if (/Firefox\/|FxiOS/i.test(s)) browser = "Firefox";
  else if (/Chrome\/|CriOS/i.test(s)) browser = "Chrome";
  else if (/Safari\//i.test(s)) browser = "Safari";

  let os = "Unknown";
  if (/iPhone|iPad|iPod/i.test(s)) os = "iOS";
  else if (/Android/i.test(s)) os = "Android";
  else if (/Windows NT/i.test(s)) os = "Windows";
  else if (/Mac OS X|Macintosh/i.test(s)) os = "macOS";
  else if (/CrOS/i.test(s)) os = "ChromeOS";
  else if (/Linux/i.test(s)) os = "Linux";

  let device = "Desktop";
  if (/iPad|Tablet/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))) device = "Tablet";
  else if (/Mobi|iPhone|iPod|Android/i.test(s)) device = "Mobile";

  return { browser, os, device };
}

function looksLikeBot(ua) {
  return /bot|crawler|spider|crawling|preview|monitor|curl|wget|python-requests|headless|lighthouse|pingdom|uptime/i.test(
    ua || ""
  );
}

/* ------------------------------------------------------------------ */
/* stats API                                                           */
/* ------------------------------------------------------------------ */

// Viewport width → the same four buckets Plausible reports.
const SCREEN_SQL = `CASE
    WHEN screen IS NULL   THEN NULL
    WHEN screen <  576    THEN 'Mobile'
    WHEN screen <  992    THEN 'Tablet'
    WHEN screen < 1440    THEN 'Laptop'
    ELSE 'Desktop'
  END`;

const VISITOR_TYPE_SQL = `CASE WHEN is_returning = 1 THEN 'Returning' ELSE 'New' END`;

// Only these may be filtered or grouped on, and each maps to a fixed SQL
// expression. Values are always bound; nothing from the query string is ever
// interpolated as an identifier.
const DIMENSIONS = {
  path: "path", channel: "channel", ref_domain: "ref_domain",
  utm_source: "utm_source", utm_medium: "utm_medium", utm_campaign: "utm_campaign",
  country: "country", region: "region", city: "city",
  continent: "continent", timezone: "timezone",
  browser: "browser", os: "os", device: "device",
  network: "network", language: "language",
  name: "name",
  screen: SCREEN_SQL,
  visitor_type: VISITOR_TYPE_SQL,
};

// Evaluate the costly whole-session rules once per report request. Reuse the
// immutable ID list in every breakdown instead of expanding views ~27 times.
async function automationSessionIds(env, site = null) {
  const result = await env.DB.prepare('SELECT DISTINCT session_id FROM session_automation_exclusions'+(site?' WHERE site=?':'')).bind(...(site?[site]:[])).all();
  return JSON.stringify(result.results.map(row=>row.session_id));
}

function buildWhere(site, from, to, filters, excluded) {
  const clauses = ["site = ?", "ts >= ?", "ts < ?", "session_id IN (SELECT session_id FROM session_quality WHERE qualified=1)", "session_id NOT IN (SELECT value FROM json_each(?))"];
  const binds = [site, from, to, excluded];

  for (const f of filters) {
    const expr = DIMENSIONS[f && f.field];
    if (!expr) continue;
    const values = (Array.isArray(f.value) ? f.value : [f.value]).filter((v) => v != null);
    if (!values.length) continue;
    const placeholders = values.map(() => "?").join(",");
    const op = f.op === "is_not" ? "NOT IN" : "IN";
    clauses.push(`${expr} ${op} (${placeholders})`);
    binds.push(...values.map(String));
  }

  return { where: clauses.join(" AND "), binds };
}

// Inspection counts are site-wide within the selected time range, regardless
// of report dimensions. Bind every user value; only existing rules may toggle.
async function handleAutomation(request, env, url) {
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'method not allowed' }, 405);
  const site = url.searchParams.get('site');
  if (!site || !(await allowedSites(env)).includes(site)) return json({ error: 'unknown site' }, 400);
  if (request.method === 'POST') {
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin not allowed' }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
    if (!body || typeof body.id !== 'string' || typeof body.enabled !== 'boolean') return json({ error: 'invalid rule update' }, 400);
    const rule = await env.DB.prepare('SELECT id FROM automation_rules WHERE id=? AND site=?').bind(body.id,site).first();
    if (!rule) return json({ error: 'unknown rule' }, 404);
    await env.DB.prepare('UPDATE automation_rules SET enabled=? WHERE id=? AND site=?').bind(body.enabled?1:0,body.id,site).run();
    return json({ ok: true });
  }
  const { from, to } = parseRange(url);
  const [rules, counts, sessions] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM automation_rules WHERE site=? ORDER BY id').bind(site),
    env.DB.prepare('SELECT rule_id,reason,COUNT(*) AS sessions FROM session_automation_exclusions WHERE site=? AND first_ts>=? AND first_ts<? GROUP BY rule_id,reason').bind(site,from,to),
    env.DB.prepare('SELECT * FROM session_automation_exclusions WHERE site=? AND first_ts>=? AND first_ts<? ORDER BY first_ts DESC,session_id LIMIT 100').bind(site,from,to),
  ]);
  return json({ site, range: { from,to }, rules:rules.results, counts:counts.results, sessions:sessions.results, limit:100 });
}

function parseFilters(url) {
  try {
    const f = JSON.parse(url.searchParams.get("filters") || "[]");
    return Array.isArray(f) ? f : [];
  } catch {
    return [];
  }
}

/** Accepts either from/to (unix seconds) or days=N. */
function parseRange(url) {
  const now = Math.floor(Date.now() / 1000);
  let to = parseInt(url.searchParams.get("to"), 10);
  let from = parseInt(url.searchParams.get("from"), 10);
  if (!Number.isFinite(to) || to <= 0) to = now;
  if (!Number.isFinite(from) || from < 0) {
    const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "28", 10), 1), 400);
    from = to - days * 86400;
  }
  if (from >= to) from = to - 86400;
  return { from, to, span: to - from };
}

async function handleStats(request, env, url) {
  const site = url.searchParams.get("site");
  if (!site) return json({ error: "site is required" }, 400);

  const { from, to, span } = parseRange(url);
  const prevFrom = from - span;
  const filters = parseFilters(url);

  const excluded = await automationSessionIds(env,site);
  const cur = buildWhere(site, from, to, filters, excluded);
  const prev = buildWhere(site, prevFrom, from, filters, excluded);

  // Hourly buckets for short ranges, daily otherwise.
  const hourly = span <= 2 * 86400;
  const bucket = hourly ? "%Y-%m-%dT%H:00" : "%Y-%m-%d";

  const breakdown = (key, limit = 12) => {
    const expr = DIMENSIONS[key];
    return env.DB.prepare(
      `SELECT ${expr} AS k, COUNT(DISTINCT visitor_id) AS v
         FROM events
        WHERE ${cur.where} AND ${expr} IS NOT NULL AND ${expr} != ''
        GROUP BY k ORDER BY v DESC LIMIT ${limit}`
    ).bind(...cur.binds);
  };

  const edgePage = (direction) =>
    env.DB.prepare(
      `SELECT path AS k, COUNT(DISTINCT session_id) AS v FROM (
         SELECT session_id, path,
                ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts ${direction}, id ${direction}) AS rn
           FROM events
          WHERE ${cur.where} AND name = 'pageview' AND path IS NOT NULL
       ) WHERE rn = 1
        GROUP BY k ORDER BY v DESC LIMIT 12`
    ).bind(...cur.binds);

  const statements = [
    // 0 — headline totals
    env.DB.prepare(
      `SELECT COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(DISTINCT session_id) AS visits,
              SUM(CASE WHEN name = 'pageview' THEN 1 ELSE 0 END) AS pageviews
         FROM events WHERE ${cur.where}`
    ).bind(...cur.binds),

    // 1 — bounces + total duration as raw sums.
    //
    // A bounce is a visit that landed on a page and then did nothing: exactly
    // one pageview and no other event. Two things this deliberately does NOT do:
    //
    //   * count pv = 0 visits. A visit with no pageview cannot have bounced —
    //     nothing was viewed. These are real and common: sessions are cut
    //     server-side after SESSION_GAP, so a tab left open and returned to an
    //     hour later opens a fresh visit made only of custom events. Counting
    //     those as bounces was putting the rate ~45 points too high.
    //   * treat a single pageview as a bounce on its own. Single-page apps
    //     never fire a second pageview no matter how engaged the visitor is,
    //     so pageview-count alone measures the app's routing, not behaviour.
    //     Any custom event in the visit means something happened.
    //
    // `landed` is the denominator: visits that actually began with a pageview.
    env.DB.prepare(
      `SELECT SUM(CASE WHEN pv >= 1 AND ev <= 1 THEN 1 ELSE 0 END) AS bounces,
              SUM(CASE WHEN pv >= 1 THEN 1 ELSE 0 END) AS landed,
              SUM(dur) AS total_duration,
              COUNT(*) AS sessions
         FROM (
           SELECT session_id,
                  SUM(CASE WHEN name = 'pageview' THEN 1 ELSE 0 END) AS pv,
                  COUNT(*) AS ev,
                  COALESCE((SELECT CAST(q.visible_ms/1000 AS INTEGER) FROM session_quality q WHERE q.session_id=events.session_id),MAX(ts)-MIN(ts)) AS dur
             FROM events WHERE ${cur.where}
            GROUP BY session_id
         )`
    ).bind(...cur.binds),

    // 2 — previous period, for the % deltas
    env.DB.prepare(
      `SELECT COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(DISTINCT session_id) AS visits,
              SUM(CASE WHEN name = 'pageview' THEN 1 ELSE 0 END) AS pageviews
         FROM events WHERE ${prev.where}`
    ).bind(...prev.binds),

    // 3 — timeseries (all three chartable metrics)
    env.DB.prepare(
      `SELECT strftime('${bucket}', ts, 'unixepoch') AS t,
              COUNT(DISTINCT visitor_id) AS v,
              COUNT(DISTINCT session_id) AS visits,
              SUM(CASE WHEN name = 'pageview' THEN 1 ELSE 0 END) AS pageviews
         FROM events WHERE ${cur.where}
        GROUP BY t ORDER BY t`
    ).bind(...cur.binds),

    // 4..13 — dimension breakdowns
    breakdown("channel"),
    breakdown("ref_domain"),
    breakdown("utm_campaign"),
    breakdown("path"),
    breakdown("country"),
    breakdown("region"),
    breakdown("city"),
    breakdown("browser"),
    breakdown("os"),
    breakdown("device"),

    // 14, 15 — entry / exit pages
    edgePage("ASC"),
    edgePage("DESC"),

    // 16 — goals (every non-pageview event)
    env.DB.prepare(
      `SELECT name AS k,
              COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(*) AS events
         FROM events
        WHERE ${cur.where} AND name != 'pageview'
        GROUP BY k ORDER BY events DESC LIMIT 25`
    ).bind(...cur.binds),

    // 17..21 — the richer visitor detail
    breakdown("visitor_type", 2),
    breakdown("network"),
    breakdown("language"),
    breakdown("timezone"),
    breakdown("screen"),
    env.DB.prepare(`SELECT COUNT(*) AS suspected,
      SUM(CASE WHEN reason='known_bot' THEN 1 ELSE 0 END) AS known,
      SUM(CASE WHEN reason='legacy_unverified' THEN 1 ELSE 0 END) AS legacy,
      SUM(CASE WHEN qualified=0 AND reason='unconfirmed' THEN 1 ELSE 0 END) AS short,
      SUM(CASE WHEN qualified=1 THEN 1 ELSE 0 END) AS automated
      FROM session_quality WHERE site=? AND (qualified=0 OR session_id IN (SELECT value FROM json_each(?))) AND first_ts>=? AND first_ts<? AND last_ts<=?`).bind(site,excluded,from,to,Math.floor(Date.now()/1000)-5),
    // Revenue is derived from configured fixed-value events, with the same
    // date, report filters, and qualified-session gate as the other metrics.
    env.DB.prepare(`SELECT COALESCE(SUM((SELECT amount_minor FROM revenue_rules rr WHERE rr.site=events.site AND rr.event_name=events.name)),0) AS revenue_minor
      FROM events WHERE ${cur.where} AND name IN (SELECT event_name FROM revenue_rules WHERE site=?)`).bind(...cur.binds, site),
    env.DB.prepare(`SELECT COALESCE(SUM((SELECT amount_minor FROM revenue_rules rr WHERE rr.site=events.site AND rr.event_name=events.name)),0) AS revenue_minor
      FROM events WHERE ${prev.where} AND name IN (SELECT event_name FROM revenue_rules WHERE site=?)`).bind(...prev.binds, site),
    env.DB.prepare(`SELECT strftime('${bucket}', ts, 'unixepoch') AS t,
      COALESCE(SUM((SELECT amount_minor FROM revenue_rules rr WHERE rr.site=events.site AND rr.event_name=events.name)),0) AS revenue_minor
      FROM events WHERE ${cur.where} AND name IN (SELECT event_name FROM revenue_rules WHERE site=?) GROUP BY t ORDER BY t`).bind(...cur.binds, site),
    env.DB.prepare(`SELECT currency FROM revenue_settings WHERE site=?`).bind(site),
  ];

  const r = await env.DB.batch(statements);
  const rows = (i) => r[i]?.results || [];
  const one = (i) => r[i]?.results?.[0] || {};

  const totals = one(0);
  const rates = one(1);
  const previous = one(2);

  const visitors = totals.visitors || 0;
  const visits = totals.visits || 0;
  const pageviews = totals.pageviews || 0;
  const revenueMinor = one(23).revenue_minor || 0;
  const previousRevenueMinor = one(24).revenue_minor || 0;
  const currency = one(26).currency || "USD";
  const bounces = rates.bounces || 0;
  const landed = rates.landed || 0;
  const sessions = rates.sessions || 0;
  const totalDuration = rates.total_duration || 0;

  return json({
    range: { from, to, span },
    quality: { suspectedBotSessions: one(22).suspected || 0, knownBotSessions: one(22).known || 0, legacyUnverifiedSessions: one(22).legacy || 0, shortUnqualifiedSessions: one(22).short || 0, likelyAutomatedSessions: one(22).automated || 0 },
    totals: {
      visitors,
      visits,
      pageviews,
      revenueMinor,
      viewsPerVisit: visits ? +(pageviews / visits).toFixed(2) : 0,
      // Over visits that actually landed on a page, not over every visit.
      bounceRate: landed ? Math.round((bounces / landed) * 100) : 0,
      duration: sessions ? Math.round(totalDuration / sessions) : 0,
    },
    deltas: {
      visitors: pctChange(visitors, previous.visitors || 0),
      visits: pctChange(visits, previous.visits || 0),
      pageviews: pctChange(pageviews, previous.pageviews || 0),
      revenue: pctChange(revenueMinor, previousRevenueMinor),
    },
    timeseries: fillBuckets(rows(3).map((r) => ({ ...r, revenue_minor: r.revenue_minor || 0 })), from, to, hourly),
    currency,
    channels: rows(4),
    sources: rows(5),
    campaigns: rows(6),
    pages: rows(7),
    countries: rows(8),
    regions: rows(9),
    cities: rows(10),
    browsers: rows(11),
    os: rows(12),
    devices: rows(13),
    entry: rows(14),
    exit: rows(15),
    goals: rows(16),
    visitorTypes: rows(17),
    networks: rows(18),
    languages: rows(19),
    timezones: rows(20),
    screens: rows(21),
  });
}

/* ---- individual visits: the most detail available per person -------- */

async function handleVisits(env, url) {
  const site = url.searchParams.get("site");
  if (!site) return json({ error: "site is required" }, 400);

  const { from, to } = parseRange(url);
  const cur = buildWhere(site, from, to, parseFilters(url), await automationSessionIds(env,site));
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10), 1), 200);

  // One row per visit. MIN(ts) keyed columns describe how the visit began;
  // entry/exit come from the first and last pageview path.
  const { results } = await env.DB.prepare(
    `WITH ranked AS (
       SELECT *,
              ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts ASC,  id ASC)  AS first_rn,
              ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts DESC, id DESC) AS last_rn
         FROM events WHERE ${cur.where}
     )
     SELECT session_id,
            MIN(ts) AS started,
            COALESCE((SELECT CAST(q.visible_ms/1000 AS INTEGER) FROM session_quality q WHERE q.session_id=ranked.session_id),MAX(ts)-MIN(ts)) AS duration,
            SUM(CASE WHEN name = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
            COUNT(*) AS events,
            MAX(CASE WHEN first_rn = 1 THEN country      END) AS country,
            MAX(CASE WHEN first_rn = 1 THEN region       END) AS region,
            MAX(CASE WHEN first_rn = 1 THEN city         END) AS city,
            MAX(CASE WHEN first_rn = 1 THEN timezone     END) AS timezone,
            MAX(CASE WHEN first_rn = 1 THEN browser      END) AS browser,
            MAX(CASE WHEN first_rn = 1 THEN os           END) AS os,
            MAX(CASE WHEN first_rn = 1 THEN device       END) AS device,
            MAX(CASE WHEN first_rn = 1 THEN screen       END) AS screen,
            MAX(CASE WHEN first_rn = 1 THEN network      END) AS network,
            MAX(CASE WHEN first_rn = 1 THEN language     END) AS language,
            MAX(CASE WHEN first_rn = 1 THEN channel      END) AS channel,
            MAX(CASE WHEN first_rn = 1 THEN ref_domain   END) AS ref_domain,
            MAX(CASE WHEN first_rn = 1 THEN is_returning END) AS is_returning,
            MAX(CASE WHEN first_rn = 1 THEN path         END) AS entry,
            MAX(CASE WHEN last_rn  = 1 THEN path         END) AS exit
       FROM ranked
      GROUP BY session_id
      ORDER BY started DESC
      LIMIT ${limit}`
  ).bind(...cur.binds).all();

  return json({ visits: results || [] });
}

/* ---- individual custom events, newest first, with their properties -- */

async function handleEvents(env, url) {
  const site = url.searchParams.get("site");
  if (!site) return json({ error: "site is required" }, 400);

  const { from, to } = parseRange(url);
  const cur = buildWhere(site, from, to, parseFilters(url), await automationSessionIds(env,site));
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10), 1), 200);

  // Custom events only — pageviews carry no properties and already have
  // their own view (Top Pages), so they'd just be noise in this feed.
  const { results } = await env.DB.prepare(
    `SELECT ts, name, path, props, country, region, city,
            browser, os, device, is_returning, channel, ref_domain
       FROM events
      WHERE ${cur.where} AND name != 'pageview'
      ORDER BY ts DESC, id DESC
      LIMIT ${limit}`
  ).bind(...cur.binds).all();

  const events = (results || []).map((r) => {
    let props = null;
    if (r.props) {
      try { props = JSON.parse(r.props); } catch { /* leave null */ }
    }
    return { ...r, props };
  });

  return json({ events });
}

/* ---- journey: what happens 1 and 2 steps after a chosen start ------ */

async function handleJourney(env, url) {
  const site = url.searchParams.get("site");
  const start = url.searchParams.get("start");
  if (!site || !start) return json({ error: "site and start are required" }, 400);

  const { from, to } = parseRange(url);
  const cur = buildWhere(site, from, to, parseFilters(url), await automationSessionIds(env,site));

  // A "step" is the page path for pageviews and the event name otherwise, so
  // the journey reads the way Plausible's does: / → scan_pick → /pricing.
  const { results } = await env.DB.prepare(
    `WITH seq AS (
       SELECT session_id,
              CASE WHEN name = 'pageview' THEN COALESCE(path, '/') ELSE name END AS step,
              ts, id
         FROM events WHERE ${cur.where}
     ),
     chain AS (
       SELECT step,
              LEAD(step, 1) OVER (PARTITION BY session_id ORDER BY ts, id) AS n1,
              LEAD(step, 2) OVER (PARTITION BY session_id ORDER BY ts, id) AS n2
         FROM seq
     )
     SELECT n1, n2, COUNT(*) AS c FROM chain
      WHERE step = ? AND n1 IS NOT NULL
      GROUP BY n1, n2`
  )
    .bind(...cur.binds, start)
    .all();

  const step1 = new Map();
  const step2 = new Map();
  for (const row of results || []) {
    step1.set(row.n1, (step1.get(row.n1) || 0) + row.c);
    if (row.n2 != null) step2.set(row.n2, (step2.get(row.n2) || 0) + row.c);
  }
  const toList = (m) =>
    [...m].map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v).slice(0, 10);

  return json({ start, step1: toList(step1), step2: toList(step2) });
}

/**
 * SQL's GROUP BY only returns buckets that actually had an event, so a
 * single visitor at 2pm on an otherwise empty day produces one floating
 * point with nothing around it instead of a flat line that jumps when it
 * happens. Fill every bucket in [from, to) with zero counts first, then
 * overlay whatever the query actually found.
 */
function fillBuckets(rows, from, to, hourly) {
  const step = hourly ? 3600 : 86400;
  const keyOf = (t) => {
    const iso = new Date(t * 1000).toISOString();
    return hourly ? iso.slice(0, 13) + ":00" : iso.slice(0, 10);
  };
  const byKey = new Map(rows.map((r) => [r.t, r]));
  const start = Math.floor(from / step) * step;
  const out = [];
  for (let t = start; t < to; t += step) {
    const key = keyOf(t);
    out.push(byKey.get(key) || { t: key, v: 0, visits: 0, pageviews: 0, revenue_minor: 0 });
  }
  return out;
}

function pctChange(now, before) {
  if (!before) return now ? 100 : 0;
  return Math.round(((now - before) / before) * 100);
}

/* ------------------------------------------------------------------ */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
