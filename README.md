# Chicago Standard League

[![CI](https://github.com/lgray/chicago-standard-league/actions/workflows/ci.yml/badge.svg)](https://github.com/lgray/chicago-standard-league/actions/workflows/ci.yml)

Website for a store-independent Magic: The Gathering Standard league in Chicagoland:
leaderboard, event pages with decklists and photos, and a local metagame breakdown
(meta share, win rates with 95% Wilson intervals, matchup matrix).

Zero dependencies: Node ≥ 22.13 (`node:http` + `node:sqlite`). One SQLite file holds everything, photos included.

| Path | What |
|---|---|
| `src/server.js` | routes, HTML, validation, schema |
| `src/lib.js` | league math (points, metagame, matrix dedupe, standings and pairings parsers) |
| `src/decks.js` | decklist parser, Archidekt import, Scryfall check |
| `public/` | stylesheet, upload shrinker, rules text |
| `seed.js` | demo data, driven through the real request handler |
| `chart/` | Helm chart |
| `deploy/` | example values; your own go in git-ignored `deploy/local/` |

## Run locally

Needs only Node ≥ 22.13 — there is nothing to install.

```sh
printf 'LEAGUE_CODE=change-me-league\nADMIN_CODE=change-me-admin\nDEMO=1\n' > .env
make seed   # optional demo data (needs an empty ./data)
make run    # http://localhost:8080
```

`LEAGUE_CODE` gates reporting (share it in the league Discord); `ADMIN_CODE` gates `/admin`
(import standings or pairings, delete entries/photos). `DEMO=1` shows the demo-data banner.
`make help` lists every target.

## Deploy on Kubernetes

From a checkout, with `LEAGUE_CODE` and `ADMIN_CODE` in `.env` or the environment:

```sh
cp deploy/example-values.yaml deploy/local/values.yaml   # then edit: hostname, ingress class, issuer
make deploy VALUES=deploy/local/values.yaml              # helm upgrade --install, image from GHCR
make deploy-source VALUES=deploy/local/values.yaml       # no registry: runs the checkout's source on a stock Node image
```

- **Image**: CI publishes `ghcr.io/lgray/chicago-standard-league` for amd64 and arm64 (`:main` on every push to
  main, `:<version>` on release tags). The chart defaults to the tag matching its `appVersion`. If the package
  is not public, set `imagePullSecrets`. To build your own: `make image`.
- **Source mode**: set `sourceConfigMap` and a stock Node image in the values file (see `deploy/example-values.yaml`).
  `make deploy-source` uploads the source as that ConfigMap and restarts the pod.
- **Values**: `chart/values.yaml` documents every setting; `ingress.host` is the only one without a default.
  Start from `deploy/example-values.yaml` and keep your copy in `deploy/local/`, which is git-ignored so that
  cluster details (issuer names, ingress annotations, storage classes) stay out of the repository. The codes are
  never written to a values file; use `existingSecret` if you prefer to manage them yourself.
- Single replica with `Recreate` strategy by design: SQLite on a ReadWriteOnce volume.
- The PVC is annotated `helm.sh/resource-policy: keep`, so `helm uninstall` does not delete league data.
- Backup: `kubectl cp <namespace>/<pod>:/data ./backup` (copies `league.db` and its WAL files).

## Develop

```sh
make test          # unit tests (node --test)
make lint          # pre-commit hooks via prek; `prek install` runs them on every commit
make chart         # helm lint + render
make image smoke   # build the container and check it serves
```

CI (`.github/workflows/ci.yml`) runs those targets on every pull request and push, on the minimum supported
Node and the one the image ships, then seeds demo data through the real request handler and builds the image.
Actions are pinned by commit and kept current by Dependabot.

To release: set `version` and `appVersion` in `chart/Chart.yaml`, merge, then push tag `v<appVersion>`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org). `CLAUDE.md` and `.claude/skills/`
orient AI coding agents; `JOURNAL.md` records the research and decisions behind the design.

## How data gets in

- **Players** report deck, record, optional round-by-round opponents and photos at `/report`.
  Re-reporting the same event + name updates the entry.
- **Decklists**: paste or upload a text export (Arena, MTGO, Moxfield, Archidekt, MTGGoldfish), or give a public
  Archidekt link, which is imported. Lists are checked against Scryfall (unknown names, Standard legality,
  60/15 sizes); problems are shown as warnings, never rejected.
- **Organizers** (`/admin`) paste final standings, or each round's pairings ("Player A vs Player B 2-1").
  Imported records are marked ✓ and outrank self-reports; players then tap their name on the event page to add a deck.
- **QR posters** (`/qr?store=...`) open the report form with the store filled in.
- Wizards publishes no API or export for Companion/EventLink, so there is nothing to scrape; see `JOURNAL.md`.

Outbound calls identify themselves with `USER_AGENT` (default `mtg-league-site/0.1`).
