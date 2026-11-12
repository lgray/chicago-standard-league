import test from 'node:test';
import assert from 'node:assert/strict';
import { wilson, standings, metagame, matrix, parseStandings } from '../src/lib.js';

const e = (player, archetype, wins, losses, draws = 0) => ({ player, archetype, wins, losses, draws });

test('wilson interval brackets the point estimate and narrows with n', () => {
  const [lo, hi] = wilson(6, 10);
  assert.ok(lo < 0.6 && 0.6 < hi);
  assert.ok(Math.abs(lo - 0.3127) < 1e-3 && Math.abs(hi - 0.8318) < 1e-3);
  const [lo2, hi2] = wilson(600, 1000);
  assert.ok(hi2 - lo2 < hi - lo);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

test('standings count only the best 5 events and merge name casing', () => {
  const six = [3, 3, 3, 3, 3, 0].map((w) => e('Ana', 'Deck A', w, 3 - w));
  const rows = standings([...six, e('ana ', 'Deck B', 1, 0, 1), e('Bo', 'Deck B', 4, 0)]);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].player, rows[0].points, rows[0].events, rows[0].deck], ['Ana', 45, 7, 'Deck A']);
  assert.equal(rows[1].points, 12);
});

test('metagame share and win rate', () => {
  const m = metagame([e('a', 'X', 3, 1), e('b', 'X', 1, 3), e('c', 'Y', 2, 0, 1)]);
  assert.deepEqual([m[0].name, m[0].n, m[0].winRate], ['X', 2, 0.5]);
  assert.ok(Math.abs(m[0].share - 2 / 3) < 1e-9);
  assert.equal(m[1].winRate, 1);
});

test('matrix dedupes two-sided reports per event round, skips draws and mirrors', () => {
  const r = (event, round, a, b, result) => ({ event, round, a, b, result });
  const c = matrix([
    r(1, 0, 'X', 'Y', 'W'), r(1, 0, 'Y', 'X', 'L'), // one match, reported by both sides
    r(1, 1, 'Y', 'X', 'W'),                         // reported by Y only
    r(2, 0, 'X', 'Y', 'W'), r(2, 0, 'X', 'Y', 'W'), r(2, 0, 'Y', 'X', 'L'), // two matches, three reports
    r(2, 1, 'X', 'Y', 'D'), r(2, 1, 'X', 'X', 'W'),
  ]);
  assert.deepEqual(c.get('X|Y'), { wins: 3, losses: 1 });
  assert.deepEqual(c.get('Y|X'), { wins: 1, losses: 3 });
  assert.equal(c.has('X|X'), false);
});

test('parseStandings handles rank, points column, tabs, and junk lines', () => {
  const text = 'Rank Name Points Record OMW%\n1 Jane Q. Doe 9 3-0-0 66.7%\n2.\tBob Smith\t7\t2-0-1\nCarl 1-2\n\nnot a row';
  assert.deepEqual(parseStandings(text), [
    { player: 'Jane Q. Doe', wins: 3, losses: 0, draws: 0 },
    { player: 'Bob Smith', wins: 2, losses: 0, draws: 1 },
    { player: 'Carl', wins: 1, losses: 2, draws: 0 },
  ]);
});
