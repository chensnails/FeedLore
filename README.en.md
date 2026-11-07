中文：[README.md](README.md)

# FeedLore

> Gather what's worth reading — a clean, comfortable **self-hosted RSS reader** with a resource Card Wall.
> Multi-user, no ads, no telemetry; all data lives in your own PostgreSQL.

**Live demo**: https://feedlore.669600.xyz · demo account `demo` / `demo`

Current version **2.4.0** · [Changelog](CHANGELOG.en.md) · [Upgrade & deployment](UPGRADE-v2.en.md)

## What this is

FeedLore is a self-hosted RSS reader made primarily for personal use. It offers two reading modes — an Article view and a Card Wall — helping you spot worthwhile information quickly, jump straight to the original, and extract resource links from articles. It is especially handy for articles that share cloud-drive resources.

## Features

- **Reading**: channels on the left (organized by group), articles on the right; click a title to expand the full text in place. Read / unread / starred, server-side search, and auto-refresh are all built in.
- **Card Wall**: grid or list layout, filter by channel or group, and search; jumps to and from the Article view with the landing item highlighted. Cards extract resource links from articles, let you copy them with one click, and recognize common cloud drives.
- **Feed management**: OPML import/export (groups included, automatic deduplication), channel rename and URL change, drag-and-drop group ordering, per-channel fetch interval. Enable full-text fetching for channels that only publish summaries; channels that fail repeatedly are automatically disabled.
- **Rules**: Watch / Block keywords tag items; watched items are collected in a smart group with configurable watch retention days before they drop out automatically. Pre-ingest filters match keywords or regex and act as "discard / keep only". Both rule types can be scoped to specific groups or channels.
- **Multi-user & roles**: each user has their own feeds, read state, stars, rules, and model configuration. Accounts are created by an admin; read-only accounts are supported. Public registration is off by default.
- **Appearance & mobile**: 4 themes and 6 accent colors, with adjustable font size / typeface / line height / reading width / card density. On phones: full-screen sheets, pull-to-dismiss, and edge gestures; add to home screen works under HTTPS.
- **AI daily digest**: configure a model per account to summarize the last 24 hours of new items into a concise Chinese digest; other features work fine without it.
- **MCP endpoint**: external AI clients (Claude, Cherry Studio, ...) call read-only tools via `/mcp` — feeds, article search & full text, AI digest. Tokens are created and revoked in Settings - MCP, fully independent from browser sessions.
- **One-click update**: check the version from the Settings page and update directly via Watchtower.

## Screenshots

| Article view (light) | Article view (dark) |
| --- | --- |
| ![Article view](docs/screenshots/02-reader.png) | ![Article view · dark](docs/screenshots/06-reader-dark.png) |

| Card Wall | Mobile |
| --- | --- |
| ![Card Wall](docs/screenshots/03-cards.png) | ![Mobile full-screen detail](docs/screenshots/10-mobile-detail.png) |

## Quick start

Requires Docker 24+ with Compose v2 and one free port (default `3210`). No need to clone the source or prepare a `.env` in advance.

```bash
mkdir feedlore && cd feedlore
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
docker compose -f docker-compose.v2.release.yml up -d
```

The first start pulls the image, creates the database, and initializes it, which may take a few minutes. To watch progress or debug failures, run
`docker compose -f docker-compose.v2.release.yml logs upgrade`.

A brand-new site creates the admin account `admin` with a one-time random password, printed exactly once in the startup log:

```bash
docker compose -f docker-compose.v2.release.yml logs app | grep 'one-time password'
```

Once you have the password, open `http://<host>:3210`, sign in, and change it immediately under Settings → Account. Then add RSS / Atom feeds or import an OPML file under Settings → Sources, and start reading.

## Configuration & upgrades

The defaults work out of the box. To change the port, run behind an HTTPS reverse proxy, reuse a database password, or set the initial account, copy [`.env.example`](.env.example) to `.env` — every variable's meaning and default is documented in the file's comments. Re-run `up -d` after editing.

- **Upgrading from 1.x**: sites running Watchtower need no action — the migration runs automatically and keeps your existing account password. For manual steps, rollback, and backups, see [UPGRADE-v2.en.md](UPGRADE-v2.en.md).
- **Updating**: images are pinned to a version by default; change `V2_IMAGE` to switch versions. Setting it to `:latest` follows Watchtower rolling upgrades, or use the one-click update under Settings → About.

## Local development

Requires Node ≥ 22.

```bash
pnpm install
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/feedlore_v2
pnpm --filter @feedlore/db migrate
pnpm --filter @feedlore/server dev   # http://127.0.0.1:3000
pnpm --filter @feedlore/web dev      # Vite, 5173
```

API definitions and validation live in `packages/contract`; fetching, rules, the daily digest, and image caching live in `apps/server`; the frontend lives in `apps/web`. Tests and type checks:

```bash
pnpm -r typecheck
pnpm -r test
```

## License

[GPL-3.0](LICENSE).
