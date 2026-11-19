中文：[README.md](README.md)

# FeedLore

> Gather what's worth reading — a **self-hosted RSS reader** with a resource Card Wall.
> Multi-user · no ads · no telemetry · all data in your own PostgreSQL.

**Live demo**: https://feedlore.669600.xyz (`demo` / `demo`)
Current version **2.5.2** (2.5.3 unreleased) · [Changelog](CHANGELOG.en.md) · [Upgrade & deployment](UPGRADE-v2.en.md)

## Highlights

- **Two ways to read**: expand any article in place, or browse the Card Wall where images and extracted resource links are laid out as a grid — copy links with one click, common cloud drives recognized.
- **Feeds & rules**: OPML import/export, groups, per-feed intervals and full-text fetching; keyword / regex filters, Watch / Block rules scoped to groups or channels.
- **AI digest & MCP**: a daily Chinese brief of the last 24 hours; external AI clients query feeds, full articles and digests through `/mcp` ([setup guide](docs/MCP.md)).
- **Multi-user & roles**: separate feeds, read state, stars, rules and model config per account; read-only accounts supported, public registration off by default.
- **Details that feel right**: 4 themes × 6 accent colors, adjustable type size / density / reading width; on phones, swipeable channel tabs, full-screen sheets that close via the system back key, and a bottom nav that tucks away while scrolling.
- **Zero-fuss deployment**: one compose command to start; update via Watchtower or Settings → About.

## Screenshots

Captured from the [live demo](https://feedlore.669600.xyz) (`demo` / `demo`).

| Article view | Card Wall |
| --- | --- |
| ![Article view (light)](docs/screenshots/02-reader.png) | ![Card Wall (light)](docs/screenshots/03-cards.png) |

| Dark theme | Mobile |
| --- | --- |
| ![Article view (dark)](docs/screenshots/06-reader-dark.png) | ![Mobile article list](docs/screenshots/10-mobile-detail.png) |

## Quick start

Docker 24+ with Compose v2, plus one free port (default `3210`). No clone, no `.env` required.

**Option A: one-command script (recommended)** — starts, waits for health, and **prints the login URL and password right in your terminal**:

```bash
mkdir feedlore && cd feedlore
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/scripts/deploy.sh
chmod +x deploy.sh && ./deploy.sh
```

On a China network, use `deploy-cn.sh` (multi-source download + registry mirrors):

```bash
curl -fsSL -O https://gh-proxy.org/https://raw.githubusercontent.com/chensnails/FeedLore/main/scripts/deploy-cn.sh
chmod +x deploy-cn.sh && ./deploy-cn.sh
```

**Option B: manual**

```bash
mkdir feedlore && cd feedlore
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
docker compose -f docker-compose.v2.release.yml up -d
docker compose -f docker-compose.v2.release.yml logs app   # look for the first-run banner
```

Both options adapt to the situation and never overwrite existing data:

| Situation | What happens |
| --- | --- |
| **New site** (fresh install) | Creates `admin` with a random password: the script prints it; manual installs show a `FEEDLORE FIRST RUN` banner |
| **Existing site** (data present) | **Skips generation, keeps the current password**; the log says "existing accounts found" and shows the reset command |

**Forgot the password / missed the banner** (inside the container, no network endpoint):

```bash
# Recover the initial password within 24h
docker exec -it feedlore pnpm --filter @feedlore/server initial-password
# Reset and print a new password (invalidates all sessions for that account)
docker exec -it feedlore pnpm --filter @feedlore/server initial-password --reset
```

> **Manual upgrade on an existing site**: refresh the compose file before `up -d`, otherwise the old
> `upgrade` service blocks startup:
> `curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml`
> Watchtower / one-click update rebuild only the app container and need no compose change.

Open `http://<host>:3210`, sign in, change the password immediately, then add RSS / Atom feeds or import OPML under Settings → Sources.

## Configuration & upgrades

Defaults work out of the box. To change the port, run behind an HTTPS reverse proxy, reuse a database password or set the initial account, copy [`.env.example`](.env.example) to `.env` (every variable is documented) and re-run `up -d`.

- **Upgrading from 1.x**: automatic 1.x → 2.x data migration is removed (1.x databases deleted). Export from 1.7.4 via Settings → Data → Export, then import here. See [UPGRADE-v2.en.md](UPGRADE-v2.en.md).
- **Updating**: images are pinned to a version — change `V2_IMAGE` to switch; `:latest` follows Watchtower, or use the one-click update under Settings → About.

## Local development

Node ≥ 22.23.4 (the 22.x security floor; the same number is used by engines, the image and CI):

```bash
pnpm install
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/feedlore_v2
pnpm --filter @feedlore/db migrate
pnpm --filter @feedlore/server dev   # http://127.0.0.1:3000
pnpm --filter @feedlore/web dev      # Vite, 5173
```

Contracts live in `packages/contract`, the server in `apps/server`, the frontend in `apps/web`. Checks:

```bash
pnpm -r typecheck
pnpm -r test
```

## Support the project

Sponsorship is entirely voluntary and **unlocks no features**. If FeedLore saves you a subscription fee, you can open the QR code:

[Alipay QR code (click to open)](docs/screenshots/sponsor-alipay.png)

## License

[GPL-3.0](LICENSE).
