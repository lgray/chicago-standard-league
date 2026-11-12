// Pure league math: no I/O, covered by test/lib.test.js.

export const SEASONS = [
  { name: 'Season 0 · Autumn 2026', start: '2026-09-01', end: '2026-12-31' },
];

export const seasonFor = (date) =>
  SEASONS.findLast((s) => s.start <= date) ?? SEASONS[0];

export const key = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

// Wilson score interval: stays inside [0,1] and is honest at the tiny sample sizes a local league has.
export function wilson(wins, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = wins / n, z2 = z * z;
  const mid = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return [(mid - half) / (1 + z2 / n), (mid + half) / (1 + z2 / n)];
}

const points = (e) => 3 * e.wins + e.draws;

// League points = sum of match points over a player's best `best` events (Chicago Pauper League rule).
export function standings(entries, best = 5) {
  const players = new Map();
  for (const e of entries) {
    const k = key(e.player);
    const p = players.get(k) ?? { player: e.player, events: [], wins: 0, losses: 0, draws: 0, decks: {} };
    p.events.push(points(e));
    p.wins += e.wins; p.losses += e.losses; p.draws += e.draws;
    p.decks[e.archetype] = (p.decks[e.archetype] ?? 0) + 1;
    players.set(k, p);
  }
  return [...players.values()]
    .map((p) => ({
      player: p.player,
      points: p.events.sort((a, b) => b - a).slice(0, best).reduce((a, b) => a + b, 0),
      events: p.events.length,
      wins: p.wins, losses: p.losses, draws: p.draws,
      winRate: p.wins + p.losses ? p.wins / (p.wins + p.losses) : 0,
      deck: Object.entries(p.decks).sort((a, b) => b[1] - a[1])[0][0],
    }))
    .sort((a, b) => b.points - a.points || b.events - a.events || b.winRate - a.winRate);
}

export function metagame(entries) {
  const decks = new Map();
  for (const e of entries) {
    const d = decks.get(e.archetype) ?? { name: e.archetype, n: 0, wins: 0, losses: 0, draws: 0 };
    d.n++; d.wins += e.wins; d.losses += e.losses; d.draws += e.draws;
    decks.set(e.archetype, d);
  }
  return [...decks.values()]
    .map((d) => {
      const games = d.wins + d.losses;
      const [lo, hi] = wilson(d.wins, games);
      return { ...d, share: d.n / entries.length, winRate: games ? d.wins / games : null, lo, hi };
    })
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

// Both players may report the same match. Within one event and round, each real match yields at most one
// report per side, so per pairing the match count is the larger of the two sides' counts, not their sum.
export function matrix(rounds) {
  const groups = new Map();
  for (const r of rounds) {
    if (r.result === 'D' || r.a === r.b) continue;
    const flip = r.a > r.b, [x, y] = flip ? [r.b, r.a] : [r.a, r.b];
    const k = JSON.stringify([r.event, r.round, x, y]);
    const g = groups.get(k) ?? { x, y, own: [0, 0], opp: [0, 0] }; // [x wins, x losses] as told by x / by y
    (flip ? g.opp : g.own)[(r.result === 'W') === flip ? 1 : 0]++;
    groups.set(k, g);
  }
  const cells = new Map();
  const add = (a, b, wins, losses) => {
    const c = cells.get(`${a}|${b}`) ?? { wins: 0, losses: 0 };
    c.wins += wins; c.losses += losses;
    cells.set(`${a}|${b}`, c);
  };
  for (const g of groups.values()) {
    const wins = Math.max(g.own[0], g.opp[0]), losses = Math.max(g.own[1], g.opp[1]);
    add(g.x, g.y, wins, losses); add(g.y, g.x, losses, wins);
  }
  return cells;
}

// Lenient parser for standings pasted from EventLink/Companion or typed by a TO:
// "[rank] Name [points] W-L[-D] ...anything".
export function parseStandings(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:\d+[.)]?\s+)?(\S.*?)\s+(?:\d+\s+)?(\d+)\s*[-–/]\s*(\d+)(?:\s*[-–/]\s*(\d+))?/);
    if (m) out.push({ player: m[1].trim(), wins: +m[2], losses: +m[3], draws: +(m[4] ?? 0) });
  }
  return out;
}

// One match per line: "[table] Player A vs Player B 2-1" (games for A, then B) or "Player C bye".
export function parsePairings(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^(?:table\s*)?\d+[.):]?\s+/i, '');
    let m = line.match(/^(.+?)\s+(?:vs?\.?|\|)\s+(.+?)\s+(\d)\s*[-–]\s*(\d)(?:\s*[-–]\s*\d)?$/i);
    if (m) out.push({ a: m[1].trim(), b: m[2].trim(), result: +m[3] > +m[4] ? 'W' : +m[3] < +m[4] ? 'L' : 'D' });
    else if ((m = line.match(/^(.+?)\s+(?:vs?\.?\s+)?\W*bye\W*$/i))) out.push({ a: m[1].trim(), b: null, result: 'W' });
  }
  return out;
}
