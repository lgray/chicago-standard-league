# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

`make help` lists everything; CI (`.github/workflows/ci.yml`) runs the same targets.

```sh
make test                                   # node --test
node --test test/decks.test.js              # one file
node --test --test-name-pattern='matrix'    # one test by name
make lint                                   # prek hooks: whitespace, YAML/JSON, actionlint
make chart                                  # helm lint + render with deploy/example-values.yaml
make image smoke                            # build the container, start it, fetch three pages
make run                                    # http://localhost:8080, codes from .env
make seed                                   # demo data; refuses unless the database is empty
```

`.env` (git-ignored) holds `LEAGUE_CODE`, `ADMIN_CODE` and optionally `DEMO=1`; the Makefile exports it.
To seed without touching `./data`: `DATA_DIR=$(mktemp -d) make seed`.

Project skills in `.claude/skills/`: `run-local`, `deploy`, `release`, `add-deck-site`.

## Architecture

Zero runtime dependencies on purpose: Node ≥ 22.13 built-ins only (`node:http`, `node:sqlite`). Do not add
packages, a bundler or a framework; there is no `npm install` step anywhere (Dockerfile, CI, ConfigMap deploy).

- `src/server.js` is the whole app. `handle(req)` maps a web `Request` to a `Response`; the `node:http`
  adapter at the bottom only runs when the file is the main module. `seed.js` imports `handle` and posts real
  forms through it, which is also the integration check CI runs — drive `handle` the same way for new end-to-end checks.
- HTML is server-rendered with the `html` tagged template, which escapes every interpolation. Wrap a value in
  `Raw` only when it is already-built markup.
- One SQLite file (`$DATA_DIR/league.db`, WAL) holds everything including photo BLOBs. The schema is created at
  startup; new columns are added by the `ALTER TABLE` list beside it, which must stay re-runnable.
- `src/lib.js` is pure league math and text parsers (points, Wilson intervals, matchup matrix, standings and
  pairings parsers). `src/decks.js` is decklist parsing, deck-site import and the Scryfall check. Both are unit-tested;
  `server.js` is covered by the seed run.
- Trust model: anyone with `LEAGUE_CODE` can report; `ADMIN_CODE` gates `/admin`. Organizer imports set
  `verified` on entries and rounds; a later self-report can add a deck to such an entry but never changes its
  verified record or rounds.
- The matchup matrix counts each match once even when both players report it (dedupe per event, round and pairing
  in `matrix`). Any new source of round data has to supply `round` or it will double-count.
- Seasons are the `SEASONS` constant in `src/lib.js`; standings count each player's best 5 events.

## Outbound requests

The server calls Scryfall and Archidekt only. In `src/decks.js` the fetched URL is built from an id captured out
of the user's link, never from the link itself. Requests identify themselves honestly (`USER_AGENT`); a site that
blocks server-side clients (Moxfield, MTGGoldfish) is not imported — do not disguise the client to get around it.
The Scryfall check is advisory: failures and warnings never reject a submission. Tests and the seed must not hit
the network (`checkDeck` takes an injectable `lookup`; the seed sets `NO_CARD_CHECK`).

## Deployment

- `chart/` is one template file. Single replica with `Recreate` is required by SQLite on a ReadWriteOnce volume.
- Two ways to run: the image CI publishes to `ghcr.io/lgray/chicago-standard-league`, or `sourceConfigMap` mode,
  where a stock Node image runs source mounted from a ConfigMap (`make deploy-source`).
- A new file under `src/` or `public/` must also be added to the ConfigMap `items` list in
  `chart/templates/app.yaml`, or source-mode pods will not see it.
- Nothing specific to a real cluster is committed: no hostnames, addresses, node or issuer names, kubeconfig
  paths, or codes. Such settings are chart values, kept in git-ignored `deploy/local/` (values files and
  `NOTES.md`). Read that directory if it exists; never copy its contents into tracked files, commit messages,
  issues or PRs.
- The live site runs in source mode with demo data. Deploying restarts it; do that only when asked.

## Conventions

- Conventional commits. A release is a `v<appVersion>` tag matching `chart/Chart.yaml`; CI fails the tag otherwise.
- `ponytail:` comments mark deliberate shortcuts and name the ceiling and the upgrade path. Keep them accurate
  when touching that code; `/ponytail-debt` lists them.
- GitHub Actions are pinned by commit SHA with the version in a trailing comment; Dependabot updates them.
- `JOURNAL.md` records research and decisions (why Companion cannot be scraped, why Moxfield is paste-only,
  cluster traps). Read its table of contents before re-investigating; append new findings at the end.
