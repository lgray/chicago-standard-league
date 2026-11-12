---
name: run-local
description: Start the league site locally with seeded demo data and check that it serves. Use when asked to run, start, preview or screenshot the site, or to confirm a change works in the real app rather than only in unit tests.
---

# Run the site locally

Use a throwaway database so `./data` (the developer's own local data) is left alone.

```sh
export LEAGUE_CODE=dev-league ADMIN_CODE=dev-admin DEMO=1 PORT=8090 DATA_DIR=$(mktemp -d)
node seed.js                 # prints "Seeded { events: 9, entries: 91, ... }"
node src/server.js           # run in the background; logs "Chicago Standard League on http://localhost:$PORT"
```

`node seed.js` refuses to run against a non-empty database; that is intended. It needs no network
(`NO_CARD_CHECK` is set inside it) and skips demo photos when ImageMagick's `magick` is missing.

## Check it

```sh
for p in / /standings /metagame /events /events/1 /report /admin /rules /healthz; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' localhost:$PORT$p)" "$p"
done
```

Every line should start with `200`. Pages worth looking at after a change:

- `/metagame?range=all` — meta share, win rates, matchup matrix, most-played cards.
- `/events/1` — entries, decklists, warnings, "That's me" links.
- `/report` and `/admin` — the forms. Submit with `curl --form-string` (plain `-F` treats a value starting
  with `<` or `@` as a file); a successful post answers `303`.

A posted decklist triggers a real Scryfall request unless the server was started with `NO_CARD_CHECK=1`.

Stop the server when done: `pgrep -f '^node src/server.js' | xargs -r kill`.
