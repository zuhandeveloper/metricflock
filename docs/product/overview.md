# Product Overview

MetricFlock manages Google analytics and publisher data for
portfolios of 100+ websites, organized into teams, with website
ownership transfers (flipping) as a first-class workflow.

## Core concepts

- **Organization** — the tenant. Users, teams, websites, connections
  and audit history all live inside one organization.
- **Team** — a group of websites + members. Team admins manage their
  team's websites and connections.
- **Website** — a site being tracked. Belongs to exactly one team;
  members can be assigned to individual websites.
- **Google connection** — an OAuth grant owned by a team or a
  website. Properties (GA4, Search Console sites, AdSense accounts)
  are discovered from it and **mapped** to websites; fetches always
  use the connection the mapping was made under.
- **Transfer** — moving a website between teams is two-sided: the
  destination team accepts, connects its own Google account, and
  only then does ownership move (old assignments/integrations are
  cleared). See `docs/ownership-transfer.md`.

## Data sources

GA4 (realtime + historical), Search Console, AdSense, and optional
Ad Manager — all via the real Google APIs. When a website has no
connection or no mapped property, the UI says so explicitly
(`not_connected` / `missing_data`); numbers are never invented.
Analytics correctness rules (dimension-less totals, impression-
weighted position, sampling caveats) are documented in the audit
(DATA-1…DATA-11) and implemented in `packages/google`.

## Sync

A BullMQ worker + scheduler keep caches warm: realtime every 5 min
(coalesced, backpressured), historical/Search Console/AdSense on
their own cadences, OAuth refresh ahead of expiry, health checks
hourly. Terminal failures email org admins and land in a
dead-letter view with one-click requeue
(`docs/operations/observability.md`).

## Roles

`SUPER_ADMIN` (whole org), `TEAM_ADMIN` (own team), `TEAM_MEMBER`
(assigned websites). Permission matrix:
`packages/auth/src/permissions.ts`.
