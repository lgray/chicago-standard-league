// Fills an empty database with clearly-fake demo data by driving the real request handler.
// Usage: LEAGUE_CODE=x ADMIN_CODE=y DATA_DIR=./data node seed.js
import { execFileSync } from 'node:child_process';
process.env.NO_CARD_CHECK = '1'; // demo lists below already use exact card names
const { handle, db } = await import('./src/server.js');

if (db.prepare('SELECT count(*) n FROM events').get().n) throw new Error('Database is not empty; refusing to seed.');

let s = 20261111; // mulberry32: deterministic so the demo looks the same every time
const rnd = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const shuffle = (xs) => xs.map((x) => [rnd(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

const STORES = ['North Side Games (demo)', 'Loop Card Shop (demo)', 'Pilsen Game Café (demo)'];
const DECKS = [['Izzet Prowess', 6, .06], ['Dimir Midrange', 5, .04], ['Jund Sacrifice', 4, .02], ['Mono-Red Aggro', 4, 0], ['Azorius Control', 3, -.01],
  ['Golgari Midrange', 3, .01], ['Selesnya Lifegain', 2, -.03], ['Boros Dwarves', 2, -.02], ['Four-Color Reanimator', 1, -.06], ['Mono-Green Landfall', 1, -.04]];
const four = (names) => names.split('|').map((n) => `4 ${n}`);
const LISTS = {
  'Mono-Red Aggro': [...four('Burst Lightning|Shock|Boltwave|Hired Claw|Emberheart Challenger|Manifold Mouse|Fear of Missing Out|Stadium Headliner'), '28 Mountain', '', 'Sideboard', '4 Lightning Helix'],
  'Azorius Control': [...four('Think Twice|Negate|Essence Scatter|Day of Judgment|Three Steps Ahead|Get Lost|No More Lies|Stock Up'), '3 Elspeth, Storm Slayer', '2 Fountainport', '12 Island', '11 Plains', '', 'Sideboard', '3 Duress'],
  'Golgari Midrange': [...four('Llanowar Elves|Mosswood Dreadknight|Duress|Bitter Triumph|Preacher of the Schism|Deep-Cavern Bat|Maelstrom Pulse|Bushwhack'), '14 Forest', '14 Swamp'],
  'Izzet Prowess': [...four('Opt|Sleight of Hand|Into the Flood Maw|Spell Pierce|Burst Lightning|Shock|Stock Up|Emberheart Challenger|Manifold Mouse'), '12 Island', '12 Mountain', '', 'Sideboard', '3 Negate'],
  'Dimir Midrange': [...four('Deep-Cavern Bat|Preacher of the Schism|Duress|Bitter Triumph|Negate|Essence Scatter|Three Steps Ahead|Stock Up|Opt'), '12 Island', '12 Swamp'],
};
const PLAYERS = 'Alex R,Bianca T,Carlos M,Dana K,Eli W,Farah S,Gus P,Hana L,Ivan D,Jo N,Kira V,Luis G,Maya B,Nate O,Omar H,Priya C,Quinn A,Rosa J,Sam F,Tess Y,Uma Z,Vik E,Wes Q,Xin I,Yara U,Zeke X'
  .split(',').map((name) => ({ name, deck: pick(DECKS.flatMap((d) => Array(d[1]).fill(d))) }));

const post = async (path, fields) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, x);
  const enc = new Response(body), buf = await enc.arrayBuffer();
  const res = await handle(new Request(`http://seed${path}`, { method: 'POST', body: buf,
    headers: { 'content-type': enc.headers.get('content-type'), 'content-length': String(buf.byteLength) } }));
  if (res.status !== 303) throw new Error(`${path} -> ${res.status}: ${(await res.text()).match(/<p>(.*?)<\/p>/)?.[1]}`);
};

const photo = (label, hue) => {
  try {
    const jpg = execFileSync('magick', ['-size', '1200x900', `gradient:hsl(${hue},160,90)-hsl(${hue + 40},120,40)`, '-gravity', 'center',
      '-fill', 'white', '-pointsize', '64', '-annotate', '0', `demo photo\n${label}`, 'jpg:-'], { maxBuffer: 1e7 });
    return new File([jpg], 'demo.jpg', { type: 'image/jpeg' });
  } catch { return null; } // no ImageMagick: seed without photos
};

for (let week = 0; week < 9; week++) {
  const date = new Date(Date.UTC(2026, 8, 10 + 7 * week)).toISOString().slice(0, 10), store = STORES[week % 3];
  const field = shuffle(PLAYERS).slice(0, 8 + Math.floor(rnd() * 7)).map((p) => ({ ...p, deck: rnd() < .15 ? pick(DECKS) : p.deck, rounds: [] }));
  const pairings = [];
  for (let round = 0; round < 3; round++) {
    const order = shuffle(field), lines = [];
    pairings.push(lines);
    if (order.length % 2) lines.push(`${order.at(-1).name} bye`);
    for (let i = 0; i + 1 < order.length; i += 2) {
      const [a, b] = [order[i], order[i + 1]];
      const won = rnd() < .5 + a.deck[2] - b.deck[2];
      a.rounds.push([b.deck[0], won ? 'W' : 'L']); b.rounds.push([a.deck[0], won ? 'L' : 'W']);
      lines.push(`${i / 2 + 1} ${a.name} vs ${b.name} ${won ? '2-1' : '0-2'}`);
    }
  }
  for (const [i, p] of field.entries()) {
    const fields = { code: process.env.LEAGUE_CODE, date, store, player: p.name, archetype: p.deck[0] };
    if (rnd() < .75) p.rounds.forEach(([opp, res], r) => Object.assign(fields, { [`opp${r}`]: opp, [`res${r}`]: res }));
    else Object.assign(fields, { wins: p.rounds.filter((r) => r[1] === 'W').length, losses: p.rounds.filter((r) => r[1] === 'L').length });
    if (LISTS[p.deck[0]] && rnd() < .7) fields.decklist = LISTS[p.deck[0]].join('\n');
    const pic = i === 0 && week > 2 ? photo(`${store}`, week * 40) : null;
    if (pic) Object.assign(fields, { photos: pic, caption: `${p.name}'s ${p.deck[0]}` });
    await post('/report', fields);
  }
  if (week % 4 === 3) for (const [round, lines] of pairings.entries())
    await post('/admin', { code: process.env.ADMIN_CODE, do: 'pairings', date, store, round: String(round + 1), pairings: lines.join('\n') });
  else if (week % 2) await post('/admin', { code: process.env.ADMIN_CODE, do: 'standings', date, store,
    standings: field.map((p, i) => `${i + 1} ${p.name} ${p.rounds.filter((r) => r[1] === 'W').length}-${p.rounds.filter((r) => r[1] === 'L').length}-0`).join('\n') });
}
console.log('Seeded', db.prepare('SELECT (SELECT count(*) FROM events) events, (SELECT count(*) FROM entries) entries, (SELECT count(*) FROM rounds) rounds, (SELECT count(*) FROM photos) photos, (SELECT count(DISTINCT entry_id) FROM cards) decklists, (SELECT count(*) FROM rounds WHERE verified) verified_rounds').get());
