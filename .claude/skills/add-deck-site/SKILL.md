---
name: add-deck-site
description: Add or fix automatic decklist import from a deck-building website (Archidekt-style link import) in src/decks.js. Use when asked to support links from a new deck site, or when an existing importer breaks.
---

# Add a deck-site importer

Importers are entries in the `SITES` array in `src/decks.js`: a `match` regex that captures the deck id from a
user's link, a `url(id)` that builds the API address, and `read(json)` returning `{ main, side }` rows of
`{ qty, name }`. `importable` and `fetchDeck` pick them up; nothing in `server.js` changes.

## First, find out whether it is possible

Probe the site's public JSON endpoint from Node, not only curl — some sites answer curl and block Node's
`fetch` by fingerprint:

```sh
node -e "fetch(process.argv[1], {headers: {'user-agent': 'mtg-league-site/0.1', accept: 'application/json'}}).then(async r => console.log(r.status, (await r.text()).slice(0, 300)))" '<api-url>'
```

If the answer is a bot challenge or 403, stop: the site is paste/upload only. Do not spoof a browser
User-Agent or otherwise work around the block. `JOURNAL.md` ("Deck and results intake") records which sites
were already tried and why Moxfield and MTGGoldfish are not imported.

## Rules an importer must keep

- The fetched URL is built from the captured id only. Never fetch a user-supplied URL or host.
- Exclude maybeboard/considering cards; map the sideboard to `side`.
- Tolerate missing or `null` fields in the payload (Archidekt cards can have `categories: null`).
- A failed import must surface as the existing "paste or upload instead" message, never a 500.

## Test

Add a case to `test/decks.test.js` like the Archidekt one: run the site's `read` on a trimmed, hand-written
sample of the real payload, including one card that must be excluded and one sideboard card. Tests must not touch the network. Then check
the real thing once by hand: start the site with the `run-local` skill and post a public deck link to `/report`.

Update the README's "How data gets in" list and append what you learned about the site's API to `JOURNAL.md`.
