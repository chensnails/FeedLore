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

### Fresh install

**Outside China / GitHub reachable** — copy the whole block:

```bash
mkdir -p feedlore && cd feedlore
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
docker pull ghcr.io/chensnails/feedlore:2.5.2
docker compose -f docker-compose.v2.release.yml up -d
docker logs feedlore --tail 40        # first-run credentials are in this log
```

**China network** — mirrored endpoints are hard-coded below, just copy:

```bash
mkdir -p feedlore && cd feedlore
curl -fsSL -o docker-compose.v2.release.yml   'https://gh-proxy.org/https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml'
docker pull ghcr.nju.edu.cn/chensnails/feedlore:2.5.2
docker tag  ghcr.nju.edu.cn/chensnails/feedlore:2.5.2 ghcr.io/chensnails/feedlore:2.5.2
docker compose -f docker-compose.v2.release.yml up -d
docker logs feedlore --tail 40        # first-run credentials are in this log
```

> The `docker tag` step matters: the compose file references `ghcr.io/...`, so re-tag the mirrored
> image back to the official name; otherwise Watchtower and version bumps won't see it.
> If `ghcr.nju.edu.cn` is down, swap in `ghcr.1ms.run` / `ghcr.m.daocloud.io`, or pull
> `ghcr.io/...` directly when reachable.

### Upgrading an existing site

Refresh the compose file first (the old one defines an `upgrade` service that blocks startup),
then pull the new image and re-create the app:

```bash
cd feedlore
curl -fsSL -o docker-compose.v2.release.yml   'https://gh-proxy.org/https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml'
docker pull ghcr.nju.edu.cn/chensnails/feedlore:2.5.3
docker tag  ghcr.nju.edu.cn/chensnails/feedlore:2.5.3 ghcr.io/chensnails/feedlore:2.5.3
V2_IMAGE=ghcr.io/chensnails/feedlore:2.5.3 docker compose -f docker-compose.v2.release.yml up -d
docker logs feedlore --tail 20
```

Replace `2.5.3` with your target version. If `.env` already pins `V2_IMAGE`, edit that line instead
(drop the `V2_IMAGE=` prefix from the command) — keep both in sync.

### Finding the password

`docker logs feedlore --tail 40` shows, depending on the situation:

| Situation | What you see |
| --- | --- |
| **Fresh site** (empty DB) | `admin` is created with a random one-time password (2.5.3+ prints a `FEEDLORE FIRST RUN` banner) |
| **Existing site** | **Generation is skipped, the current password is kept**, with an "N accounts found" notice |

If you lost it (2.5.3+ images, inside the container, no network endpoint):

```bash
docker exec -it feedlore pnpm --filter @feedlore/server initial-password          # look up within 24h
docker exec -it feedlore pnpm --filter @feedlore/server initial-password --reset  # reset and print a new one
```

### Troubleshooting startup

```bash
docker compose -f docker-compose.v2.release.yml ps      # is app healthy, or restarting?
docker logs feedlore --tail 60                          # the real error
```

The first start runs schema migrations; taking 1–2 minutes to become healthy on a small box is normal.

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
