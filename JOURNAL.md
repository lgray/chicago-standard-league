# Journal

- [Research: comparable leagues](#research-comparable-leagues)
- [Research: Companion data](#research-companion-data)
- [Decisions](#decisions)
- [Open items](#open-items)
- [Deployment](#deployment)
- [Deck and results intake](#deck-and-results-intake)
- [Repository and CI](#repository-and-ci)
- [Security audit](#security-audit)

## Research: comparable leagues
2026-11-11.
- Chicago Pauper League (CPL): store-independent; join via Discord + a Google form collecting Companion
  info; points = match points summed over a player's top 5 events per 10-week season; top 16 play an
  invitational; TOs submit results via Discord. Rules doc v2026-09-06 linked from https://linktr.ee/chicagopauperleague
  (Instagram https://www.instagram.com/chicagopauperleague, Bluesky @chipauperleague.bsky.social, Discord ~238 members).
  No subreddit surfaced in search.
- NYC Pauper League: https://www.decksandthecity.org/ — nav Leaderboard / Events / Metagame / Articles / Rules /
  Schedule; four stores on fixed weeknights; 3 pts/win, 1/draw, best week counts, worst 2 of 16 weeks dropped,
  multi-store monthly bonus; top 28 + qualifier winners go to an Invitational. Metagame page is raw archetype
  counts per event/season with a separate matchup matrix.
- https://j6e.me/mtg-meta-analyzer/metagame is a client-rendered SvelteKit app; its content could not be read
  without a browser, so the metagame page here follows the genre (share, win rate + interval, matchup matrix),
  not that site specifically.

## Research: Companion data
- No public API or export: the request is an open, top-voted item on Wizards' Companion feedback board
  (https://feedback.wizards.com/forums/929932-companion-feedback/suggestions/41565004-tournament-results-history).
  EventLink is the store-side, login-gated tool; results are visible in Companion for a limited time.
- Workable path (what CPL does by hand): the TO or a player copies/screenshots final standings.
  Implemented as a paste-import on /admin that marks records confirmed, plus photo upload for screenshots.

## Decisions
- Node + node:sqlite, no dependencies, server-rendered HTML. Started as a Cloudflare Worker design; dropped
  when Kubernetes deployment became a requirement.
- Photos stored as BLOBs in SQLite, shrunk client-side to ≤1600px JPEG (also strips EXIF); server caps 1.5 MB,
  JPEG/PNG/WebP only.
- Trust model: shared league code to report, admin code to moderate/import; confirmed records beat self-reports.
- Matchup matrix dedupes two-sided reports per (event, round, pairing) by taking the larger side's count.
- Scoring copies CPL (best 5 events). Season dates are a constant in src/lib.js.

## Open items
- League rules page is a draft; store names and photos in the seed are placeholders.

## Deployment
2026-11-11. The live site runs as a Helm release in source mode (`sourceConfigMap`): a stock Node image with the
source mounted from a ConfigMap, because no image had been pushed to a registry at the time.
- Cluster-specific values and notes (ingress, certificates, DNS, storage) are deliberately kept out of the
  repository, in git-ignored `deploy/local/`. The chart takes all of it as values.
- A new host answering 404 from the ingress controller usually means the Ingress is missing a controller-specific
  annotation or DNS does not point at the controller yet; check both before suspecting the app.

## Deck and results intake
2026-11-11.
- Archidekt: public JSON at `archidekt.com/api/decks/<id>/` (cards with `quantity`, `categories`, `card.oracleCard.name`;
  deck-level `categories[].includedInDeck` marks the maybeboard). Imported server-side.
- Moxfield: `api2.moxfield.com/v3/decks/all/<publicId>` answers curl but returns a Cloudflare 403 to Node's fetch with
  identical headers, i.e. client fingerprinting. Not imported; needs Moxfield's approval of a client before retrying.
  Payload shape when it works: `boards.{mainboard,sideboard,companions}.cards{}.{quantity, card.name}`.
- MTGGoldfish deck download is behind a Cloudflare challenge. Paste/upload only.
- Scryfall `POST /cards/collection` matches names case-insensitively and by front face, returns found cards in request
  order plus `not_found`; used for spelling, legality and copy-count warnings.
- Pairings import format is our own ("A vs B 2-1", "C bye"); no real EventLink pairings export has been seen yet.
- DNS trap: if a pod's search domain answers unknown names with an empty NOERROR, musl (Alpine) stops searching and
  external lookups fail with ENOTFOUND. The chart's default `dnsConfig` sets `ndots:1` for this.
- Not built: archetype suggestion from a list; screenshot OCR (deferred by the owner to a later app).

## Repository and CI
2026-11-12. Published as public repo `lgray/chicago-standard-league` (owner's choice).
- CI builds the image and pushes it to `ghcr.io/lgray/chicago-standard-league` (amd64 + arm64); chart default
  image moved there from Docker Hub, where nothing was ever pushed.
- The live site was not redeployed and still runs source mode. The GHCR package was created while the repo was
  private, so it stays private until its visibility is changed in the package settings (GitHub has no API for it).
- Node 22.13 rejects a reused numbered SQL parameter (`?1` twice) with "column index out of range"; newer 22.x
  and 24 accept it. CI's minimum-version job found it; queries now use plain `?`.
- JS/CSS lint is Biome, run as a pre-commit hook so the project still has no npm dependencies. No formatter:
  it would rewrite the dense house style. `noDescendingSpecificity` is off (flat stylesheet, unrelated components).
- `main` is protected (PR required, `required` status check, no force-push or deletion; admins may bypass).
- MIT licence, chosen by the owner 2026-11-17.

## Security audit
2026-11-18. Whole-app audit driven through `handle` and the real `node:http` server; fixes on branch `security-hardening`.
- Fixed: the 8 MB POST cap trusted `content-length`, so a chunked body was buffered whole (one 200 MB request took
  the server to 841 MB RSS against a 256 Mi limit); the cap now counts bytes read. Also: security headers and a CSP
  with no inline script, SRI on the cdnjs QR script, photo type taken from magic bytes, parser line cap (pairings
  regex was cubic in a run of spaces), imported decks capped like pasted ones, pod `seccompProfile` and no API token.
- Checked and sound: `html` escaping in every context used, bound SQL parameters throughout (interpolated SQL is
  constants only), constant-time code comparison, no ambient credentials so no CSRF, outbound URLs built from a
  captured numeric id.
- No throttle on code guesses (about 5,000 admin guesses/s in-process). A limiter needs a trusted client address
  the app does not have, and a global lockout would let anyone block organizers, so the defence is entropy: the
  server refuses to start unless `ADMIN_CODE` is 12+ characters and differs from `LEAGUE_CODE`. An ingress rate
  limit is still worth adding.
- Also closed in the same change: HSTS (one year, host only), `photos.id` is `AUTOINCREMENT` (a deleted id was
  reused while `/img/:id` is cached `immutable`, so a removed photo could show in a new one's slot; old databases
  are rebuilt once at startup), dates must exist on the calendar (`2026-02-31` was accepted), the adapter answers
  400 instead of 500 for `TRACE` or an unparseable `Host`, user-facing errors are `UserError` instead of thrown strings.
- Open: EXIF/GPS survives when the browser-side re-encode does not run (JavaScript off); a server-side strip has
  to keep orientation, so it is a segment walker per format. Reported by the audit, not reproduced here: Scryfall
  answers "fire // ice" as not found, so split cards normalised by `parseDeck` draw a spurious "Unrecognised" warning.
