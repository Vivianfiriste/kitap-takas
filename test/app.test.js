import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

let db, server, base;
before(async () => {
  db = openDb(':memory:');
  server = createApp(db);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });

function client() {
  let cookie = '', csrf = '';
  const send = async (path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET', redirect: 'manual',
      headers: { cookie, ...headers },
      body: body && new URLSearchParams({ _csrf: csrf, ...body }),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
  return {
    send,
    async signup(name) {
      const r = await send('/kayit', { name, email: `${name}@example.com`, password: 'cok-gizli-123' });
      assert.equal(r.status, 303);
      csrf = /name="_csrf" value="([^"]+)"/.exec((await send('/hesabim')).text)[1];
    },
  };
}
const book = { title: 'Calculus', author: 'Stewart', condition: 'İyi' };
const row = (sql, ...a) => db.prepare(sql).get(...a);
const ali = client(), veli = client(), can = client();

async function openSwap() {
  const listing = (await ali.send('/ilan/yeni', book)).location.match(/\d+/)[0];
  await veli.send(`/ilan/${listing}/teklif`, { ...book, title: 'Physics' });
  const offer = row('SELECT MAX(id) id FROM offers').id;
  const r = await ali.send(`/teklif/${offer}/kabul`, {});
  assert.equal(r.status, 303);
  return { listing, offer, swap: r.location.match(/\d+/)[0] };
}

test('kayıt ve giriş', async () => {
  await ali.signup('ali'); await veli.signup('veli'); await can.signup('can');
  const anon = client();
  assert.equal((await anon.send('/kayit', { name: 'x', email: 'ALI@example.com', password: 'cok-gizli-123' })).status, 400);
  assert.equal((await anon.send('/giris', { email: 'ali@example.com', password: 'yanlis' })).status, 400);
  assert.equal((await anon.send('/giris', { email: 'ali@example.com', password: 'cok-gizli-123' })).status, 303);
  assert.equal((await client().send('/hesabim')).location, '/giris');
  assert.ok(!row('SELECT password_hash h FROM users').h.includes('gizli'));
});

test('tam takas akışı ve yetkiler', async () => {
  const { listing, offer, swap } = await openSwap();
  assert.equal((await can.send(`/takas/${swap}`)).status, 404);
  assert.equal((await can.send(`/takas/${swap}/biraktim`, {})).status, 404);
  assert.equal((await veli.send(`/teklif/${offer}/kabul`, {})).status, 404);
  assert.equal((await can.send(`/ilan/${listing}/teklif`, book)).status, 400);
  assert.equal((await ali.send(`/takas/${swap}/aldim`, {})).status, 400);
  await ali.send(`/takas/${swap}/biraktim`, {});
  assert.equal((await ali.send(`/takas/${swap}/aldim`, {})).status, 400);
  assert.equal((await veli.send(`/takas/${swap}/iptal`, {})).status, 400);
  await veli.send(`/takas/${swap}/biraktim`, {});
  await ali.send(`/takas/${swap}/aldim`, {});
  assert.equal(row('SELECT status s FROM swaps WHERE id = ?', swap).s, 'active');
  await veli.send(`/takas/${swap}/aldim`, {});
  assert.equal(row('SELECT status s FROM swaps WHERE id = ?', swap).s, 'completed');
  assert.equal(row('SELECT status s FROM listings WHERE id = ?', listing).s, 'completed');
});

test('iptal ilanı yeniden açar, diğer teklifler korunur', async () => {
  const listing = (await ali.send('/ilan/yeni', book)).location.match(/\d+/)[0];
  await veli.send(`/ilan/${listing}/teklif`, book);
  const first = row('SELECT MAX(id) id FROM offers').id;
  await can.send(`/ilan/${listing}/teklif`, book);
  const second = row('SELECT MAX(id) id FROM offers').id;
  const swap = (await ali.send(`/teklif/${first}/kabul`, {})).location.match(/\d+/)[0];
  await veli.send(`/takas/${swap}/iptal`, {});
  assert.equal(row('SELECT status s FROM listings WHERE id = ?', listing).s, 'open');
  assert.equal(row('SELECT status s FROM offers WHERE id = ?', second).s, 'pending');
});

test('kendi ilanına ve mükerrer teklif engellenir', async () => {
  const listing = (await ali.send('/ilan/yeni', book)).location.match(/\d+/)[0];
  assert.equal((await ali.send(`/ilan/${listing}/teklif`, book)).status, 400);
  assert.equal((await veli.send(`/ilan/${listing}/teklif`, book)).status, 303);
  assert.equal((await veli.send(`/ilan/${listing}/teklif`, book)).status, 400);
  assert.ok(!(await can.send(`/ilan/${listing}`)).text.includes('veli'));
});

test('dolu kutular yeni takasa verilmez', async () => {
  db.exec("UPDATE boxes SET active = 0 WHERE id > 2");
  const first = await openSwap();
  const listing = (await ali.send('/ilan/yeni', book)).location.match(/\d+/)[0];
  await veli.send(`/ilan/${listing}/teklif`, book);
  const offer = row('SELECT MAX(id) id FROM offers').id;
  assert.equal((await ali.send(`/teklif/${offer}/kabul`, {})).status, 400);
  await veli.send(`/takas/${first.swap}/iptal`, {});
  assert.equal((await ali.send(`/teklif/${offer}/kabul`, {})).status, 303);
  db.exec("UPDATE boxes SET active = 1");
});

test('sorun bildirimi, yönetici ve engelleme', async () => {
  const { swap } = await openSwap();
  await veli.send(`/takas/${swap}/sorun`, { note: 'kutu bozuk' });
  assert.equal((await ali.send(`/takas/${swap}/biraktim`, {})).status, 400);
  assert.equal((await can.send('/yonetim')).status, 403);
  db.exec("UPDATE users SET is_admin = 1 WHERE name = 'can'");
  assert.equal((await can.send('/yonetim')).status, 200);
  await can.send(`/yonetim/takas/${swap}`, { action: 'resume' });
  assert.equal((await ali.send(`/takas/${swap}/biraktim`, {})).status, 303);
  await can.send(`/yonetim/kullanici/${row("SELECT id FROM users WHERE name='veli'").id}`, { banned: '1' });
  assert.equal((await veli.send('/hesabim')).location, '/giris');
});

test('XSS, CSRF, arama', async () => {
  await ali.send('/ilan/yeni', { ...book, title: '<script>alert(1)</script>' });
  await ali.send('/ilan/yeni', { ...book, title: 'İNCE MEMED', author: 'Yaşar Kemal' });
  const home = (await client().send('/')).text;
  assert.ok(!home.includes('<script>') && home.includes('&lt;script&gt;'));
  assert.ok((await client().send(`/?q=${encodeURIComponent('ince memed')}`)).text.includes('İNCE MEMED'));
  assert.equal((await ali.send('/ilan/yeni', { ...book, _csrf: 'sahte' })).status, 403);
  assert.equal((await ali.send('/ilan/yeni', book, { origin: 'https://kotu.example' })).status, 403);
});

test('engellenen kullanıcının ilanı takas iptalinde yeniden açılmaz', async () => {
  const owner = client(), other = client();
  await owner.signup('ece'); await other.signup('efe');
  const listing = (await owner.send('/ilan/yeni', book)).location.match(/\d+/)[0];
  await other.send(`/ilan/${listing}/teklif`, book);
  const swap = (await owner.send(`/teklif/${row('SELECT MAX(id) id FROM offers').id}/kabul`, {})).location.match(/\d+/)[0];
  await can.send(`/yonetim/kullanici/${row("SELECT id FROM users WHERE name='ece'").id}`, { banned: '1' });
  await can.send(`/yonetim/takas/${swap}`, { action: 'cancel' });
  assert.equal(row('SELECT status s FROM listings WHERE id = ?', listing).s, 'cancelled');
});
