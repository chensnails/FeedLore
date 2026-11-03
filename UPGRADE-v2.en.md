中文：[UPGRADE-v2.md](UPGRADE-v2.md)

# Upgrading from 1.x to 2.x

2.x uses a **side-by-side upgrade**: a new database inside the same Postgres (by default
`feedlore_v2`). The 1.x database and its data volume stay **read-only** throughout, and the
migration only writes into the new database. After the upgrade you sign in with your original
username and password (they are re-hashed into the 2.x format automatically on first login).

| Your situation | What to do |
| --- | --- |
| 1.x + Watchtower (the default 1.x deployment) | **Do nothing** — wait for the automatic upgrade (see A) |
| You want a manual / step-by-step upgrade | Use `docker-compose.v2.release.yml` (see B) |
| Fresh install | The same compose file, started with zero configuration (see C); the admin is created automatically and a one-time random password is printed |

---

## A. Automatic upgrade (seamless, recommended)

The 1.x application container carries the `com.centurylinklabs.watchtower.enable=true` label, and
Watchtower checks `ghcr.io/chensnails/feedlore:latest` every 5 minutes. Once the 2.x stable release
is published, `latest` points at the 2.x image, and Watchtower will:

1. Stop the 1.x container and recreate it from the 2.x image (**environment variables, ports and
   networks are inherited unchanged**);
2. On startup, the 2.x process bootstraps automatically inside the same Postgres instance:
   - take an in-instance snapshot of the 1.x database, `<dbname>_backup`;
   - create `<dbname>_v2` and pin its database-level timezone to UTC;
   - run the schema migration → migrate the data (users/subscriptions/articles/daily reports/preferences/model keys) → verify row counts, credentials and the site master key;
   - on success, write a completion marker; every later start does a single probe and connects straight to the new database.
3. The port only starts listening once the bootstrap has finished. Sign in from the browser with
   your **original username and password**.

**How long is the wait / can I reach the site during it**: no. Watchtower stops the old container
before starting the new one, so from the moment the rebuild begins until the bootstrap ends
(usually tens of seconds to a few minutes, depending on the article count) the site is
unreachable, then it recovers on its own. Seeing `Bootstrap complete` in the container
logs means it is done:

```bash
docker logs -f feedlore        # once you see "[bootstrap] Bootstrap complete" you are done
docker logs feedlore-watchtower | tail -20
```

**You do not need to prepare anything**: no `.env` edits, no `AUTH_SECRET` / `AUTH_BASE_URL` to fill in.

- When `AUTH_SECRET` is missing it is generated automatically and saved to `feedlore_v2.settings.authSecret`; every later rebuild reads the same value;
- When `AUTH_BASE_URL` is missing, same-origin validation is done against the request's Host (login/logout will not be blocked by the Origin check).

**The image cache is not migrated**: 1.x's `image_cache` is not copied over (hundreds of thousands
of BYTEA rows — moving them is slow and wastes space); 2.x re-fetches from the origin and
re-caches on demand while you browse. If you want to move the cache too, use the manual path in B.

**Rollback** (the 1.x database was never written to):

```bash
# in the 1.x compose directory, change image from :latest to a concrete 1.x version tag, then up -d
# example: image: ghcr.io/chensnails/feedlore:1.7.4
docker compose -f docker-compose.release.yml up -d
```

> ⚠️ Do not use `:latest` to pull 1.x any more — it now belongs to 2.x. Watchtower's
> `WATCHTOWER_CLEANUP=true` removes old images, so before rolling back, confirm the 1.x version tag
> you want is still pullable (every 1.x stable release was given a version tag).

## Manual upgrade (B)

For deployments without Watchtower, or when you want to control the upgrade timing yourself.
Prerequisites: Docker Compose v2 (≥ 2.20), the ability to pull `ghcr.io/chensnails/feedlore`, and
space reserved for the 2.x database roughly equal to what the existing data volume uses.

### 1. Backup (recommended)

```bash
docker exec feedlore-db pg_dump -U "${PG_USER:-feedlore}" -d "${PG_DB:-feedlore}" -Fc \
  > "feedlore-v1-$(date +%Y%m%d-%H%M).dump"
```

Keep 1.x's `docker-compose.release.yml`: rolling back means running `up -d` with it again.

### 2. Fetch the 2.x compose file

Place it next to the 1.x compose file:

```bash
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
```

`name: feedlore` is the same as in 1.x, so it reuses the same compose project, the same
`feedlore-pgdata` volume, the same `feedlore-db` and the same port `3210`.

### 3. `.env` (mostly optional)

| Variable | Required | Notes |
| --- | --- | --- |
| `AUTH_SECRET` | No | If left empty it is generated automatically and saved to the v2 database; if set, the environment value wins (do not change it afterwards — any change invalidates every session) |
| `AUTH_BASE_URL` | No | Only set it if a reverse proxy rewrites the Host, or one site serves several domains; if empty, same-origin validation follows the request Host |
| `AUTH_TRUSTED_ORIGINS` | No | Extra origins to trust, comma-separated |
| `AUTH_SECURE_COOKIES` | No | Keep `0` on plain HTTP; set `1` behind an HTTPS reverse proxy |
| `V2_DB_NAME` | No | New database name, default `feedlore_v2` |
| `V2_IMAGE` | No | Default `ghcr.io/chensnails/feedlore:2.1.0`; set `:latest` if you want to roll with latest |
| `UPGRADE_SKIP_IMAGE_CACHE` | No | Set `1` to skip copying the image cache (v2 re-fetches from the origin on demand) |
| `UPGRADE_SKIP_BACKUP` | No | Bootstrap path only: set `1` to skip the `<dbname>_backup` snapshot |
| `ADMIN_USER` / `ADMIN_PASS` | No | Initial admin for the first start of an empty site; if no password is given, a one-time random password is generated (appears once, in the startup log only) |

`PG_PASSWORD`, `WATCHTOWER_HTTP_API_TOKEN`, `ALLOW_PRIVATE_HOSTS` and `TRUST_PROXY` carry over from 1.x.

### 4. Run it

```bash
docker compose -f docker-compose.v2.release.yml up -d
docker compose -f docker-compose.v2.release.yml logs -f upgrade
```

1. The `db` health check passes (the existing Postgres container is not recreated).
2. The `upgrade` one-shot service: create `feedlore_v2` (database-level timezone pinned to UTC) → create tables → migrate data (including the image cache) → verify → write the completion marker.
3. Only after `upgrade` exits with code 0 does `app` replace the 1.x application container.

**1.x stays online during all of this**; the only downtime is the few seconds it takes to recreate
the application container at the end. The success log reads
`Upgrade complete: v2 data is ready, the app container can start`; on a fresh install it prints
`treating it as a fresh install, skipping the data migration`.

### 5. Verification

- Sign in with your **original 1.x username and password**.
- Subscription and article counts match 1.x; open an article with images and confirm they display.
- Change the fetch interval on the settings page and confirm it saves; open "About" and confirm the version number matches the image.

## C. Fresh install

The same compose file also installs from scratch, with **zero configuration**: no `.env`, no
variables to fill in, no manually created admin.

```bash
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
docker compose -f docker-compose.v2.release.yml up -d
```

When `upgrade` finds no 1.x data it skips migration and only creates the tables; after the
application starts, if the site has no accounts at all it automatically creates the initial admin
`admin` and generates a one-time random password, **printed exactly once in that start's log**:

```bash
docker compose -f docker-compose.v2.release.yml logs app | grep 'one-time password'
```

Right after signing in, go to "Settings → Account" and change the password. To choose your own
initial credentials, set `ADMIN_USER` / `ADMIN_PASS` before the first start.

The default database password is `feedlore` and the default update token is `feedlore-update`; both
are used only inside the container network. On a shared host, or when other containers share the
same network, override them in `.env` (see `.env.example`).

## After the upgrade

- **Updates**: `latest` is a rolling channel — Watchtower's automatic upgrade keeps working as
  before, and "Settings → About → one-click update" can trigger it immediately too. To pin a
  version, set `V2_IMAGE` to `ghcr.io/chensnails/feedlore:<version>`.
- **The backup target has changed**: from now on back up the new database
  `docker exec feedlore-db pg_dump -U "${PG_USER:-feedlore}" -d "${V2_DB_NAME:-feedlore_v2}" -Fc > feedlore-v2.dump`.
- **Do not change the timezone**: 2.x stores time in UTC end to end (the database-level timezone is
  already set to UTC). Setting `TZ` back to `Asia/Shanghai` shifts every newly written time by 8
  hours as a whole (an injected old environment variable is force-corrected by the startup
  bootstrap, but do not rely on that).
- **Re-running is safe**: the 2.x migration is idempotent; a further `up -d` only re-runs the schema
  migration and never copies data twice.
- **The 1.x database is kept indefinitely**: it takes up space but guarantees a way back. Delete it
  manually only once you are sure you no longer need it (irreversible):
  ```bash
  docker exec feedlore-db psql -U "${PG_USER:-feedlore}" -d postgres -c 'DROP DATABASE "${PG_DB:-feedlore}";'
  ```

## FAQ

| Symptom | Cause and fix |
| --- | --- |
| Site unreachable after the automatic upgrade | The bootstrap is still running (a large database takes a few minutes) — `docker logs -f feedlore` and wait for `Bootstrap complete`; if the container keeps restarting, the log gives the concrete failure reason |
| Straight after login you are back to signed out / 403 | A reverse proxy rewrote the Host: add `AUTH_BASE_URL`; or under HTTPS `AUTH_SECURE_COOKIES=1` was not set, or it was set to `1` on plain HTTP |
| `upgrade` exits with a failure | Check the reason with `logs upgrade`. On failure `app` does not start and 1.x keeps serving; fix it and run `up -d` again (idempotent) |
| Permission error when creating the database | The database user needs the `CREATEDB` privilege (the `feedlore` user in the official image has it); for an externally hosted database, create it manually first, or point at the target database with `V2_DATABASE_URL` |
| Snapshot creation failed (⚠️ in the log) | Another connection was holding the 1.x database during migration; the migration itself is read-only and unaffected, but take your own `pg_dump` backup |
| `upgrade` seems stuck on the image cache | Normal when there are many images; set `UPGRADE_SKIP_IMAGE_CACHE=1` and run `up -d` again |
| The 1.x database cannot be found | If you changed the container name / port / database name in 1.x, update `container_name` in the `db` section of the 2.x compose file, plus `PG_*` and `HOST_PORT` in `.env`, to match |
| Want to start over | Drop the new database and run `up -d` again: `docker exec feedlore-db psql -U "${PG_USER:-feedlore}" -d postgres -c 'DROP DATABASE "${V2_DB_NAME:-feedlore_v2}";'` (this discards the new data written after the switch) |
