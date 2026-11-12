import http from 'node:http';
import { readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { seasonFor, key, standings, metagame, matrix, parseStandings, parsePairings } from './lib.js';
import { parseDeck, formatDeck, importable, fetchDeck, checkDeck } from './decks.js';

const { LEAGUE_CODE, ADMIN_CODE, DATA_DIR = './data', PORT = 8080, DEMO, NO_CARD_CHECK } = process.env;
if (!LEAGUE_CODE || !ADMIN_CODE) throw new Error('Set LEAGUE_CODE and ADMIN_CODE (see README).');

const MAX_BODY = 8e6, MAX_PHOTO = 1.5e6, MAX_PHOTOS = 4, ROUNDS = 5;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(`${DATA_DIR}/league.db`);
db.exec(`
  PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL, store TEXT NOT NULL, store_key TEXT NOT NULL,
    UNIQUE (date, store_key));
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    player TEXT NOT NULL, player_key TEXT NOT NULL, archetype TEXT NOT NULL DEFAULT 'Unknown',
    wins INTEGER NOT NULL, losses INTEGER NOT NULL, draws INTEGER NOT NULL,
    deck_url TEXT, deck_warnings TEXT, verified INTEGER NOT NULL DEFAULT 0,
    UNIQUE (event_id, player_key));
  CREATE TABLE IF NOT EXISTS rounds (
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE, round INTEGER NOT NULL,
    opp_archetype TEXT NOT NULL, result TEXT NOT NULL CHECK (result IN ('W','L','D')),
    opp_key TEXT, verified INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS cards (
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    board TEXT NOT NULL CHECK (board IN ('main','side')), qty INTEGER NOT NULL, name TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS cards_entry ON cards (entry_id);
  -- ponytail: photos live in SQLite so one file is the whole backup; move to object storage past a few GB.
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    caption TEXT, mime TEXT NOT NULL, data BLOB NOT NULL);
`);
// Columns added after the first release; each fails harmlessly once the column exists.
for (const col of ['entries ADD deck_warnings TEXT', 'rounds ADD opp_key TEXT', 'rounds ADD verified INTEGER NOT NULL DEFAULT 0'])
  try { db.exec(`ALTER TABLE ${col}`); } catch {}

// ---------- html ----------
class Raw { constructor(s) { this.s = s; } }
const esc = (v) => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(esc).join('')
  : String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const html = (s, ...v) => new Raw(s.reduce((a, x, i) => a + esc(v[i - 1]) + x));
const pct = (x) => x == null ? '–' : `${Math.round(x * 100)}%`;
const record = (e) => `${e.wins}–${e.losses}${e.draws ? `–${e.draws}` : ''}`;
const fmtDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

const NAV = [['/', 'Home'], ['/standings', 'Standings'], ['/metagame', 'Metagame'], ['/events', 'Events'], ['/rules', 'Rules']];

function page(title, path, body, status = 200) {
  const doc = html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Chicago Standard League</title>
<meta name="description" content="A store-independent Magic: The Gathering Standard league for Chicagoland. Standings, decklists, photos and the local metagame.">
<link rel="stylesheet" href="/style.css"></head><body>
${DEMO ? html`<div class="demo">Prototype — the players, results and photos below are generated demo data.</div>` : ''}
<header><nav>
  <a class="brand" href="/"><span class="star">✶</span> Chicago Standard League</a>
  <span class="links">${NAV.map(([href, label]) => html`<a href="${href}" ${href === path ? new Raw('aria-current="page"') : ''}>${label}</a>`)}</span>
  <a class="btn" href="/report">Report a result</a>
</nav></header>
<main>${body}</main>
<footer>
  <p>Chicago Standard League is community-run and store-independent. Results are self-reported in good faith; rows marked ✓ were confirmed from the organizer's final standings.</p>
  <p>Unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC. · <a href="/admin">Organizers</a></p>
</footer><script src="/app.js" defer></script></body></html>`;
  return new Response(doc.s, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const fail = (status, msg) => page('Oops', '', html`<section class="card narrow"><h1>${status === 404 ? 'Not found' : 'That didn’t go through'}</h1><p>${msg}</p><p><a href="javascript:history.back()">← Go back</a></p></section>`, status);

// ---------- queries ----------
const entriesBetween = (from, to) => db.prepare(
  `SELECT e.*, ev.date, ev.store FROM entries e JOIN events ev ON ev.id = e.event_id
   WHERE ev.date BETWEEN ? AND ? ORDER BY ev.date DESC`).all(from, to);
const roundsBetween = (from, to) => db.prepare(
  `SELECT e.event_id event, r.round, e.archetype a, coalesce(nullif(o.archetype, 'Unknown'), r.opp_archetype) b, r.result
   FROM rounds r JOIN entries e ON e.id = r.entry_id JOIN events ev ON ev.id = e.event_id
   LEFT JOIN entries o ON o.event_id = e.event_id AND o.player_key = r.opp_key
   WHERE ev.date BETWEEN ? AND ?`).all(from, to);
const BASICS = "'Plains','Island','Swamp','Mountain','Forest'";
const topCards = (from, to) => db.prepare(
  `SELECT c.name, count(DISTINCT c.entry_id) decks, sum(c.qty) copies, sum(iif(c.board = 'main', c.qty, 0)) main
   FROM cards c JOIN entries e ON e.id = c.entry_id JOIN events ev ON ev.id = e.event_id
   WHERE ev.date BETWEEN ? AND ? AND c.name NOT IN (${BASICS}) GROUP BY c.name ORDER BY decks DESC, copies DESC LIMIT 25`).all(from, to);
const listCount = (from, to) => db.prepare(
  `SELECT count(DISTINCT c.entry_id) n FROM cards c JOIN entries e ON e.id = c.entry_id JOIN events ev ON ev.id = e.event_id
   WHERE ev.date BETWEEN ? AND ?`).get(from, to).n;
const reportLink = (params) => `/report?${new URLSearchParams(params)}`;
const eventList = (limit) => db.prepare(
  `SELECT ev.*, count(e.id) players,
     (SELECT archetype FROM entries WHERE event_id = ev.id ORDER BY 3*wins+draws DESC, losses LIMIT 1) top_deck,
     (SELECT player FROM entries WHERE event_id = ev.id ORDER BY 3*wins+draws DESC, losses LIMIT 1) top_player
   FROM events ev LEFT JOIN entries e ON e.event_id = ev.id GROUP BY ev.id ORDER BY ev.date DESC, ev.id DESC LIMIT ?`).all(limit);
const photoList = (where, ...args) => db.prepare(
  `SELECT p.id, p.caption, p.event_id, ev.date, ev.store FROM photos p JOIN events ev ON ev.id = p.event_id ${where}`).all(...args);
const known = (col, table) => db.prepare(`SELECT DISTINCT ${col} v FROM ${table} ORDER BY 1`).all().map((r) => r.v);
// Reuse the first spelling the league saw so "izzet prowess" and "Izzet Prowess" are one archetype.
const canon = (name) => db.prepare(
  `SELECT archetype v FROM entries WHERE lower(archetype) = lower(?)
   UNION SELECT opp_archetype FROM rounds WHERE lower(opp_archetype) = lower(?) LIMIT 1`).get(name, name)?.v ?? name;

function range(url) {
  const r = url.searchParams.get('range') ?? 'season', t = today(), s = seasonFor(t);
  if (r === 'all') return ['all', '0000', '9999'];
  if (r === '30d') return ['30d', new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), t];
  return ['season', s.start, s.end];
}

// ---------- components ----------
const standingsTable = (rows, limit) => html`<div class="scroll"><table>
  <thead><tr><th>#</th><th>Player</th><th class="num">Points</th><th class="num">Events</th><th class="num">Record</th><th class="num">Win %</th><th>Most played</th></tr></thead>
  <tbody>${rows.slice(0, limit).map((p, i) => html`<tr><td class="rank">${i + 1}</td><td><b>${p.player}</b></td><td class="num pts">${p.points}</td>
    <td class="num">${p.events}</td><td class="num">${record(p)}</td><td class="num">${pct(p.winRate)}</td><td>${p.deck}</td></tr>`)}</tbody></table></div>`;

const shareBars = (meta, limit) => html`<ul class="bars">${meta.slice(0, limit).map((d) => html`<li>
  <span class="name">${d.name}</span><span class="bar"><i style="width:${(d.share / meta[0].share) * 100}%"></i></span><span class="num">${pct(d.share)}</span></li>`)}</ul>`;

const gallery = (photos) => html`<div class="gallery">${photos.map((p) => html`<a href="/events/${p.event_id}"><figure>
  <img src="/img/${p.id}" alt="${p.caption || `Photo from ${p.store}`}" loading="lazy"><figcaption>${p.caption || p.store} · ${fmtDate(p.date)}</figcaption></figure></a>`)}</div>`;

const eventCards = (events) => html`<div class="cards">${events.map((ev) => html`<a class="card event" href="/events/${ev.id}">
  <time>${fmtDate(ev.date)}</time><h3>${ev.store}</h3>
  <p>${ev.players} ${ev.players === 1 ? 'player' : 'players'}${ev.top_player ? html` · top finish <b>${ev.top_player}</b> on ${ev.top_deck}` : ''}</p></a>`)}</div>`;

const empty = (what) => html`<p class="muted">No ${what} yet — <a href="/report">report a result</a> to get things started.</p>`;

// ---------- pages ----------
function home() {
  const s = seasonFor(today()), entries = entriesBetween(s.start, s.end);
  const rows = standings(entries), meta = metagame(entries);
  const photos = photoList('ORDER BY p.id DESC LIMIT 6'), events = eventList(3);
  return page('Home', '/', html`
<section class="hero">
  <div class="flag" aria-hidden="true"><i></i><span>✶ ✶ ✶ ✶</span><i></i></div>
  <h1>Standard Across Chicagoland</h1>
  <p>One league across every local game store. Play your weekly Standard event, report your deck and record, and compete for glory across Greater Chicagoland.</p>
  <p><a class="btn big" href="/report">Report a result</a> <a class="btn big ghost" href="/rules">How it works</a></p>
  <dl class="stats"><div><dt>${rows.length}</dt><dd>players</dd></div><div><dt>${new Set(entries.map((e) => e.event_id)).size}</dt><dd>events</dd></div>
    <div><dt>${meta.length}</dt><dd>archetypes</dd></div><div><dt>${s.name.split(' · ')[0]}</dt><dd>${s.name.split(' · ')[1]}</dd></div></dl>
</section>
<div class="grid2">
  <section class="card"><h2>Leaderboard <a class="more" href="/standings">Full standings →</a></h2>${rows.length ? standingsTable(rows, 8) : empty('standings')}</section>
  <section class="card"><h2>Metagame <a class="more" href="/metagame">Full breakdown →</a></h2>${meta.length ? shareBars(meta, 8) : empty('decks')}</section>
</div>
<section><h2>Latest events <a class="more" href="/events">All events →</a></h2>${events.length ? eventCards(events) : empty('events')}</section>
${photos.length ? html`<section><h2>From the tables</h2>${gallery(photos)}</section>` : ''}`);
}

function standingsPage() {
  const s = seasonFor(today()), rows = standings(entriesBetween(s.start, s.end));
  return page('Standings', '/standings', html`<section class="card"><h1>Standings</h1>
<p class="muted">${s.name} · ${fmtDate(s.start)} – ${fmtDate(s.end)}. League points are match points (3 per win, 1 per draw) summed over your best 5 events.</p>
${rows.length ? standingsTable(rows, 1e9) : empty('standings')}</section>`);
}

function metagamePage(url) {
  const [r, from, to] = range(url), entries = entriesBetween(from, to);
  const meta = metagame(entries), cells = matrix(roundsBetween(from, to));
  const top = meta.filter((d) => d.name !== 'Unknown').slice(0, 8).map((d) => d.name);
  const cards = topCards(from, to), lists = listCount(from, to);
  const tab = (id, label) => html`<a href="/metagame?range=${id}" ${id === r ? new Raw('aria-current="page"') : ''}>${label}</a>`;
  const cell = (a, b) => {
    const c = cells.get(`${a}|${b}`);
    if (a === b || !c) return html`<td class="nil">${a === b ? '' : '·'}</td>`;
    const wr = c.wins / (c.wins + c.losses);
    return html`<td style="--wr:${wr};--n:${Math.min(1, (c.wins + c.losses) / 6)}"><b>${pct(wr)}</b><small>${c.wins}–${c.losses}</small></td>`;
  };
  return page('Metagame', '/metagame', html`
<section class="card"><h1>Chicago Standard metagame</h1>
<p class="tabs">${tab('30d', 'Last 30 days')}${tab('season', 'This season')}${tab('all', 'All time')}</p>
${!meta.length ? empty('decks') : html`
<p class="muted">${entries.length} decks from ${new Set(entries.map((e) => e.event_id)).size} events. Win rate is match wins ÷ (wins + losses); the range is a 95% Wilson interval — wide ranges mean “not enough matches yet”.</p>
<div class="scroll"><table><thead><tr><th>Archetype</th><th class="num">Decks</th><th>Meta share</th><th class="num">Record</th><th class="num">Win %</th><th>95% range</th></tr></thead>
<tbody>${meta.map((d) => html`<tr><td><b>${d.name}</b></td><td class="num">${d.n}</td>
  <td><span class="bar inline"><i style="width:${(d.share / meta[0].share) * 100}%"></i></span> ${pct(d.share)}</td>
  <td class="num">${record(d)}</td><td class="num">${pct(d.winRate)}</td>
  <td>${d.winRate == null ? '' : html`<span class="ci" title="${pct(d.lo)} – ${pct(d.hi)}"><i style="left:${d.lo * 100}%;width:${(d.hi - d.lo) * 100}%"></i><b style="left:${d.winRate * 100}%"></b></span> <small>${pct(d.lo)}–${pct(d.hi)}</small>`}</td></tr>`)}</tbody></table></div>`}
</section>
${top.length < 2 || !cells.size ? '' : html`<section class="card"><h2>Matchup matrix</h2>
<p class="muted">Row deck’s match win rate against the column deck, from round-by-round reports. Faded cells have fewer than 6 matches.</p>
<div class="scroll"><table class="matrix"><thead><tr><th></th>${top.map((n) => html`<th><span>${n}</span></th>`)}</tr></thead>
<tbody>${top.map((a) => html`<tr><th>${a}</th>${top.map((b) => cell(a, b))}</tr>`)}</tbody></table></div></section>`}
${!cards.length ? '' : html`<section class="card"><h2>Most played cards</h2>
<p class="muted">From the ${lists} submitted ${lists === 1 ? 'decklist' : 'decklists'} in this period, basic lands excluded.</p>
<div class="scroll"><table><thead><tr><th>Card</th><th class="num">Decks</th><th>% of lists</th><th class="num">Avg copies</th><th class="num">Main / side</th></tr></thead>
<tbody>${cards.map((c) => html`<tr><td><a href="https://scryfall.com/search?q=${encodeURIComponent(`!"${c.name}"`)}" rel="noopener">${c.name}</a></td><td class="num">${c.decks}</td>
  <td><span class="bar inline"><i style="width:${(c.decks / lists) * 100}%"></i></span> ${pct(c.decks / lists)}</td>
  <td class="num">${(c.copies / c.decks).toFixed(1)}</td><td class="num">${c.main} / ${c.copies - c.main}</td></tr>`)}</tbody></table></div></section>`}`);
}

function eventsPage() {
  const events = eventList(200);
  return page('Events', '/events', html`<h1>Events</h1>${events.length ? eventCards(events) : empty('events')}`);
}

function eventPage(id) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!ev) return fail(404, 'No such event.');
  const entries = db.prepare('SELECT * FROM entries WHERE event_id = ? ORDER BY 3*wins+draws DESC, losses, player').all(id);
  const photos = photoList('WHERE p.event_id = ? ORDER BY p.id', id);
  const decks = Map.groupBy(db.prepare('SELECT * FROM cards WHERE entry_id IN (SELECT id FROM entries WHERE event_id = ?)').all(id), (c) => c.entry_id);
  const here = { date: ev.date, store: ev.store };
  const deck = (e) => {
    const cards = decks.get(e.id);
    if (!cards) return '';
    const board = (b) => cards.filter((c) => c.board === b), n = (b) => board(b).reduce((t, c) => t + c.qty, 0);
    return html`<details><summary>decklist ${n('main')}/${n('side')}${e.deck_warnings ? html` <span class="warn" title="See notes">⚠</span>` : ''}</summary>
      ${e.deck_warnings ? html`<p class="warn">${e.deck_warnings.split('\n').map((w) => html`${w}<br>`)}</p>` : ''}
      <pre>${formatDeck({ main: board('main'), side: board('side') })}</pre><button type="button" class="copy" data-copy>Copy list</button></details>`;
  };
  return page(`${ev.store} ${ev.date}`, '/events', html`
<section class="card"><p class="muted"><a href="/events">← Events</a></p><h1>${ev.store}</h1>
<p class="muted">${fmtDate(ev.date)} · ${entries.length} reported ${entries.length === 1 ? 'player' : 'players'} · <a href="${reportLink(here)}">Add your result or photos</a></p>
<div class="scroll"><table><thead><tr><th>#</th><th>Player</th><th>Deck</th><th class="num">Record</th><th>List</th></tr></thead>
<tbody>${entries.map((e, i) => html`<tr><td class="rank">${i + 1}</td><td><b>${e.player}</b></td>
  <td>${e.archetype === 'Unknown' ? html`<a href="${reportLink({ ...here, player: e.player })}">That’s me — add my deck</a>` : e.archetype}</td>
  <td class="num">${record(e)} ${e.verified ? html`<span class="ok" title="Confirmed from organizer standings">✓</span>` : ''}</td>
  <td>${e.deck_url ? html`<a href="${e.deck_url}" rel="noopener nofollow">link ↗</a> ` : ''}${deck(e)}</td></tr>`)}</tbody></table></div>
</section>${photos.length ? html`<section><h2>Photos</h2>${gallery(photos)}</section>` : ''}`);
}

function reportPage(url) {
  const q = (k) => url.searchParams.get(k) ?? '';
  const list = (id, values) => html`<datalist id="${id}">${values.map((v) => html`<option value="${v}">`)}</datalist>`;
  const decks = [...new Set([...known('archetype', 'entries'), ...known('opp_archetype', 'rounds')])].filter((d) => d !== 'Unknown');
  return page('Report a result', '/report', html`<section class="card narrow"><h1>Report a result</h1>
<p class="muted">Takes about a minute. Reporting again for the same event and name updates your entry — so you can add a decklist later. Photos-only posts are welcome too.</p>
<form method="post" action="/report" enctype="multipart/form-data">
  <fieldset><legend>Event</legend><div class="row">
    <label>Date <input type="date" name="date" required max="${today()}" value="${q('date') || today()}"></label>
    <label>Store <input name="store" required maxlength="60" list="stores" value="${q('store')}" placeholder="Where did you play?"></label></div>
    ${list('stores', known('store', 'events'))}</fieldset>
  <fieldset><legend>You</legend><div class="row">
    <label>Name <input name="player" required maxlength="40" autocomplete="name" value="${q('player')}" placeholder="As it appears in Companion"></label>
    <label>Deck archetype <input name="archetype" maxlength="40" list="decks" placeholder="e.g. Izzet Prowess"></label></div>${list('decks', decks)}
    <div class="row three"><label>Wins <input type="number" name="wins" min="0" max="15" value="0"></label>
    <label>Losses <input type="number" name="losses" min="0" max="15" value="0"></label>
    <label>Draws <input type="number" name="draws" min="0" max="15" value="0"></label></div></fieldset>
  <fieldset><legend>Round by round <small>optional — powers the matchup matrix</small></legend>
    ${Array.from({ length: ROUNDS }, (_, i) => html`<div class="row round"><label>Round ${i + 1} opponent’s deck <input name="opp${i}" maxlength="40" list="decks"></label>
    <label>Result <select name="res${i}"><option value="">–</option><option value="W">Win</option><option value="L">Loss</option><option value="D">Draw</option></select></label></div>`)}
    <p class="hint">If you fill these in, your record is taken from them.</p></fieldset>
  <fieldset><legend>Deck <small>optional</small></legend>
    <label>Deck link <input type="url" name="deck_url" maxlength="200" placeholder="https://archidekt.com/decks/…"></label>
    <p class="hint">Public Archidekt links are imported automatically. For Moxfield, MTGGoldfish and others, also paste or upload the site’s text export.</p>
    <label>Paste a list <textarea name="decklist" rows="6" maxlength="20000" placeholder="4 Burst Lightning&#10;20 Mountain&#10;&#10;Sideboard&#10;2 Negate"></textarea></label>
    <label>…or upload a text export (Arena, MTGO, Moxfield, Archidekt, MTGGoldfish) <input type="file" name="deckfile" accept=".txt,.dec,text/plain"></label></fieldset>
  <fieldset><legend>Photos <small>optional, up to ${MAX_PHOTOS}</small></legend>
    <label>Deck pics, top tables, your Companion standings screenshot <input type="file" name="photos" accept="${PHOTO_TYPES.join(',')}" multiple></label>
    <label>Caption <input name="caption" maxlength="100"></label></fieldset>
  <label>League code <input name="code" required autocomplete="off" placeholder="Pinned in the league Discord"></label>
  <button class="btn big">Submit</button>
</form></section>`);
}

function adminPage() {
  const entries = db.prepare(`SELECT e.id, e.player, e.archetype, ev.date, ev.store FROM entries e JOIN events ev ON ev.id = e.event_id ORDER BY e.id DESC LIMIT 40`).all();
  const photos = photoList('ORDER BY p.id DESC LIMIT 40');
  return page('Organizers', '/admin', html`<section class="card narrow"><h1>Organizers</h1>
<form method="post" action="/admin" enctype="multipart/form-data">
  <label>Admin code <input name="code" type="password" required></label>
  <fieldset><legend>Event</legend>
    <div class="row"><label>Date <input type="date" name="date" max="${today()}" value="${today()}"></label><label>Store <input name="store" maxlength="60" list="stores"></label></div>
    <datalist id="stores">${known('store', 'events').map((v) => html`<option value="${v}">`)}</datalist></fieldset>
  <fieldset><legend>Import final standings</legend>
    <p class="hint">One player per line — “rank name points W-L-D”, extra columns are ignored. Records become ✓ confirmed and override self-reports. Players then tap their name on the event page to add a deck.</p>
    <label>Standings <textarea name="standings" rows="6"></textarea></label><button class="btn" name="do" value="standings">Import standings</button></fieldset>
  <fieldset><legend>Import a round’s pairings</legend>
    <p class="hint">One match per line — “Player A vs Player B 2-1” (games won by A, then B), or “Player C bye”. A leading table number is ignored. Import every round: records are rebuilt from the imported rounds, and the matchup matrix uses each opponent’s reported deck.</p>
    <label>Round <input type="number" name="round" min="1" max="15" value="1"></label>
    <label>Pairings <textarea name="pairings" rows="6"></textarea></label><button class="btn" name="do" value="pairings">Import pairings</button></fieldset>
  <fieldset><legend>Remove an entry</legend>${entries.map((e) => html`<p class="del"><button name="del_entry" value="${e.id}">✕</button> ${e.date} · ${e.store} · <b>${e.player}</b> · ${e.archetype}</p>`)}</fieldset>
  <fieldset><legend>Remove a photo</legend>${photos.map((p) => html`<p class="del"><button name="del_photo" value="${p.id}">✕</button> <a href="/img/${p.id}">#${p.id}</a> ${p.date} · ${p.store} · ${p.caption}</p>`)}</fieldset>
</form></section>
<section class="card narrow"><h2>Counter QR posters</h2>
<p class="muted">Print one per store. Scanning opens the report form with the store filled in and today’s date.</p>
<form method="get" action="/qr"><div class="row"><label>Store <input name="store" required maxlength="60" list="stores"></label><button class="btn">Make poster</button></div></form></section>`);
}

function qrPage(url, origin) {
  const store = (url.searchParams.get('store') ?? '').trim().slice(0, 60);
  if (!store) return fail(400, 'Which store is the poster for?');
  const target = origin + reportLink({ store });
  return page(`QR · ${store}`, '', html`<section class="card narrow poster">
<div class="flag" aria-hidden="true"><i></i><span>✶ ✶ ✶ ✶</span><i></i></div>
<h1>Played Standard tonight?</h1><p>Report your deck and record for the Chicago Standard League.</p>
<div class="qr" data-qr="${target}"></div><p><b>${store}</b><br><small>${target}</small></p>
<p class="noprint"><button class="btn" type="button" onclick="print()">Print</button></p></section>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>`);
}

// ---------- writes ----------
const same = (a, b) => timingSafeEqual(...[a, b].map((s) => createHash('sha256').update(String(s)).digest()));
const text = (form, k, max) => String(form.get(k) ?? '').trim().slice(0, max);
const count = (form, k) => Math.min(15, Math.max(0, parseInt(form.get(k)) || 0));
const clean = (name) => name.trim().replace(/\s+/g, ' ').slice(0, 40);

function eventId(form) {
  const date = text(form, 'date', 10), store = text(form, 'store', 60).replace(/\s+/g, ' ');
  if (!/^\d{4}-\d\d-\d\d$/.test(date) || isNaN(Date.parse(date)) || date > today()) throw 'Pick a valid event date that isn’t in the future.';
  if (!store) throw 'Tell us which store the event was at.';
  // Match an existing store case-insensitively so one typo'd capital doesn't split an event.
  return db.prepare(`INSERT INTO events (date, store, store_key) VALUES (?, ?, ?)
    ON CONFLICT (date, store_key) DO UPDATE SET store = store RETURNING id`)
    .get(date, db.prepare('SELECT store FROM events WHERE store_key = ?').get(key(store))?.store ?? store, key(store)).id;
}

function transaction(work) {
  db.exec('BEGIN');
  try { const out = work(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

async function submittedDeck(form, deckUrl) {
  const file = form.get('deckfile');
  if (file?.size > 20000) throw 'That deck file is too large to be a decklist.';
  const pasted = file?.size ? await file.text() : text(form, 'decklist', 20000);
  const deck = pasted ? parseDeck(pasted) : deckUrl && importable(deckUrl) ? await fetchDeck(deckUrl) : null;
  if (!deck) return null;
  if (!deck.main.length) throw 'No cards recognised in that list. Use one card per line, like “4 Burst Lightning”.';
  return checkDeck(deck, ...(NO_CARD_CHECK ? [async () => null] : []));
}

async function report(form) {
  if (!same(form.get('code'), LEAGUE_CODE)) throw 'That league code isn’t right — it’s pinned in the league Discord.';
  const player = clean(text(form, 'player', 80));
  if (!player) throw 'Add your name.';
  const deckUrl = text(form, 'deck_url', 200);
  if (deckUrl && !/^https:\/\/\S+$/.test(deckUrl)) throw 'Deck link must start with https://';
  const photos = form.getAll('photos').filter((f) => f.size);
  if (photos.length > MAX_PHOTOS) throw `Up to ${MAX_PHOTOS} photos per report.`;
  for (const f of photos) {
    if (!PHOTO_TYPES.includes(f.type)) throw 'Photos must be JPEG, PNG or WebP.';
    if (f.size > MAX_PHOTO) throw 'Each photo must be under 1.5 MB (the form shrinks them automatically when JavaScript is on).';
  }
  const rounds = [];
  for (let i = 0; i < ROUNDS; i++) {
    const opp = text(form, `opp${i}`, 40), result = form.get(`res${i}`);
    if (['W', 'L', 'D'].includes(result)) rounds.push([i, opp ? canon(opp) : 'Unknown', result]);
  }
  const tally = (r) => rounds.filter(([, , x]) => x === r).length;
  const [wins, losses, draws] = rounds.length ? ['W', 'L', 'D'].map(tally) : ['wins', 'losses', 'draws'].map((k) => count(form, k));
  const archetype = text(form, 'archetype', 40);
  const blobs = await Promise.all(photos.map(async (f) => [f.type, new Uint8Array(await f.arrayBuffer())]));
  if (!archetype && !blobs.length) throw 'Add your deck archetype (or at least a photo).';
  const checked = archetype ? await submittedDeck(form, deckUrl) : null;

  return transaction(() => {
    const event = eventId(form);
    if (archetype) {
      const { id } = db.prepare(`INSERT INTO entries (event_id, player, player_key, archetype, wins, losses, draws, deck_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (event_id, player_key) DO UPDATE SET
          archetype = excluded.archetype, deck_url = coalesce(excluded.deck_url, deck_url),
          wins = iif(verified, wins, excluded.wins), losses = iif(verified, losses, excluded.losses), draws = iif(verified, draws, excluded.draws)
        RETURNING id`).get(event, player, key(player), canon(archetype), wins, losses, draws, deckUrl || null);
      // Rounds imported by an organizer outrank a player's own account of them.
      if (!db.prepare('SELECT 1 FROM rounds WHERE entry_id = ? AND verified').get(id)) {
        db.prepare('DELETE FROM rounds WHERE entry_id = ?').run(id);
        for (const r of rounds) db.prepare('INSERT INTO rounds (entry_id, round, opp_archetype, result) VALUES (?, ?, ?, ?)').run(id, ...r);
      }
      if (checked) {
        db.prepare('DELETE FROM cards WHERE entry_id = ?').run(id);
        for (const board of ['main', 'side']) for (const c of checked.deck[board])
          db.prepare('INSERT INTO cards VALUES (?, ?, ?, ?)').run(id, board, c.qty, c.name);
        db.prepare('UPDATE entries SET deck_warnings = ? WHERE id = ?').run(checked.warnings.join('\n') || null, id);
      }
    }
    for (const [mime, data] of blobs) db.prepare('INSERT INTO photos (event_id, caption, mime, data) VALUES (?, ?, ?, ?)').run(event, text(form, 'caption', 100), mime, data);
    return event;
  });
}

function admin(form) {
  if (!same(form.get('code'), ADMIN_CODE)) throw 'Wrong admin code.';
  if (form.get('del_entry')) return db.prepare('DELETE FROM entries WHERE id = ?').run(form.get('del_entry')), '/admin';
  if (form.get('del_photo')) return db.prepare('DELETE FROM photos WHERE id = ?').run(form.get('del_photo')), '/admin';
  const entry = (event, name) => db.prepare(`INSERT INTO entries (event_id, player, player_key, wins, losses, draws) VALUES (?, ?, ?, 0, 0, 0)
    ON CONFLICT (event_id, player_key) DO UPDATE SET player = player RETURNING id`).get(event, clean(name), key(clean(name))).id;

  if (form.get('do') === 'pairings') {
    const rows = parsePairings(text(form, 'pairings', 20000)), round = count(form, 'round') - 1;
    if (!rows.length) throw 'No pairings recognised. Each line needs “Player A vs Player B 2-1” or “Player C bye”.';
    if (round < 0) throw 'Which round is this?';
    return transaction(() => {
      const event = eventId(form), touched = new Set();
      const put = (name, opp, result) => {
        const id = entry(event, name);
        db.prepare('DELETE FROM rounds WHERE entry_id = ? AND (round = ? OR NOT verified)').run(id, round);
        db.prepare('INSERT INTO rounds (entry_id, round, opp_archetype, result, opp_key, verified) VALUES (?, ?, ?, ?, ?, 1)')
          .run(id, round, opp ? 'Unknown' : 'Bye', result, opp ? key(clean(opp)) : null);
        touched.add(id);
      };
      for (const m of rows) {
        put(m.a, m.b, m.result);
        if (m.b) put(m.b, m.a, { W: 'L', L: 'W', D: 'D' }[m.result]);
      }
      const tally = (r) => `(SELECT count(*) FROM rounds WHERE entry_id = ? AND verified AND result = '${r}')`;
      for (const id of touched) db.prepare(`UPDATE entries SET wins = ${tally('W')}, losses = ${tally('L')}, draws = ${tally('D')}, verified = 1 WHERE id = ?`).run(id, id, id, id);
      return `/events/${event}`;
    });
  }

  const rows = parseStandings(text(form, 'standings', 20000));
  if (!rows.length) throw 'No standings rows recognised. Each line needs a name followed by a W-L or W-L-D record.';
  return transaction(() => {
    const event = eventId(form);
    for (const r of rows) db.prepare('UPDATE entries SET wins = ?, losses = ?, draws = ?, verified = 1 WHERE id = ?')
      .run(Math.min(r.wins, 15), Math.min(r.losses, 15), Math.min(r.draws, 15), entry(event, r.player));
    return `/events/${event}`;
  });
}

// ---------- routing ----------
const assets = Object.fromEntries([['/style.css', 'text/css'], ['/app.js', 'text/javascript']]
  .map(([p, type]) => [p, [readFileSync(new URL(`../public${p}`, import.meta.url)), type]]));
const redirect = (to) => new Response(null, { status: 303, headers: { location: to } });

export async function handle(req) {
  const url = new URL(req.url), p = url.pathname;
  if (req.method === 'POST') {
    // ponytail: no rate limit; the league code is the gate. Add one at the ingress if the code leaks.
    if (!(+req.headers.get('content-length') <= MAX_BODY)) return fail(413, 'That upload is too large.');
    try {
      const form = await req.formData();
      if (p === '/report') return redirect(`/events/${await report(form)}`);
      if (p === '/admin') return redirect(admin(form));
    } catch (e) {
      if (typeof e === 'string') return fail(400, e);
      throw e;
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Method not allowed.');
  if (assets[p]) return new Response(assets[p][0], { headers: { 'content-type': assets[p][1], 'cache-control': 'max-age=300' } });
  if (p === '/') return home();
  if (p === '/standings') return standingsPage();
  if (p === '/metagame') return metagamePage(url);
  if (p === '/events') return eventsPage();
  if (p === '/report') return reportPage(url);
  if (p === '/admin') return adminPage();
  if (p === '/qr') return qrPage(url, `${req.headers.get('x-forwarded-proto') ?? 'http'}://${url.host}`);
  if (p === '/rules') return page('Rules', '/rules', new Raw(readFileSync(new URL('../public/rules.html', import.meta.url), 'utf8')));
  if (p === '/healthz') return new Response('ok');
  const m = p.match(/^\/(events|img)\/(\d+)$/);
  if (m?.[1] === 'events') return eventPage(m[2]);
  if (m) {
    const photo = db.prepare('SELECT mime, data FROM photos WHERE id = ?').get(m[2]);
    if (photo) return new Response(photo.data, { headers: { 'content-type': photo.mime, 'cache-control': 'max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
  }
  return fail(404, 'Nothing lives at this address.');
}

// realpath: Node resolves symlinks for the main module, and ConfigMap mounts are symlinks.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  http.createServer(async (req, res) => {
    try {
      const body = req.method === 'POST' ? { body: req, duplex: 'half' } : {};
      const r = await handle(new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { method: req.method, headers: req.headers, ...body }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      console.error(e);
      res.writeHead(500).end('Internal error');
    }
  }).listen(PORT, () => console.log(`Chicago Standard League on http://localhost:${PORT}`));
}
