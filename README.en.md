中文：[README.md](README.md)

# FeedLore

> Gather what's worth reading — a **self-hosted RSS reader** with a resource Card Wall.
> Multi-user · no ads · no telemetry · all data in your own PostgreSQL.

**Live demo**: https://feedlore.669600.xyz (`demo` / `demo`)
Current version **2.4.3** · [Changelog](CHANGELOG.en.md) · [Upgrade & deployment](UPGRADE-v2.en.md)

## Highlights

- **Two ways to read**: expand any article in place, or browse the Card Wall where images and extracted resource links are laid out as a grid — copy links with one click, common cloud drives recognized.
- **Feeds & rules**: OPML import/export, groups, per-feed intervals and full-text fetching; keyword / regex filters, Watch / Block rules scoped to groups or channels.
- **AI digest & MCP**: a daily Chinese brief of the last 24 hours; external AI clients query feeds, full articles and digests through `/mcp` ([setup guide](docs/MCP.md)).
- **Multi-user & roles**: separate feeds, read state, stars, rules and model config per account; read-only accounts supported, public registration off by default.
- **Details that feel right**: 4 themes × 6 accent colors, adjustable type size / density / reading width; on phones, swipeable channel tabs, gesture-dismiss sheets and a bottom nav that tucks away while scrolling.
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

Docker 24+ with Compose v2 and one free port (default `3210`). No clone, no `.env` needed:

```bash
mkdir feedlore && cd feedlore
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
docker compose -f docker-compose.v2.release.yml up -d
```

The first start creates the database and may take a few minutes; check progress with
`docker compose -f docker-compose.v2.release.yml logs upgrade`.
A new site creates admin `admin` with a one-time random password printed once in the log:

```bash
docker compose -f docker-compose.v2.release.yml logs app | grep 'one-time password'
```

Open `http://<host>:3210`, sign in and change the password immediately, then add RSS / Atom feeds or import OPML under Settings → Sources.

## Configuration & upgrades

Defaults work out of the box. To change the port, run behind an HTTPS reverse proxy, reuse a database password or set the initial account, copy [`.env.example`](.env.example) to `.env` (every variable is documented) and re-run `up -d`.

- **Upgrading from 1.x**: sites with Watchtower migrate automatically and keep their passwords; manual steps, rollback and backups in [UPGRADE-v2.en.md](UPGRADE-v2.en.md).
- **Updating**: images are pinned to a version — change `V2_IMAGE` to switch; `:latest` follows Watchtower, or use the one-click update under Settings → About.

## Local development

Node ≥ 22:

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
