import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeck, formatDeck, importable, checkDeck, SITES } from '../src/decks.js';
import { parsePairings } from '../src/lib.js';

test('parseDeck: Arena export with sections, set codes and a companion', () => {
  const d = parseDeck('About\nName Test\n\nCompanion\n1 Jegantha, the Wellspring (IKO) 222\n\nDeck\n4 Burst Lightning (FDN) 192\n4x Fire / Ice\n20 Mountain (FDN) 279 *F*\n\nSideboard (3)\n2 Negate (FDN) 710\n1 Jegantha, the Wellspring (IKO) 222\n');
  assert.deepEqual(d.main, [{ qty: 4, name: 'Burst Lightning' }, { qty: 4, name: 'Fire // Ice' }, { qty: 20, name: 'Mountain' }]);
  assert.deepEqual(d.side, [{ qty: 2, name: 'Negate' }, { qty: 1, name: 'Jegantha, the Wellspring' }]);
  assert.equal(d.skipped, 0);
});

test('parseDeck: headerless list uses the blank line and SB: prefix, merges duplicates, counts junk', () => {
  const d = parseDeck('3 Opt\n1 opt\nthis is not a card\n\n2 Duress\nSB: 1 Negate');
  assert.deepEqual(d.main, [{ qty: 4, name: 'opt' }]);
  assert.deepEqual(d.side, [{ qty: 2, name: 'Duress' }, { qty: 1, name: 'Negate' }]);
  assert.equal(d.skipped, 1);
  assert.equal(formatDeck(d), '4 opt\n\nSideboard\n2 Duress\n1 Negate');
});

test('parseDeck: Archidekt export decorations are stripped', () => {
  assert.deepEqual(parseDeck('1x Llanowar Elves (fdn) 227 [Ramp] ^Have,#37d67a^').main, [{ qty: 1, name: 'Llanowar Elves' }]);
});

test('importable recognises only supported deck sites', () => {
  assert.ok(importable('https://archidekt.com/decks/123456/my-deck'));
  assert.ok(!importable('https://www.moxfield.com/decks/aBc-123_x'));
  assert.ok(!importable('https://www.mtggoldfish.com/deck/123'));
  assert.ok(!importable('https://evil.example/?u=moxfield.com/users/x'));
});

test('Archidekt payload: sideboard split out, maybeboard dropped, null categories tolerated', () => {
  const card = (name, quantity, categories) => ({ quantity, categories, card: { oracleCard: { name } } });
  const deck = SITES.find((s) => s.name === 'Archidekt').read({
    categories: [{ name: 'Maybeboard', includedInDeck: false }, { name: 'Sideboard', includedInDeck: true }, { name: 'Burn', includedInDeck: true }],
    cards: [card('Shock', 4, ['Burn']), card('Mountain', 20, null), card('Negate', 2, ['Sideboard']), card('Opt', 1, ['Maybeboard'])],
  });
  assert.deepEqual(deck.main.map((c) => [c.qty, c.name]), [[4, 'Shock'], [20, 'Mountain']]);
  assert.deepEqual(deck.side.map((c) => [c.qty, c.name]), [[2, 'Negate']]);
});

test('checkDeck: fixes spelling, flags unknown, illegal, oversize and undersize', async () => {
  const card = (name, standard = 'legal', type_line = 'Instant') => ({ name, legalities: { standard }, type_line });
  const lookup = async () => new Map([['opt', card('Opt')], ['black lotus', card('Black Lotus', 'not_legal', 'Artifact')], ['mountain', card('Mountain', 'legal', 'Basic Land — Mountain')]]);
  const { deck, warnings } = await checkDeck({ main: [{ qty: 5, name: 'opt' }, { qty: 1, name: 'black lotus' }, { qty: 30, name: 'mountain' }, { qty: 1, name: 'Nonsense' }], side: [{ qty: 16, name: 'Opt' }], skipped: 2 }, lookup);
  assert.deepEqual(deck.main.map((c) => c.name), ['Opt', 'Black Lotus', 'Mountain', 'Nonsense']);
  assert.deepEqual(warnings, ['Unrecognised: nonsense', 'Not Standard legal: Black Lotus', 'More than 4 copies: Opt',
    'Main deck has 37 cards (60 minimum)', 'Sideboard has 16 cards (15 maximum)', '2 line(s) couldn’t be read']);
});

test('checkDeck: a clean deck has no warnings, and a failed lookup still accepts the deck', async () => {
  const main = [{ qty: 60, name: 'Mountain' }];
  const ok = await checkDeck({ main, side: [], skipped: 0 }, async () => new Map([['mountain', { name: 'Mountain', legalities: { standard: 'legal' }, type_line: 'Basic Land' }]]));
  assert.deepEqual(ok.warnings, []);
  const down = await checkDeck({ main, side: [], skipped: 0 }, async () => null);
  assert.deepEqual([down.warnings, down.deck.main], [[], main]);
});

test('parsePairings: table numbers, game scores, draws, byes, junk', () => {
  assert.deepEqual(parsePairings('Table Players Result\n1 Jane Q. Doe vs Bob Smith 2-1\nTable 2: Ann v. Cy 0–2\nDee | Eve 1-1-1\n4 Fay bye\nGus vs *** BYE ***\nnothing here'), [
    { a: 'Jane Q. Doe', b: 'Bob Smith', result: 'W' }, { a: 'Ann', b: 'Cy', result: 'L' }, { a: 'Dee', b: 'Eve', result: 'D' },
    { a: 'Fay', b: null, result: 'W' }, { a: 'Gus', b: null, result: 'W' }]);
});
