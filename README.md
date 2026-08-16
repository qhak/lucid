# Lucid Analytics

Lucid is a small, self-hosted web analytics dashboard I built for my own sites. I wanted a useful view of traffic without paying for a hosted analytics product or adding cookie-based visitor tracking to my sites.

This repository is a personal software project and a record of how I approached that problem. It is not a hosted service or a commercial product.

## What it does

Lucid collects page views and custom events through a lightweight script, then shows the results in a password-protected dashboard. It runs on Cloudflare Workers with Cloudflare D1 as its database.

The dashboard includes:

- Visitors, visits, page views, visit duration and bounce rate
- Referrers, channels, campaigns, entry pages and exit pages
- Browser, device, language, network and approximate location breakdowns
- Custom events, event journeys and configurable event-based revenue totals
- Recent visits and events, with the dimensions attached to each record
- Site and browser opt-outs, plus configurable location exclusions
- Reviewable, reversible rules for filtering suspected automated visits

The feature set grew from questions I wanted to answer about my own sites. The project is still single-tenant: one dashboard password protects the instance, and there is no signup, billing, or multi-customer account system.

## Privacy choices and trade-offs

Lucid does not set analytics cookies or use local storage to identify visitors. Daily unique visitor IDs are one-way hashes derived from the request IP address and user agent, with the IP address discarded rather than stored. The daily salt means the visitor ID rotates at UTC midnight.

Returning-visitor reporting uses a separate one-way hash that persists across days. It is still derived from IP address and user agent, so it can be inaccurate when either changes. This keeps a useful returning-visitor estimate without a browser identifier, but it is a privacy trade-off—not anonymous measurement. Lucid also records contextual dimensions such as approximate location, browser, network and screen size, which can make a visit more distinctive in combination.

The project is designed to avoid cookie-based tracking; that alone does not determine what privacy notice or legal obligations apply to a particular deployment. Review the data you choose to collect and the rules that apply where your site operates.

## A few implementation decisions

- **Self-hosted collection:** the tracking endpoint, dashboard and database run in the owner's Cloudflare account.
- **Small tracker:** sites include `public/tracker.js`; it sends page views and visible-time engagement, and supports custom events.
- **Visit-based attribution:** event reports retain the source recorded when a visit began, rather than attributing later events to Direct.
- **Cautious automation filtering:** short visits are not automatically labelled bots. Site-specific rules can be reviewed and reversed, and raw events are retained. No site-specific rules are enabled by default.
- **No billing system:** this began as a tool for my own use, so account plans, subscriptions and customer management are outside its scope.

## Tech stack

- JavaScript on Cloudflare Workers
- Cloudflare D1 (SQLite) for event and configuration storage
- Static HTML, CSS and JavaScript for the dashboard and tracking script
- Wrangler for local development and deployment

## Run your own instance

Lucid is built around Cloudflare Workers and D1. To create a separate instance:

1. Install Node.js and authenticate Wrangler with your Cloudflare account:

   ```bash
   npx wrangler login
   ```

2. Create a D1 database, then set your Cloudflare account ID and the database ID in `wrangler.toml`:

   ```bash
   npx wrangler d1 create lucid-analytics
   ```

3. Apply the schema to that database:

   ```bash
   npx wrangler d1 execute lucid-analytics --remote --file=./schema.sql
   ```

4. Set the dashboard password and a random ID salt as Worker secrets:

   ```bash
   npx wrangler secret put DASH_PASSWORD
   npx wrangler secret put ID_SALT
   ```

   Generate `ID_SALT` locally, for example with `openssl rand -hex 32`. Changing it resets visitor identity for future events.

5. Set `ALLOWED_SITES` in `wrangler.toml` to the site origins allowed to send events, then deploy:

   ```bash
   npx wrangler deploy
   ```

The repository excludes deployment-specific analytics notes, historical corrections and raw traffic snapshots. The Workers and D1 free allowances have limits and can change. Check Cloudflare's current terms for your account; this project does not guarantee zero hosting costs.

## Add the tracker

Add the deployed Worker URL and your site domain to the page:

```html
<script defer data-domain="example.com"
        src="https://your-worker.example.workers.dev/tracker.js"></script>
```

Custom events can be sent with `stats`:

```js
stats('signup_complete');
stats('scan_result', { tier: 'elite' });
```

## Repository map

| Path | Purpose |
| --- | --- |
| `src/worker.js` | Event collection, authentication, session handling and dashboard APIs |
| `public/tracker.js` | Site tracking script |
| `public/` | Dashboard assets |
| `schema.sql` | Schema for a fresh database |
| `migrations/` | Incremental schema changes |
| `wrangler.toml` | Worker and D1 configuration |

## Project status

Lucid is an evolving personal project. It has useful reporting for the sites it was built around, but it is not a general-purpose analytics platform: it has no self-service onboarding, team accounts, public reports, or guarantee of compatibility with every deployment.
