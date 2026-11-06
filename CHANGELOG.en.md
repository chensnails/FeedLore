中文：[CHANGELOG.md](CHANGELOG.md)

# Changelog

This file records user-visible changes and deployment-related changes for 2.x.

- The full 1.x history lives in tag [v1.7.4](https://github.com/chensnails/FeedLore/tree/v1.7.4) and the corresponding GitHub Releases.
- The upgrade steps from 1.x are in [UPGRADE-v2.en.md](UPGRADE-v2.en.md).

## Unreleased

### Added

- **Article density (compact by default)**: 外观 → 界面 gains an 文章密度 row next to 卡片密度,
  with the same two positions, and both now default to compact. 紧凑 shows the title plus source
  and time (one line on desktop; at ≤720px phones relax it into two lines, title above and
  source/time below) and loads neither thumbnail nor summary; 舒适 adds two lines of the captured
  summary and a thumbnail on the right. The expanded entry keeps its full title. Device-local like
  the rest of appearance.
- **Grouped appearance settings**: the appearance pane is now split into 主题与配色 / 界面 /
  正文阅读, so the growing list of options stays scannable.
- **Rounded card rows are back in the article list**: every entry is an independent card again —
  panel background, hairline border, light shadow, 12px radius, and 12px between cards. The unread
  dot and the leading chevron return (the chevron rotates 90° when expanded), and the expanded
  article body stays inside its card. Density still lets hundreds of headlines be scanned quickly;
  it is just no longer a borderless news feed.
- **Horizontally scrolling channel strip on phones**: at ≤720px the article page and the card page
  get a swipeable channel strip under the header (article: 全部 / 未读 / 收藏 / 关注 + channels;
  cards: 全部 + channels). One tap reaches a top-level channel, the active tab carries a short
  centered underline, and the trailing icon still opens the full drawer with groups and unread
  counts. Desktops keep the permanent sidebar, and both read the same filter state.
- **Floating pill tab bar and a back-to-top button**: the phone tab bar now floats over the content
  as a rounded pill with gutters on both sides instead of a full-width band; a back-to-top button
  appears in the lower-right after one screen of scrolling, above the bar and below the drawer mask,
  and scrolls back smoothly.
- **Card page visual alignment**: cards and list rows use a thin border with a light shadow and a
  12px radius, rows tint on hover instead of sliding sideways, and favorite / mark-unread buttons on
  rows with an image sit on a translucent scrim so they stay legible over photos.
- **Bottom view tab bar on phones**: at ≤720px the 文章 / 卡片 / 日报 switcher moves from the
  header cluster to a fixed bar at the bottom of the screen, where a thumb can reach it; the
  header copy hides at the same time so there is never one nav above and below. Channel drawer,
  modals and the command palette cover the bar instead of fighting it for layers. The bar grows
  by the safe-area inset on notched devices, and all three view containers reserve that same
  height so the last item is never hidden.
- **Views remember where you left them**: switching away and back with the view navigation lands
  on the row you were reading; tapping the current view's icon scrolls smoothly back to the top.
  Changing a filter, opening a deep link or jumping from the command palette still goes to the
  top — an old offset belongs to an old list. The memory lives in RAM only, so a reload starts at
  the top.
- **Slimmer card actions on narrow screens**: at ≤560px cards and list rows keep only
  「复制链接」, shrunk to a 36px square; 「打开原文」 moves to the card detail (the card itself
  already opens it), so the title and image become the subject again.

### Changed

- **Slimmer phone tab bar**: the bottom bar drops from 56px to 48px, its bottom offset from 8px to
  6px, and its side gutters widen from 12px to 16px — 54px of screen instead of 64px. Icons go
  20→18 and labels 11→10, while buttons stay 44×44 for touch (only the frame shrinks). Toasts,
  the back-to-top button and all three scroll containers derive their bottom spacing from
  `--tabbar-h`, so they follow automatically.
- **Stronger neumorphic glass on floating layers**: modal and command-palette masks now blur 16px
  (theme token) with 1.4 saturation — still the only backdrop-filter declarations — while the tab
  bar, channel drawer, back-to-top button and new-content pill get a near/far dual shadow plus a
  1px top highlight. No backdrop-filter is added to persistent fixed surfaces.
- **Unified elevation across the three views**: article rows drop from `--elevation-2` to
  `--elevation-1`, matching cards and list rows, and lift to 2 on hover; digest cards keep their
  neumorphic surface because they are a few large reading blocks rather than a long list.
- **Re-tapping the active channel scrolls to top**: same behaviour as the bottom view bar. The
  filter is unchanged, so the list is not re-rendered — only the viewport returns to the top.

### Fixed

- **A dark-theme install no longer ships a light shell**: the host (WebAPK) takes its system-bar
  colors from the manifest, which page CSS cannot touch and which is only read at install time.
  There is now a second `manifest-dark.json` (`theme_color` / `background_color` both `#242424`),
  and the head script plus `applyTheme()` switch `<link rel="manifest">` by app theme, so dark and
  GitHub installs point at the dark manifest and the splash screen no longer flashes light. An
  icon already on the home screen must be removed and re-added to pick up the new manifest. On
  Android Chrome's WebAPK the bottom navigation bar does follow the manifest color (verified on a
  real device); that color is still decided by the host/vendor, not something a web page can force.
- **The status bar no longer sits a shade away from the page top**: `theme-color` used to report
  the panel color (dark `#2e2e2e`) while the page top actually paints the page background `--bg`
  (`#242424`), so hosts that honor the meta showed the status bar and header as two different
  blacks. The app and the login page now report `--bg` for all three themes, read from the
  computed CSS value at runtime so there is a single source of truth; the manifest `theme_color`
  follows to light `#f4f5f7` (what shows under the floating bar is the page background too).
  Added `<meta name="color-scheme" content="light dark">` so the canvas and scrollbars follow the
  system preference before the stylesheet arrives, with no white flash on dark systems.
- **List action buttons no longer sit on top of titles or sources on phones**: after the star and
  mark-unread hit areas grew to 44×44, the right-side reservation still assumed 30px buttons, so
  long source names slipped underneath. Compact two-line cards now reserve the width for the whole
  text column; on read entries the two actions stack vertically, turning the 106px horizontal pair
  back into a 44px column, so source and time return to one line (rows drop from about 128px to
  100px). Comfortable read rows without a thumbnail and compact single-line rows on coarse-pointer
  tablets got the same wider reservation.
- **No more "loading took too long" when the site opens in a background tab**: the boot layer
  only listened for a rendered frame, and browsers do not produce frames for hidden pages, so
  the 12-second watchdog reported "you have not switched to this tab yet" as a load failure.
  It now takes whichever arrives first, frame or timer; the first-paint theme and view mode
  got the same fallback, so a tab opened in the background no longer re-themes when you reach it.
- **The blue strip under the tab bar in "Add to Home Screen"**: the manifest still carried the
  v1-era brand `theme_color`, which the host browser uses to fill the home-indicator strip, so a
  band unrelated to the page appeared below the bar. It is now the same white as the toolbar;
  the login page also gained `viewport-fit=cover` so both pages share one safe-area story.
- **No white flash on dark systems at first paint**: `theme-color` had only the white fallback,
  so the status bar and browser bar were white until JavaScript ran. There is now one fallback
  per color scheme via `media`, and the inline first-paint script rewrites it when light / dark /
  GitHub was chosen explicitly, so the color is right before any script has finished loading.
- **Favorited articles no longer carry a left accent bar**: in the full-width row list that bar
  read as "currently selected" or "unread". Favorites are now marked only by the gold star. The
  card page keeps its marker, where the bar is the only favorite signal.

### Security

- **A hard floor on the Node runtime inside the image**: CI now reads
  `process.versions.node` from the built image and fails the build below `22.23.4`.
  That is the October 21, 2026 Node security release, which fixed 10 issues including
  TLS certificate hostname-verification bypasses and `dns.resolve` hostname truncation —
  exactly the behaviour our server-side SSRF guard relies on. `engines.node` in
  `package.json` now requires `>=22.23.4` as well.
- **Self-hosters, note**: we ship prebuilt images, so the base image digest behind a tag
  like `ghcr.io/…:2.3.0` is frozen at push time — an upstream patch to `node:22-slim` never
  reaches an existing tag. Node has pre-announced another security release for the
  22 / 24 / 26 lines on or shortly after November 11, 2026. When it lands we will raise the
  floor and publish a new version; then point `V2_IMAGE` at it and run `up -d`.

## 2.3.0 — 2026-11-04

### Added

- **Data export in Settings → Account**: downloads the account's feeds, articles (with read /
  favorite / watch marks), digests and preferences as a streaming tar.gz. Login sessions,
  image cache and full-text cache are excluded; the model API key is included only when opted
  in, and the UI warns that it is written in plaintext. Read-only accounts can still export
  their own data.
- **Site backup for admins**: Settings → Account gains a site-wide backup entry, protected by a
  danger confirmation. It contains every account (including password hashes), feeds, settings
  and image cache, and is labelled as a sensitive file. Only one backup may run at a time.
- **Account import**: upload an account export to merge it back. Feeds, articles, digests and
  preferences only fill in missing rows; existing articles are never overwritten and their
  read / favorite / watch state stays as it is. Repeating an import is safe. A model config in
  the archive is applied only when the account has none yet, with the API key re-encrypted
  using this instance's master secret; existing config is kept and an internal model URL is
  skipped, each with its own explanation in the result message.
- **Site restore for admins**: upload a site backup, confirm twice, and the archive replaces
  the whole site (wipe first, then write; not reversible). All login sessions are invalidated,
  so everyone signs in again. It is mutually exclusive with account import and backup.
- **Wrong import entry now points you to the right one**: uploading an account export to site
  restore (or the reverse) name exactly which kind of archive it is and where to upload it,
  instead of a generic "invalid package" error.
- **Login devices in Settings → Account**: lists the account's active sessions (browser / OS,
  IP, last active) with a "this device" badge; revoke one device or all others. Session tokens
  are never sent to the frontend.
- **Unified settings structure and visuals**: collapsible sections, inline results and footer
  action bars now use shared primitives; the desktop nav marks the active pane with a primary
  color bar.

### Changed

- **Appearance scope is explicit**: appearance is stored on this device only; layout (view,
  sort, sidebar width…) still follows the account.

### Fixed

- **Site backups with image cache variants could not be restored**: the image proxy caches
  `:w320` / `:w640` / `:w960` width variants, but the extraction allowlist accepted only
  alphanumerics and `._-`, rejecting `images/<hash>:w640` as an unexpected entry and failing
  the whole archive. Site restore now covers the backup fully, including every width variant.

### Notes

- Account import merges only; site restore replaces everything and clears sessions. Download a
  fresh site backup before restoring if you may need to go back.

### Deployment

- Image: `ghcr.io/chensnails/feedlore:2.3.0` (amd64 + arm64); `latest` points at the same
  digest.
- **Upgrading from 2.2.x**: change `V2_IMAGE` to `…:2.3.0` and run `up -d`. There is no
  database change, and the new export / backup / import / restore endpoints need no extra
  configuration.

## 2.2.1 — 2026-11-04

### Fixed

- **Card action buttons on mobile now use a solid dark background**: 2.2.0's translucent
  glass background exceeded the build check's blur budget (reserved for the two full-screen
  masks), and a dozen live blur layers in the long scrolling card grid also cost frames. The
  buttons now use a denser shade of the same tone; the white icons, outline and 40×40 touch
  target are unchanged, and the visual quieting is the same.

### Deployment

- Image: `ghcr.io/chensnails/feedlore:2.2.1` (amd64 + arm64); `latest` points at the same
  digest.
- **Upgrading from 2.2.0 or any 2.2.0-rc**: change `V2_IMAGE` to `…:2.2.1` and run `up -d`.
  There is no database or API change.

## 2.2.0 — 2026-11-04

### Added

- **Read state is synced between the article and card views**: expanding an article,
  opening a card detail or marking an item unread on either page immediately updates the
  other page's list, dots and counts — no refresh or reload needed.
- **Unread dots on the card view**: on the image's top-left corner for media cards, in the
  metadata row for text cards, and on the thumbnail in list view. Read items only hide the
  dot and do not dim the card; screen readers announce "unread".
- **Card view channel / group / all-channels counts now show unread**: same meaning as the
  article view; a fully read group shows a check mark, a collapsed group reports its channel
  count, and totals stay in the hover title.

### Changed

- **Lighter first load**: the settings modal and the AI digest view are downloaded only when
  first opened; the session check and channel list now start in parallel, and only the list
  needed by the current page is fetched (the card list used to be preloaded on every start).
- **Responsive images**: card covers, list / digest thumbnails and article images now use
  320 / 640 / 960 width variants, cutting bytes on phones and slow links. The image proxy
  accepts an optional `w` parameter, compresses and caches each variant separately, and keeps
  the default 1280 version unchanged.
- **Appearance now lives in the browser**: theme / accent / UI font size / card density /
  article typography are no longer stored in the account. A new device, a different account
  or a cleared cache falls back to the defaults (all size-related options are "medium");
  every account on the same browser shares the same appearance. Layout (view / sort /
  sidebar width / collapsed groups) still follows the account and syncs across devices.
- **Reader font size now has five levels**: tiny / small / medium / large / extra large
  (14 / 15 / 16 / 18 / 20px). Existing small / medium / large selections keep their values,
  no migration needed.
- **"Font size" renamed to "UI font size"** to distinguish it from "Reader font size": the
  former scales the whole site proportionally (including the article body), the latter
  affects only the article body.
- **Quieter card actions on mobile**: copy / open on media cards now use a translucent dark
  background, and text cards use outlined icon buttons; the 40×40 touch target and the click
  path are unchanged.
- **Server logs and API errors now speak English**: server logs, startup and migration output
  and script output are all English; API errors now carry a stable machine-readable code plus
  an English description:
  - `error` is now a code such as `E_BAD_CREDENTIALS` instead of Chinese prose, and a
    published code is never renamed;
  - new `message` (English text), `status` (HTTP status code) and optional `params`
    (interpolation values); the code table lives in `packages/contract/src/errors.ts`;
  - the front end maps codes to Chinese through `apps/web/src/core/errorText.js`, so the UI
    reads exactly as in 2.1.0; the login page's failure message uses the same dictionary.
- **README intro rewritten**: the positioning now follows the actual "personal reading +
  cloud-drive resources" use case, while configuration stays in `.env.example`. English docs
  (`README.en.md`, `CHANGELOG.en.md`, `UPGRADE-v2.en.md`) mirror the Chinese documents.

### Fixed

- **Reader font size had no effect on mobile**: the ≤720px media query forced the body to
  the UI font size and overrode the appearance setting; the override is gone, so phones now
  follow "Reader font size".
- **"Reading width" is no longer clickable on narrow screens**: the row is disabled with
  the note "fills the width on narrow screens, adjustable on desktop" — all four presets
  were wider than a phone, so the control changed nothing before.
- After "mark all as read", the card list is fetched once more so dots and counts stay in sync.
- "No releases published on GitHub yet" now returns `502 E_UPDATE_NO_RELEASE` instead of an
  unclassified 500.

### Deployment

- Image: `ghcr.io/chensnails/feedlore:2.2.0` (amd64 + arm64); `latest` points at the same
  digest and a GitHub Release is created.
- **Upgrading from 2.1.0 / 2.0.x or any 2.2.0-rc**: change `V2_IMAGE` to `…:2.2.0` and run
  `up -d`. There is no database structure change and the startup migration still runs
  idempotently; legacy `prefs.appearance` data stays in the database but is no longer read.
- **API compatibility**: `GET /api/prefs` and `POST /api/prefs` no longer include the
  `appearance` field; error responses now carry a code plus `message` / `status` / `params`
  instead of Chinese `error` prose. Third-party clients should branch on the `error` code, or
  fall back to the English `message`.

## 2.1.0 — 2026-11-03

### Added

- **Rules can be scoped**: Watch / Block rules and the pre-ingest filter both support
  narrowing by group / channel. New rules select nothing by default (so they do not
  take effect), to avoid hitting every channel by mistake; existing rules keep applying
  to all channels. Checking a group follows the channels added to it later, while
  checking a single channel is unaffected by group changes.
- **Watch auto-expiry**: `Settings → Rules` adds "watch retention days" (default 90
  days, 0 = keep forever). On expiry only the Watch flag is cleared — the articles stay
  in their original channel, and read / favorite state and the Block flag are untouched.
- **Group reading on the Card Wall**: the channel bar and the group rows of the desktop
  channel dropdown both gain a "this group only" funnel, with the same interaction as the
  Article view (click again to cancel, the group expands automatically); the title and
  the filter show the current group, and an empty group offers a way back to all channels.
- **Entry filtering moved into the rules panel**: the pre-ingest filter moved from
  `Account` to `Settings → Rules`, placed next to the Watch / Block rules, and the action
  wording is unified as "discard / keep only".
- **Brand splash layer**: the first frame of a cold start shows the themed brand screen
  directly and fades out once the first view has rendered; a failed start shows the error
  and a reload entry in place, cutting several seconds of white screen.
- **Sidebar counters use k / w units**: article and group counts over 1k show `1.2k` and
  over 1w (10,000) show `1.5w` — no hard cap and no `+`; channel counts are compressed by
  the same rule.

### Changed

- **License changed to GPL-3.0**: from this version the project is released under
  GNU GPL v3.0; previously released versions (2.0.7 and earlier) remain under MIT and
  rights already granted are unaffected.
- **Switching in the Article view no longer flashes `暂无内容` ("No content yet")**:
  switching channel / group / scope now clears the list before requesting, and the empty
  state (including `加载失败 · 重试` — "Load failed · Retry") only shows once that request
  lands empty; while loading only the loading indicator is shown.
- **Read-only account permissions tightened**: a read-only account keeps only reading
  ability — browsing channels and entries, search, marking read, favoriting, plus reading
  preferences such as appearance / layout / group order. Feed create / update / delete and
  refresh, filters and Watch rules, webhooks, models and daily-report generation are all
  rejected server-side (403), and the UI no longer shows the corresponding entry points.
- **Regular users and admins aligned**: apart from site-level settings and user
  management, which stay admin-only, regular users can manage their own feeds, rules,
  models and daily reports, and can change their own username and password.
- **Rules panel wording unified**: "virtual group" is now called "smart group"; the Block
  of Watch / Block and the "discard" of the pre-ingest filter are worded separately; the
  keyword hint now states that it matches title, summary and body.
- **Settings panel control styling unified**: inputs, textareas and selects share height,
  corner radius, background and focus ring.
- **Unread / favorite scope temporarily ignored when entering Watch**: leaving Watch
  restores the previous filter, so the Watch view is not filtered down to an empty list by
  an outer condition.

### Fixed

- The scroll sentinel's geometry is zeroed while the Card Wall is hidden, so it no longer
  pages through the whole list in the background; under the Watch / Block views the
  "All articles" scope row works again and two rows are no longer highlighted at once.
- Added closing dropdowns on focus loss, plus focus traps and keyboard reachability for
  confirm dialogs, the command palette and the lightbox.
- Mobile search expansion moves onto a second row instead of pushing the toolbar off
  screen; iOS no longer zooms the whole page on focus.
- The reading page header now shrinks to fit its own width, so `⋮` is no longer pushed off
  screen at medium widths; when all three actions are present only the icons remain.
- Watch rule keywords submitted as multi-line text no longer return 400.
- A self-service password change now keeps the current device's session and only revokes
  sessions on other devices.

### Security

- **CSRF protection**: all business write endpoints (POST / PATCH / DELETE) now require
  the Origin or Referer to belong to this site; a missing one or a foreign site is always
  403. The session cookie's SameSite is tightened from None to Lax, so browsers no longer
  carry the login state on cross-site POSTs.
- **Open redirect on login**: the login page's `next` parameter only accepts in-site
  paths; `//evil.com`, `/\evil.com` and cross-origin absolute URLs all fall back to the
  home page.
- **Login rate limiting**: `/api/login` is limited to 10 attempts per minute per client
  IP; over the limit returns 429 with `Retry-After`. better-auth's own login endpoints are
  no longer exposed directly, so they cannot be used to bypass the limiter. When deploying
  behind a reverse proxy, set `TRUST_PROXY=1` for the real IP to be taken from
  `X-Forwarded-For` / `X-Real-IP`.
- **Initial password is no longer fixed**: on the first start of an empty site, if
  `ADMIN_PASS` is not set, a one-time random password is generated and printed once in
  that start's log; `admin/admin` is no longer created by default.
- **Password change revokes sessions**: after an admin resets a user's password or adjusts
  their role, that user's existing login sessions are invalidated immediately; a
  self-service password change also revokes sessions on other devices.
- **Security headers**: pages now ship CSP (scripts allowed per-request nonce),
  `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy` and `Permissions-Policy`; under HTTPS also HSTS and
  `Cross-Origin-Opener-Policy`. Authenticated endpoints uniformly return
  `Cache-Control: no-store`, while the image proxy keeps its own long-cache policy.
- **ReDoS protection for regex filters**: saving filter / Watch rules rejects
  high-backtracking-risk regexes, and dangerous legacy rules are skipped outright at match
  time; a single text matches only against its first 8000 characters.
- **Dependency upgrades**: `drizzle-orm`, `zod` and `@hono/node-server` upgraded to fixed
  versions.

### Deployment

- Image: `ghcr.io/chensnails/feedlore:2.1.0` (amd64 + arm64); `latest` points at the same
  digest.
- **Upgrading from 2.0.x**: update the image and restart. There is no database structure
  change in this release, and the startup structure migration still runs idempotently as
  usual.
- From 2.1.0 the project is released under GPL-3.0; 2.0.7 and earlier remain under MIT.

## 2.0.7 — 2026-11-02

### Added

- **Read-only account**: `Account → User management` adds the "read-only" role. A
  read-only account can browse channels, entries, search and the AI daily report just like
  a regular user, but cannot change its own username or password — in the account panel
  the username is read-only and the password-change section is not shown.
- Admins can still reset a read-only account's password, or move it between regular /
  read-only / admin.

### Security

- A read-only account requesting `/api/account` directly, or bypassing the UI to call
  better-auth's `update-user`, `change-password`, `change-email` or the password-reset
  endpoints, always returns 403.

### Deployment

- Image: `ghcr.io/chensnails/feedlore:2.0.7` (amd64 + arm64); `latest` points at the same
  digest.
- **Upgrading from 2.0.6**: update the image and restart. There is no database structure
  change in this release, and the startup structure migration still runs idempotently as
  usual.

## 2.0.6 — 2026-11-02

### Fixed

- **Page reports `加载失败：服务器内部错误` ("Load failed: internal server error") after
  upgrading to 2.0.5**: 2.0.5 introduced the `entries.body_version` column plus
  `feeds.full_text` and `article_cache`, but only `docker compose up` runs the `upgrade`
  service defined in compose; Watchtower, the one-click update on the settings page and
  `up -d --no-deps app` only recreate the app container, leaving the database on the old
  structure.
- v2 sites (including 1.x sites that were already upgraded) now **run the structure
  migration again on every start**. The migration is idempotent, and when the structure is
  already current it only adds a few seconds to startup.

### Deployment

- Image: `ghcr.io/chensnails/feedlore:2.0.6` (amd64 + arm64); `latest` points at the same
  digest.
- **Upgrading from 2.0.5**: update the image and restart; the startup automatically fills
  in the missing columns and tables, so the manual
  `docker exec feedlore pnpm --filter @feedlore/db migrate` is no longer needed.
- If the database account has no create/alter-table permission (common on externally
  hosted databases), the startup log reports `结构迁移失败` ("Structure migration failed")
  and you must run `pnpm --filter @feedlore/db migrate` with a privileged account, then
  restart. A failed migration does not block application startup.

## 2.0.5 — 2026-11-02

### Added

- **Structured article body (`bodyVersion`) — bodies laid out like the original post**: the
  reading page no longer treats the whole body as plain text; headings, lists, quotes, code
  blocks, images and links render according to the source structure. Existing entries stay
  as they are and upgrade automatically after a refresh.
- **Tables and figure captions**: `<table>` renders as header / data rows and can be
  scrolled sideways on narrow screens; `<figure>` keeps the image together with its
  caption, and images all go through this site's proxy.
- **Per-channel full-text fetching**: summary-only feeds can enable it per channel under
  `Settings → Sources`. The original page is fetched and the complete body and images
  extracted; results are cached for 7 days and cleaned automatically after 30 days; when
  extraction fails, or the content is not longer than the feed body, the original is kept.
  Original-page fetching reuses the egress check of feed fetching, and internal network
  addresses are always refused.

### Fixed

- Relative links and images in bodies are resolved against the entry's landing page, so
  unclickable relative paths no longer appear.

### Deployment

- Image: `ghcr.io/chensnails/feedlore:2.0.5` (amd64 + arm64); `latest` points at the same
  digest.
- **This release includes a database migration** (the `feeds.full_text` column, the
  `article_cache` table):
  - The `upgrade` service of the release compose runs the migration; the first 1.x upgrade
    runs it via startup bootstrap.
  - When only the app is recreated (`docker compose up -d --no-deps app`), run
    `docker exec feedlore pnpm --filter @feedlore/db migrate` manually.
- Existing entries keep their v1 plain-text bodies; only entries freshly fetched after
  refreshing that channel use the v2 structured layout.

## 2.0.4 — 2026-11-01

### Changed

- **Cards are no longer tall and thin on narrow screens**: at ≤720px the card height is
  uniformly capped at 15.75rem (252px at the default 16px, about 1.5× the card width) and
  the image area at 7.75rem; at ≤360px small screens it drops another notch (236px), and
  text-card summaries show 4 lines.
- Card height and image max-height now use rem, so they scale with
  `Settings → Appearance → Font size`. They used px, so choosing the "Large" font size
  grew the text while the card stayed the same size and the last summary line was cut off.

### Fixed

- **Cards with an image but no summary**: the remaining height is given to the image, so
  the body no longer shows a single title line with an empty block underneath.
- **Touch action buttons**: the copy / open buttons at the bottom of text cards are raised
  to 40px, matching the size of the overlay buttons on images.

### Deployment

- Image: `ghcr.io/chensnails/feedlore:2.0.4` (amd64 + arm64); `latest` points at the same
  digest.
- Already-deployed sites: change `V2_IMAGE` in `.env` to `…:2.0.4`, then `up -d`; this
  release only changes the frontend, no data migration needed.
- Watchtower in the release compose already sets `WATCHTOWER_CLEANUP=true`: after rolling
  up on `latest` it deletes the previous image automatically instead of holding onto it on
  disk.

## 2.0.3 — 2026-11-01

### Changed

- **Uniform card height**: every card in the grid now has the same height, with a capped
  image area and a fixed two-line title; text-only cards use the space they save to show a
  few more summary lines. Rows are no longer stretched to the tallest card, so the Card
  Wall reads as a single horizontal line.
- Skeleton cards use the same card height, so the placeholder height no longer jumps
  between loading and loaded.

### Fixed

- **Bad image fallback**: when an image fails to load twice in a row the media area is
  dropped and the source row and the bottom action buttons are restored, instead of leaving
  a blank grey block that pushes the whole row taller.
- **Sidebar counts not updated after auto-refresh**: once a refresh finishes, the reading
  page sidebar is refreshed again in addition to the list, so unread counts and channel
  badges no longer stay on stale values.
- **Scroll position detection**: under the App Shell `window.scrollY` is always 0, so the
  "is at the top" check for auto-refresh, returning to top from the new-entries pill, and
  returning to top on view switch now read the scroll container of the current view.
- **Pagination failures**: instead of flashing a single toast and stopping, the bottom of
  the list now keeps an error and a "Retry" button visible, and scroll auto-loading is
  paused to avoid repeated failing requests.

### Added

- **Empty and error states point somewhere**: an empty list, no search results and a failed
  load each offer a clickable next step (retry / add a feed / clear search / clear the tag).
- **Search feedback**: the number of hits is shown, the search box has an instant clear
  button, and `/` focuses search again; search from the command palette can be turned into
  a full-text search in one click.
- **Mark as unread**: the reading page can mark a read article as unread again.
- **End-of-list notice**: `没有更多了` ("No more items") shows when the list scrolls to the
  bottom.

### Accessibility & mobile

- Mobile bottom actions and icon buttons have their hit areas enlarged to an easily
  tappable size.
- The card detail dialog gained a focus ring and a focus trap, so keyboard focus no longer
  escapes the dialog.

### Deployment

- Image: `ghcr.io/chensnails/feedlore:2.0.3` (amd64 + arm64); `latest` points at the same
  digest.
- Already-deployed sites: change `V2_IMAGE` in `.env` to `…:2.0.3`, then `up -d`; this
  release only changes the frontend, no data migration needed.

## 2.0.2 — 2026-10-31

### Added

- **Genuinely works out of the box**: a fresh install needs no `.env` and no variables or
  passwords filled in. After `docker compose -f docker-compose.v2.release.yml up -d` the
  site is usable right away.
- **Empty site creates the initial admin**: when v2 starts and there is not a single
  account, it automatically creates `admin / admin` (overridable with `ADMIN_USER` /
  `ADMIN_PASS`). Sites that already have accounts are unaffected.
- The 1.x migration path benefits the same way: when the source database has no accounts,
  the app adds an `admin / admin` after startup, so a manual seed is no longer required.

### Changed

- compose defaults are now self-contained inside the containers:
  `PG_PASSWORD=feedlore`, `WATCHTOWER_HTTP_API_TOKEN=feedlore-update` (both are used only
  on the Docker internal network, and their ports are not mapped to the host). When
  upgrading an existing 1.x site you must still keep the original `PG_PASSWORD`.
- `.env.example` changed from a "required template" to "optional overrides".

### Security note

- The default password `admin` is only fit for the first login on an internal network;
  after deploying, change it immediately under `Settings → Account`. For instances exposed
  to the public internet, set a strong password with `ADMIN_PASS`, or change the password
  as the very first thing after logging in.

### Deployment

- Image: `ghcr.io/chensnails/feedlore:2.0.2` (amd64 + arm64); `latest` points at the same
  digest.
- Already-deployed sites: change `V2_IMAGE` in `.env` to `…:2.0.2`, then `up -d` (or roll
  on `latest`); the structure is unchanged, so no re-migration of data.

## 2.0.1 — 2026-10-31

### Added

- **Zero-config upgrade from 1.x**: when a 2.x container starts and finds a 1.x database
  structure, it automatically snapshots `<db name>_backup`, creates `<db name>_v2`
  (database-level UTC), runs the structure migration and the data migration, and validates
  row counts, credentials and the site master key; on success it writes a completion marker
  and later starts only do a single probe. A 1.x site running Watchtower needs no
  configuration change at all.
- **Manual / controlled upgrade**: the one-off `upgrade` service in
  `docker-compose.v2.release.yml` migrates first and only replaces the app container after
  success; the same path applies to fresh installs.
- **Zero-config auth**: when `AUTH_SECRET` is not set it is generated automatically and
  persisted to `settings.authSecret`; `AUTH_BASE_URL` may be left empty and same-origin is
  checked against the request Host (works for both login and logout).
- The release channel moved back to `ghcr.io/chensnails/feedlore`: stable releases push
  both the version tag and `latest`, and create a GitHub Release.

### Changed

- The frontend reverted wholesale to the 1.x interface and interactions (three views, group
  collapse, card detail, channel drawer, PWA); the server, the contract and the deployment
  chain are unchanged.
- The repository converged onto a single `main` line: `apps/legacy`, the old v2 compose and
  the one-off ops scripts were removed; 1.x sources and compose are kept only in tag
  `v1.7.4`.
- CI now runs only on `main` (typecheck, unit tests, real-database integration, frontend
  build and artifact checks, amd64/arm64 image builds).
- The single source of truth for the version moved to the root `package.json` (the
  `VERSION` file is gone); `release.yml` rejects 1.x tags.
- Public documentation is reduced to the repo-root `README.md`, `CHANGELOG.md`,
  `UPGRADE-v2.md`, `LICENSE`.

### Fixed

- Lossless 1.x password migration: the original scrypt hash is written into 2.x as
  `legacy$<salt>$<hash>`, and after the first successful login it is automatically rewritten
  as a better-auth hash, so users do not need to reset their password.
- Username rules aligned with 1.x: `-` and `@` allowed, case preserved, length 1–40.
- Time columns are no longer shifted by 8 hours after migration (the migration container,
  the server and the database are all `TZ=UTC`).

### Deployment

- Image: `ghcr.io/chensnails/feedlore:2.0.1` (amd64 + arm64); `latest` points at the same
  digest.
- The default compose pins the version tag; for rolling upgrades set `V2_IMAGE` to
  `…:latest`.
- Rollback: bring the stack back up with 1.x's `docker-compose.release.yml` (the 1.x
  database and volumes were never written to).

## 2.0.0 — 2026-10-31

The 2.x rewrite debut (including the pre-release `2.0.0-v2`).

- The monolithic app rewritten as a pnpm monorepo:
  - `apps/server`: Hono + better-auth + Drizzle ORM, PostgreSQL 18;
  - `apps/web`: React + Vite (PWA);
  - `packages/contract` / `db` / `auth` / `ai` / `client`: the single source of truth for
    endpoints and DTOs, the database structure and migrations, auth, model calls and the
    daily report, and a type-safe client.
- The contract is validated at runtime on the server (400 for requests / 500 for
  responses), so a frontend / backend version mismatch cannot push dirty data into the UI.
- All egress goes through an SSRF-checked exit; the image proxy is limited to `image/*`;
  collecting, filtering, Watch / Block, the daily report and the one-click update are kept.
- First release offering an in-image one-off upgrade service and the 2.x compose
  (db / upgrade / app / watchtower).
