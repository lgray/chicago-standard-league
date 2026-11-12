// Decklists: text parsing, import from deck sites, and a Scryfall sanity check.

const UA = process.env.USER_AGENT || 'mtg-league-site/0.1';
const SECTIONS = { deck: 'main', main: 'main', mainboard: 'main', maindeck: 'main', commander: 'main',
  sideboard: 'side', side: 'side', companion: null, maybeboard: null, considering: null, about: null };

const merge = (rows) => {
  const byName = new Map();
  for (const { qty, name } of rows) byName.set(name.toLowerCase(), { qty: (byName.get(name.toLowerCase())?.qty ?? 0) + qty, name });
  return [...byName.values()];
};

// Accepts the plain-text exports of Arena, MTGO, Moxfield, Archidekt and MTGGoldfish:
// "4 Name", "4x Name (SET) 123 *F*", "SB: 2 Name", section headers, or a blank line before the sideboard.
export function parseDeck(text) {
  const boards = { main: [], side: [] };
  let board = 'main', headers = false, skipped = 0;
  for (const raw of text.split(/\r?\n/).slice(0, 400)) {
    const line = raw.trim();
    const section = line.replace(/^\/\/\s*/, '').replace(/\s*\(\d+\)$/, '').replace(/:$/, '').toLowerCase();
    if (section in SECTIONS) { board = SECTIONS[section]; headers = true; continue; }
    if (!line) { if (!headers && boards.main.length) board = 'side'; continue; }
    if (/^(\/\/|#)/.test(line)) continue;
    const m = line.match(/^(SB:\s*)?(\d{1,3})\s*x?\s+(.+)$/i);
    if (!m) { if (board) skipped++; continue; }
    const name = m[3].replace(/\s+[([][A-Za-z0-9]{2,6}[)\]].*$/, '').replace(/\s+(\*\w+\*|[#^[]).*$/, '').replace(/\s*\/{1,2}\s*/, ' // ').trim().slice(0, 150);
    const target = m[1] ? 'side' : board;
    if (target && name && +m[2]) boards[target].push({ qty: +m[2], name });
  }
  return { main: merge(boards.main), side: merge(boards.side), skipped };
}

const total = (rows) => rows.reduce((n, r) => n + r.qty, 0);
const lines = (rows) => rows.map((r) => `${r.qty} ${r.name}`).join('\n');
export const formatDeck = (deck) => lines(deck.main) + (deck.side.length ? `\n\nSideboard\n${lines(deck.side)}` : '');

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000), headers: { 'user-agent': UA, accept: 'application/json', ...init.headers } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// The fetched URL is always built here from a captured id, never taken from the user, so this cannot be
// pointed at internal addresses.
export const SITES = [
  { name: 'Archidekt', match: /archidekt\.com\/(?:api\/)?decks\/(\d+)/i, url: (id) => `https://archidekt.com/api/decks/${id}/`,
    read(d) {
      const excluded = new Set(d.categories.filter((c) => !c.includedInDeck).map((c) => c.name));
      const rows = d.cards.filter((c) => !(c.categories ?? []).some((x) => excluded.has(x)))
        .map((c) => ({ qty: c.quantity, name: c.card.oracleCard.name, side: (c.categories ?? []).includes('Sideboard') }));
      return { main: rows.filter((r) => !r.side), side: rows.filter((r) => r.side) };
    } },
];

export const importable = (url) => SITES.some((s) => s.match.test(url));

export async function fetchDeck(url) {
  const site = SITES.find((s) => s.match.test(url));
  try {
    const deck = site.read(await getJson(site.url(url.match(site.match)[1])));
    return { main: merge(deck.main.map(({ qty, name }) => ({ qty, name }))), side: merge(deck.side.map(({ qty, name }) => ({ qty, name }))), skipped: 0 };
  } catch (e) {
    console.error(e);
    throw `Couldn’t load that deck from ${site.name} (is it public?). Paste or upload the list instead.`;
  }
}

// Returns the deck with Scryfall's spelling of each name, plus warnings. Advisory only: if Scryfall is
// unreachable the deck is accepted as typed.
// ponytail: one Scryfall call per submission, no local card cache; add one if submissions get frequent.
export async function checkDeck(deck, lookup = scryfall) {
  const warnings = [];
  const names = [...new Set([...deck.main, ...deck.side].map((r) => r.name.toLowerCase()))];
  let cards;
  try { cards = await lookup(names); } catch (e) { console.error(e); cards = null; }
  const fix = (rows) => merge(rows.map((r) => ({ qty: r.qty, name: cards?.get(r.name.toLowerCase())?.name ?? r.name })));
  const out = { main: fix(deck.main), side: fix(deck.side) };
  if (cards) {
    const unknown = names.filter((n) => !cards.has(n));
    if (unknown.length) warnings.push(`Unrecognised: ${unknown.join(', ')}`);
    const illegal = [...new Set([...cards.values()].filter((c) => c.legalities.standard !== 'legal').map((c) => c.name))];
    if (illegal.length) warnings.push(`Not Standard legal: ${illegal.join(', ')}`);
    const copies = new Map();
    for (const r of [...out.main, ...out.side]) copies.set(r.name, (copies.get(r.name) ?? 0) + r.qty);
    const over = [...cards.values()].filter((c) => copies.get(c.name) > 4 && !/Basic/.test(c.type_line) && !/A deck can have any number/.test(c.oracle_text ?? '')).map((c) => c.name);
    if (over.length) warnings.push(`More than 4 copies: ${[...new Set(over)].join(', ')}`);
  }
  if (total(out.main) < 60) warnings.push(`Main deck has ${total(out.main)} cards (60 minimum)`);
  if (total(out.side) > 15) warnings.push(`Sideboard has ${total(out.side)} cards (15 maximum)`);
  if (deck.skipped) warnings.push(`${deck.skipped} line(s) couldn’t be read`);
  return { deck: out, warnings };
}

async function scryfall(names) {
  const cards = new Map();
  for (let i = 0; i < names.length; i += 75) {
    const batch = names.slice(i, i + 75);
    const res = await getJson('https://api.scryfall.com/cards/collection', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifiers: batch.map((name) => ({ name })) }) });
    const missing = new Set(res.not_found.map((x) => x.name.toLowerCase()));
    batch.filter((n) => !missing.has(n)).forEach((n, j) => cards.set(n, res.data[j])); // data keeps request order
  }
  return cards;
}
