/**
 * Tracker — drop this on any site you own.
 *
 *   <script defer src="https://analytics.<you>.workers.dev/tracker.js"></script>
 *
 * No data-domain attribute needed — the site is whatever domain the browser
 * is currently on. (An older snippet with data-domain still works fine; the
 * attribute is just never read.)
 *
 * Custom events (same names you were sending to Plausible):
 *
 *   stats('hero_cta_click');
 *   stats('scan_result', { tier: 'elite' });
 *
 * To stop counting your own visits, open the site once with ?lucidignore=true
 * appended. That sets a flag in localStorage for that browser and this
 * tracker then goes quiet — no events at all, from any page, until you
 * visit with ?lucidignore=false. Legacy ?exclude_me / ?include_me also work.
 *
 * Sets no cookies and reads nothing except that one opt-out flag.
 */
(function () {
  "use strict";

  // The worker injects its own origin here when it serves this file, so the
  // browser never has to introspect its own <script> tag to find out where
  // to send events. That introspection (document.currentScript) used to be
  // how this worked, and it is exactly the kind of thing privacy tools and
  // content blockers are built to break — if currentScript came back null,
  // this whole script used to silently no-op. There is nothing left here for
  // that class of tool to interfere with.
  var endpoint = "__LUCID_ENDPOINT__" + "/event";

  var site = location.hostname.replace(/^www\./, "");

  var OPT_OUT = "analytics_ignore";

  // Explicit URL opt-out works even when localStorage is blocked.
  var switches = new URLSearchParams(location.search);
  var ignored = switches.get('lucidignore') === 'true' || switches.has('exclude_me');
  var included = switches.get('lucidignore') === 'false' || switches.has('include_me');
  try {
    if (included && !ignored) localStorage.removeItem(OPT_OUT);
    if (ignored) localStorage.setItem(OPT_OUT, '1');
    ignored = ignored || localStorage.getItem(OPT_OUT) === '1';
  } catch (e) {}
  if (ignored || location.hostname === 'localhost' || location.hostname === '127.0.0.1' || navigator.webdriver) {
    window.stats = function () {}; return;
  }

  // Accumulate visible time only. Hidden tabs cannot qualify themselves.
  // The server confirms visits after two visible seconds, unless a second
  // pageview arrives first and proves this was not an instant single-page exit.
  var visibleTotal = 0, reportedVisible = 0;
  var visibleStart = document.visibilityState === 'visible' ? performance.now() : null;
  var qualificationTimer = null;
  function visibleMs() {
    return Math.floor(visibleTotal + (visibleStart === null ? 0 : performance.now() - visibleStart));
  }
  function scheduleQualification() {
    clearTimeout(qualificationTimer);
    if (visibleStart === null) return;
    qualificationTimer = setTimeout(function () {
      send('__lucid_engagement');
      if (visibleMs() < 2000) scheduleQualification();
    }, Math.max(1, 2000 - visibleMs()));
  }

  function send(name, props) {
    var elapsed = visibleMs();
    var delta = Math.max(0, elapsed - reportedVisible);
    reportedVisible = elapsed;
    var payload = {
      delta_ms: delta,
      d: site,
      n: name,
      u: location.href,
      r: document.referrer || null,
      // Viewport width, bucketed server-side. Not screen.width — the window is
      // what the layout actually had to work with.
      w: window.innerWidth || document.documentElement.clientWidth || null,
    };
    if (props) payload.p = props;

    var body = JSON.stringify(payload);

    // sendBeacon survives the page being closed mid-request, which matters
    // for the last event of a visit. Fall back to fetch where unsupported.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
    } else {
      fetch(endpoint, {
        method: "POST",
        body: body,
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        mode: "cors",
      }).catch(function () {});
    }
  }

  var lastPath = null;

  function pageview() {
    // Guard against duplicate views for the same path (SPA routers often fire
    // several history events for one real navigation).
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    send("pageview");
  }

  // Public API. Also drains anything queued before this script loaded.
  var queued = (window.stats && window.stats.q) || [];
  window.stats = function (name, props) {
    if (name === "pageview") pageview();
    else send(name, props);
  };
  for (var i = 0; i < queued.length; i++) window.stats.apply(null, queued[i]);

  // Client-side route changes.
  var pushState = history.pushState;
  if (pushState) {
    history.pushState = function () {
      pushState.apply(this, arguments);
      pageview();
    };
    window.addEventListener("popstate", pageview);
  }

  // Pages restored from the back/forward cache never re-run this script.
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) {
      lastPath = null;
      visibleTotal = 0; reportedVisible = 0;
      visibleStart = document.visibilityState === 'visible' ? performance.now() : null;
      pageview(); scheduleQualification();
    }
  });

  // A tab left open and come back to hours later never reloads, so no pageview
  // fires — but the server closes the visit after SESSION_GAP and files the
  // next click under a brand new one. That visit then has custom events and no
  // pageview: no entry page, no source, and nothing a bounce rate can be
  // computed from. Re-open it properly when the tab comes back into view.
  // MUST stay >= SESSION_GAP in src/worker.js, or visits get split in two.
  var SESSION_GAP_MS = 30 * 60 * 1000;
  var hiddenAt = null;
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      if (visibleStart !== null) { visibleTotal += performance.now() - visibleStart; visibleStart = null; }
      clearTimeout(qualificationTimer);
      send('__lucid_engagement');
      hiddenAt = Date.now();
      return;
    }
    if (document.visibilityState !== 'visible') return;
    visibleStart = performance.now();
    if (hiddenAt && Date.now() - hiddenAt >= SESSION_GAP_MS) {
      visibleTotal = 0; reportedVisible = 0;
      lastPath = null;
      pageview();
    }
    hiddenAt = null;
    scheduleQualification();
  });

  if (document.visibilityState === "prerender") {
    document.addEventListener("visibilitychange", function fire() {
      if (document.visibilityState !== "prerender") {
        document.removeEventListener("visibilitychange", fire);
        pageview();
        scheduleQualification();
      }
    });
  } else {
    pageview();
    scheduleQualification();
  }
  window.addEventListener('pagehide', function () { send('__lucid_engagement'); });
  setInterval(function () { if (visibleStart !== null) send('__lucid_engagement'); }, 15000);
})();
