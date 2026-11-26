
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { openDb } from './db.js';
import * as auth from './auth.js';
import * as t from './takas.js';
import * as view from './views.js';

const CSS = readFileSync(new URL('../public/style.css', import.meta.url));
const PRODUCTION = process.env.NODE_ENV === 'production';

const NOTICES = {
  kayit: 'Hesabın oluşturuldu.',
  ilan: 'İlanın yayınlandı.',
  teklif: 'Teklifin gönderildi.',
  kabul: 'Teklif kabul edildi. Kutular ayrıldı.',
  tamam: 'İşlem kaydedildi.',
  sifre: 'Şifren değişti. Yeni şifrenle giriş yap.',
};

// Turso sorgu yardımcıları
async function rows(db, sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows;
}

async function first(db, sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows[0] ?? null;
}

// Basit hız sınırı (bellekte tutulur, tek sunucu için).
function rateLimiter() {
  const hits = new Map();

  return (key, max, windowMs) => {
    const now = Date.now();

    if (hits.size > 10000) {
      for (const [k, h] of hits) {
        if (h.until < now) hits.delete(k);
      }
    }

    let h = hits.get(key);

    if (!h || h.until < now) {
      hits.set(key, h = { n: 0, until: now + windowMs });
    }

    if (++h.n > max) {
      throw new t.UserError(
        'Çok fazla deneme yaptın. Biraz sonra tekrar dene.',
        429
      );
    }
  };
}

async function readForm(req) {
  let size = 0;
  const chunks = [];

  for await (const chunk of req) {
    size += chunk.length;

    if (size > 20000) {
      throw new t.UserError('Gönderilen veri çok büyük.', 413);
    }

    chunks.push(chunk);
  }

  return Object.fromEntries(
    new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
  );
}

const sameText = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));

  return x.length === y.length && timingSafeEqual(x, y);
};

const safeNext = (n) =>
  /^\/ilan\/\d+$/.test(n ?? '') ? n : '/hesabim';

const cookie = (value, maxAge) =>
  `oturum=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PRODUCTION ? '; Secure' : ''}`;

export function createApp(db) {
  const limit = rateLimiter();
  const routes = [];

  const add = (method) => (pattern, handler, access = 'public') =>
    routes.push({
      method,
      re: new RegExp(`^${pattern.replaceAll(':id', '(\\d{1,12})')}$`),
      handler,
      access
    });

  const get = add('GET');
  const post = add('POST');

  const startSession = async (c, userId, to) => {
    const token = await auth.createSession(db, userId);
    c.redirect(to, cookie(token, auth.SESSION_DAYS * 86400));
  };

  // Ana sayfa
  get('/', async (c) => {
    const q = (c.query.get('q') ?? '').slice(0, 100).trim();
    const page = Math.max(
      1,
      Math.min(10000, parseInt(c.query.get('sayfa'), 10) || 1)
    );

    const norm = (s) => s.toLocaleLowerCase('tr');

    const all = (await rows(
      db,
      `SELECT l.*, u.name owner_name
       FROM listings l
       JOIN users u ON u.id = l.owner_id
       WHERE l.status = 'open'
       ORDER BY l.id DESC`
    )).filter(
      (l) => !q || norm(`${l.title} ${l.author}`).includes(norm(q))
    );

    c.page(
      'İlanlar',
      view.homePage({
        listings: all.slice((page - 1) * 24, page * 24),
        q,
        page,
        hasNext: all.length > page * 24
      })
    );
  });

  // Kayıt ve giriş
  get('/kayit', (c) =>
    c.page('Kayıt ol', view.registerPage(c.form))
  );

  post('/kayit', async (c) => {
    limit(`kayit:${c.ip}`, 30, 3600000);

    const userId = await auth.register(db, c.form);
    await startSession(c, userId, '/hesabim?m=kayit');
  });

  get('/giris', (c) =>
    c.page(
      'Giriş',
      view.loginPage(c.form, c.form.next ?? c.query.get('next'))
    )
  );

  post('/giris', async (c) => {
    const email = String(c.form.email ?? '')
      .toLowerCase()
      .slice(0, 120);

    limit(`giris:${c.ip}`, 100, 900000);
    limit(`giris:${c.ip}:${email}`, 8, 900000);

    const userId = await auth.login(db, c.form);
    await startSession(c, userId, safeNext(c.form.next));
  });

  post('/cikis', async (c) => {
    await auth.endSession(db, c.token);
    c.redirect('/', cookie('', 0));
  }, 'user');

  // İlan oluşturma
  get('/ilan/yeni', (c) =>
    c.page('İlan aç', view.newListingPage(c.user, c.form)),
    'user'
  );

  post('/ilan/yeni', async (c) => {
    limit(`ilan:${c.user.id}`, 20, 3600000);

    const listingId = await t.createListing(db, c.user, c.form);
    c.redirect(`/ilan/${listingId}?m=ilan`);
  }, 'user');

  // İlan detayları
  get('/ilan/:id', async (c) => {
    const listing = await t.getListing(db, c.id);

    if (!listing) {
      throw new t.UserError('İlan bulunamadı.', 404);
    }

    const uid = c.user?.id ?? 0;
    const isOwner = Number(uid) === Number(listing.owner_id);

    const offers = await rows(
      db,
      `SELECT o.*, u.name user_name
       FROM offers o
       JOIN users u ON u.id = o.user_id
       WHERE o.listing_id = ?
         AND (? = 1 OR o.user_id = ?)
       ORDER BY o.id DESC`,
      [c.id, isOwner ? 1 : 0, uid]
    );

    const swap = await first(
      db,
      `SELECT s.id
       FROM swaps s
       JOIN offers o ON o.id = s.offer_id
       WHERE s.listing_id = ?
         AND s.status != 'cancelled'
         AND (? = 1 OR o.user_id = ?)`,
      [c.id, isOwner ? 1 : 0, uid]
    );

    c.page(
      listing.title,
      view.listingPage({
        user: c.user,
        listing,
        offers,
        swapId: swap?.id,
        v: c.form
      })
    );
  });

  post('/ilan/:id/kaldir', async (c) => {
    await t.cancelListing(db, c.user, c.id);
    c.redirect(`/ilan/${c.id}?m=tamam`);
  }, 'user');

  post('/ilan/:id/teklif', async (c) => {
    limit(`teklif:${c.user.id}`, 30, 3600000);

    await t.createOffer(db, c.user, c.id, c.form);
    c.redirect(`/ilan/${c.id}?m=teklif`);
  }, 'user');

  // Teklif işlemleri
  post('/teklif/:id/kabul', async (c) => {
    const swapId = await t.acceptOffer(db, c.user, c.id);
    c.redirect(`/takas/${swapId}?m=kabul`);
  }, 'user');

  post('/teklif/:id/reddet', async (c) => {
    const listingId = await t.rejectOffer(db, c.user, c.id);
    c.redirect(`/ilan/${listingId}?m=tamam`);
  }, 'user');

  post('/teklif/:id/geri-cek', async (c) => {
    const listingId = await t.withdrawOffer(db, c.user, c.id);
    c.redirect(`/ilan/${listingId}?m=tamam`);
  }, 'user');

  // Takas detayları
  get('/takas/:id', async (c) => {
    const swap = await t.getSwap(db, c.user, c.id);

    c.page(
      `Takas #${c.id}`,
      view.swapPage({ user: c.user, swap })
    );
  }, 'user');

  // Takas işlemleri
  for (const [path, action] of [
    ['biraktim', t.markDropped],
    ['aldim', t.markPicked],
    ['iptal', t.cancelSwap],
    ['sorun', t.reportProblem]
  ]) {
    post(`/takas/:id/${path}`, async (c) => {
      await action(db, c.user, c.id, c.form.note);
      c.redirect(`/takas/${c.id}?m=tamam`);
    }, 'user');
  }

  // Hesabım
  get('/hesabim', async (c) => {
    const swaps = await t.userSwaps(db, c.user.id);

    const listings = await rows(
      db,
      `SELECT l.*,
        (SELECT COUNT(*)
         FROM offers o
         WHERE o.listing_id = l.id
           AND o.status = 'pending'
           AND l.status = 'open') pending
       FROM listings l
       WHERE owner_id = ?
       ORDER BY id DESC`,
      [c.user.id]
    );

    const offers = await rows(
      db,
      `SELECT o.*, l.title listing_title
       FROM offers o
       JOIN listings l ON l.id = o.listing_id
       WHERE o.user_id = ?
       ORDER BY o.id DESC`,
      [c.user.id]
    );

    c.page(
      'Hesabım',
      view.accountPage({
        user: c.user,
        swaps,
        listings,
        offers
      })
    );
  }, 'user');

  post('/hesabim/sifre', async (c) => {
    limit(`sifre:${c.user.id}`, 8, 900000);

    await auth.changePassword(db, c.user.id, c.form);
    c.redirect('/giris?m=sifre', cookie('', 0));
  }, 'user');

  // Yönetim paneli
  get('/yonetim', async (c) => {
    const swaps = await t.openSwaps(db);
    const boxes = await rows(db, 'SELECT * FROM boxes ORDER BY id');
    const users = await rows(
      db,
      `SELECT id, name, email, is_admin, is_banned
       FROM users
       ORDER BY id DESC`
    );

    c.page(
      'Yönetim',
      view.adminPage({
        user: c.user,
        swaps,
        boxes,
        users
      })
    );
  }, 'admin');

  post('/yonetim/takas/:id', async (c) => {
    await t.adminResolve(db, c.user, c.id, c.form.action);
    c.redirect('/yonetim?m=tamam');
  }, 'admin');

  post('/yonetim/kutu', async (c) => {
    await t.saveBox(db, c.user, c.form);
    c.redirect('/yonetim?m=tamam');
  }, 'admin');

  post('/yonetim/kullanici/:id', async (c) => {
    await t.setBanned(db, c.user, c.id, c.form.banned === '1');
    c.redirect('/yonetim?m=tamam');
  }, 'admin');

  return createServer(async (req, res) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');

    if (PRODUCTION) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }

    let c;

    const sendPage = (status, title, body, error) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });

      res.end(
        view.layout({
          title,
          user: c?.user,
          body,
          error,
          notice: error ? '' : NOTICES[c?.query.get('m')]
        })
      );
    };

    try {
      const url = new URL(`http://localhost${req.url}`);

      if (url.pathname === '/style.css') {
        res.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'public, max-age=3600'
        });
        return res.end(CSS);
      }

      const method = req.method === 'HEAD' ? 'GET' : req.method;
      const route = routes.find(
        (r) => r.method === method && r.re.test(url.pathname)
      );

      const token =
        /(?:^|;\s*)oturum=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];

      const forwarded =
        process.env.TRUST_PROXY === '1'
          ? req.headers['x-forwarded-for']?.split(',').at(-1).trim()
          : null;

      c = {
        token,
        query: url.searchParams,
        form: {},
        user: await auth.userFromToken(db, token),
        ip: forwarded || req.socket.remoteAddress,

        page: (title, body) => sendPage(200, title, body),

        redirect: (to, setCookie) => {
          if (setCookie) {
            res.setHeader('Set-Cookie', setCookie);
          }

          res.writeHead(303, { Location: to });
          res.end();
        }
      };

      if (!route) {
        throw new t.UserError('Sayfa bulunamadı.', 404);
      }

      const match = route.re.exec(url.pathname);
      c.id = match?.[1] ? Number(match[1]) : undefined;

      if (route.access !== 'public' && !c.user) {
        return c.redirect('/giris');
      }

      if (route.access === 'admin' && !c.user.is_admin) {
        throw new t.UserError('Bu sayfaya erişim yetkin yok.', 403);
      }

      if (method === 'POST') {
        const origin = req.headers.origin;

        if (origin && new URL(origin).host !== req.headers.host) {
          throw new t.UserError('İstek reddedildi.', 403);
        }

        c.form = await readForm(req);

        if (
          route.access !== 'public' &&
          !sameText(c.form._csrf, c.user.csrf)
        ) {
          throw new t.UserError(
            'Oturum doğrulanamadı. Sayfayı yenileyip tekrar dene.',
            403
          );
        }
      }

      try {
        await route.handler(c);
      } catch (err) {
        if (!(err instanceof t.UserError) || method !== 'POST') {
          throw err;
        }

        const p = url.pathname;
        const listingId = /^\/ilan\/(\d+)\/teklif$/.exec(p)?.[1];

        if (p === '/kayit') {
          return sendPage(
            err.status,
            'Kayıt ol',
            view.registerPage(c.form),
            err.message
          );
        }

        if (p === '/giris') {
          return sendPage(
            err.status,
            'Giriş',
            view.loginPage(c.form, c.form.next),
            err.message
          );
        }

        if (p === '/ilan/yeni') {
          return sendPage(
            err.status,
            'İlan aç',
            view.newListingPage(c.user, c.form),
            err.message
          );
        }

        if (listingId) {
          const listing = await t.getListing(db, Number(listingId));

          if (listing) {
            return sendPage(
              err.status,
              listing.title,
              view.listingPage({
                user: c.user,
                listing,
                offers: [],
                v: c.form
              }),
              err.message
            );
          }
        }

        throw err;
      }
    } catch (err) {
      const known = err instanceof t.UserError;

      if (!known) {
        console.error(err);
      }

      if (res.headersSent) {
        return res.end();
      }

      const message = known
        ? err.message
        : 'Beklenmeyen bir hata oluştu.';

      sendPage(
        known ? err.status : 500,
        'Hata',
        view.messagePage(message)
      );
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const db = await openDb();
  const port = Number(process.env.PORT) || 3000;

  const server = createApp(db).listen(port, () => {
    console.log(`Kitap Takas çalışıyor: http://localhost:${port}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(async () => {
        await db.close();
        process.exit(0);
      });
    });
  }
}
