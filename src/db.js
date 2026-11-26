
import { createClient } from '@libsql/client';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

// Yerel ortamda .env dosyasını yükle
if (existsSync('.env')) {
  loadEnvFile('.env');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  condition TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  wanted TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','reserved','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  condition TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','withdrawn','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_offer
ON offers(listing_id, user_id)
WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS boxes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS swaps (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  offer_id INTEGER NOT NULL UNIQUE REFERENCES offers(id),
  owner_box INTEGER NOT NULL REFERENCES boxes(id),
  offerer_box INTEGER NOT NULL REFERENCES boxes(id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','problem','completed','cancelled')),
  owner_dropped_at TEXT,
  offerer_dropped_at TEXT,
  owner_picked_at TEXT,
  offerer_picked_at TEXT,
  problem_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export async function openDb() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url || !authToken) {
    throw new Error(
      'TURSO_DATABASE_URL veya TURSO_AUTH_TOKEN eksik.'
    );
  }

  const db = createClient({
    url,
    authToken
  });

  try {
    // Veritabanı tablolarını oluştur
    await db.executeMultiple(SCHEMA);

    // İlk açılışta örnek kutuları oluştur
    await transaction(db, async (tx) => {
      const result = await tx.execute(
        'SELECT COUNT(*) AS n FROM boxes'
      );

      if (Number(result.rows[0].n) === 0) {
        for (let i = 1; i <= 10; i++) {
          await tx.execute({
            sql: `
              INSERT INTO boxes (name, location)
              VALUES (?, ?)
            `,
            args: [
              `Kutu ${i}`,
              'Konum henüz girilmedi'
            ]
          });
        }
      }
    });

    console.log('Turso veritabanına başarıyla bağlanıldı.');

    return db;

  } catch (err) {
    db.close();
    throw err;
  }
}

export async function transaction(db, fn) {
  const tx = await db.transaction('write');

  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    tx.close();
  }
}
