import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const ADMIN = 'admin-code-for-tests', SERVER = new URL('../src/server.js', import.meta.url).href;
const dataDir = () => mkdtempSync(`${tmpdir()}/csl-test-`);
Object.assign(process.env, { LEAGUE_CODE: 'league', ADMIN_CODE: ADMIN, NO_CARD_CHECK: '1', DATA_DIR: dataDir() });

// A database whose photos table predates AUTOINCREMENT, so importing the server runs the migration.
const old = new DatabaseSync(`${process.env.DATA_DIR}/league.db`);
old.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, date TEXT NOT NULL, store TEXT NOT NULL, store_key TEXT NOT NULL, UNIQUE (date, store_key));
  CREATE TABLE photos (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, caption TEXT, mime TEXT NOT NULL, data BLOB NOT NULL);
  INSERT INTO events VALUES (1, '2026-11-01', 'Old Store', 'old store');
  INSERT INTO photos VALUES (7, 1, 'kept', 'image/jpeg', x'ffd8ff')`);
old.close();

const { handle, listener, db } = await import(SERVER);

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const report = { code: 'league', date: '2026-11-10', store: 'Test Store', player: 'Tester', archetype: 'Izzet Prowess' };

const encode = async (fields) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const enc = new Response(body);
  return { type: enc.headers.get('content-type'), bytes: await enc.arrayBuffer() };
};
const post = async (path, fields) => {
  const { type, bytes } = await encode(fields);
  return handle(new Request(`http://test${path}`, { method: 'POST', body: bytes, headers: { 'content-type': type, 'content-length': String(bytes.byteLength) } }));
};
const get = (path, headers = {}) => handle(new Request(`http://test${path}`, { headers }));
const photoCount = () => db.prepare('SELECT count(*) n FROM photos').get().n;

test('POST body cap counts the bytes read, with or without an honest content-length', async () => {
  const { type, bytes } = await encode({ code: 'league', pad: 'x'.repeat(9e6) });
  const stream = () => new Response(bytes).body;
  for (const headers of [{ 'content-type': type }, { 'content-type': type, 'content-length': '10' }]) {
    const res = await handle(new Request('http://test/report', { method: 'POST', body: stream(), duplex: 'half', headers }));
    assert.equal(res.status, 413);
  }
  assert.equal((await post('/report', { code: 'wrong', pad: 'x'.repeat(1e6) })).status, 400); // under the cap: reaches the code check
});

test('a body that is not a form is a 400 page, not an exception', async () => {
  for (const [type, body] of [['application/json', '{}'], ['multipart/form-data; boundary=x', 'garbage'], [null, null]]) {
    const res = await handle(new Request('http://test/report', { method: 'POST', body, headers: type ? { 'content-type': type, 'content-length': String(body.length) } : {} }));
    assert.equal(res.status, 400);
  }
});

test('every response forbids inline script, framing and sniffing', async () => {
  for (const res of [await get('/'), await get('/nope'), await get('/style.css'), await post('/report', { code: 'wrong' })]) {
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' https:\/\/cdnjs\.cloudflare\.com\/\S+qrcode\.min\.js;/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'same-origin');
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000');
  }
});

test('no page relies on inline script, and the CDN script is integrity-pinned', async () => {
  for (const path of ['/', '/report', '/admin', '/nope', '/qr?store=A']) {
    const page = await (await get(path)).text();
    assert.doesNotMatch(page, /javascript:|\son\w+=|<script(?![^>]*\ssrc=)/i, path);
  }
  assert.match(await (await get('/qr?store=A')).text(), /<script src="https:\/\/cdnjs[^"]+" integrity="sha512-[^"]{88}" crossorigin="anonymous">/);
});

test('a photo is typed by its bytes, not by the label the uploader sent', async () => {
  const before = photoCount();
  const html = await post('/report', { ...report, photos: new File(['<html><script>alert(1)</script>'], 'a.png', { type: 'image/png' }) });
  assert.equal(html.status, 400);
  assert.equal(photoCount(), before);
  const ok = await post('/report', { ...report, photos: new File([PNG], 'a.jpg', { type: 'image/jpeg' }) });
  assert.equal(ok.status, 303);
  const { id, mime } = db.prepare('SELECT id, mime FROM photos ORDER BY id DESC LIMIT 1').get();
  assert.equal(mime, 'image/png');
  assert.equal((await get(`/img/${id}`)).headers.get('content-type'), 'image/png');
  assert.equal((await post('/report', { ...report, photos: new File([JPEG], 'a', { type: 'application/octet-stream' }) })).status, 303);
});

test('QR poster origin is http or https whatever the forwarded header says', async () => {
  const target = async (proto) => (await (await get('/qr?store=A', { 'x-forwarded-proto': proto })).text()).match(/data-qr="([^"]*)"/)[1];
  assert.equal(await target('javascript'), 'http://test/report?store=A');
  assert.equal(await target('https, http'), 'https://test/report?store=A');
  assert.equal(await target('https'), 'https://test/report?store=A');
});

test('stored text is escaped on every page that shows it', async () => {
  const x = `<img src=x onerror=alert(1)>"'`;
  const res = await post('/report', { code: 'league', date: '2026-11-09', store: `S${x}`, player: `P${x}`, archetype: `A${x}`, caption: `C${x}`,
    opp0: `O${x}`, res0: 'W', decklist: `4 N${x}\n56 Mountain`, deck_url: `https://deck.test/${x}`.replace(/ /g, ''), photos: new File([JPEG], 'a.jpg', { type: 'image/jpeg' }) });
  assert.equal(res.status, 303);
  for (const path of ['/', '/standings', '/metagame?range=all', '/events', res.headers.get('location'), '/admin', `/report?store=${encodeURIComponent(x)}&player=${encodeURIComponent(x)}`, `/qr?store=${encodeURIComponent(x)}`]) {
    const page = await (await get(path)).text();
    assert.doesNotMatch(page, /<img src=x|"\s*onerror=/, path);
    assert.match(page, /&#60;img/, path);
  }
});

test('a removed photo’s id is never handed out again, also in a database from before that rule', async () => {
  assert.equal(db.prepare('SELECT caption FROM photos WHERE id = 7').get().caption, 'kept');
  const add = async () => {
    await post('/report', { ...report, photos: new File([JPEG], 'a.jpg') });
    return db.prepare('SELECT max(id) id FROM photos').get().id;
  };
  const removed = await add();
  assert.equal((await post('/admin', { code: ADMIN, del_photo: String(removed) })).status, 303);
  assert.equal((await get(`/img/${removed}`)).status, 404);
  assert.ok(await add() > removed);
});

test('an event date has to exist on the calendar', async () => {
  assert.equal((await post('/report', { ...report, date: '2026-02-31' })).status, 400);
  assert.equal((await post('/report', { ...report, date: '2026-02-28' })).status, 303);
});

test('the server will not start with a short admin code or one shared with the league', () => {
  const start = (codes) => spawnSync(process.execPath, ['--input-type=module', '-e', `await import('${SERVER}')`],
    { env: { ...process.env, DATA_DIR: dataDir(), ...codes }, encoding: 'utf8' });
  for (const codes of [{ ADMIN_CODE: 'elevenchars' }, { LEAGUE_CODE: ADMIN, ADMIN_CODE: ADMIN }]) {
    const run = start(codes);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /ADMIN_CODE must be at least 12 characters and differ/);
  }
  assert.equal(start({ ADMIN_CODE: 'twelve-chars' }).status, 0);
});

test('a request the web Request type cannot express is a 400, not a 500', async () => {
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const statusLine = (head) => new Promise((done) => {
    let out = '';
    const socket = net.connect(server.address().port, '127.0.0.1', () => socket.write(`${head}\r\nConnection: close\r\n\r\n`));
    socket.on('data', (d) => { out += d; });
    socket.on('end', () => done(out.split('\r\n')[0]));
  });
  assert.equal(await statusLine('TRACE / HTTP/1.1\r\nHost: t'), 'HTTP/1.1 400 Bad Request');
  assert.equal(await statusLine('GET / HTTP/1.1\r\nHost: a b'), 'HTTP/1.1 400 Bad Request');
  assert.equal(await statusLine('GET /healthz HTTP/1.1\r\nHost: t'), 'HTTP/1.1 200 OK');
  const body = new FormData();
  body.append('code', 'wrong');
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/report`, { method: 'POST', body })).status, 400);
  server.close();
});
