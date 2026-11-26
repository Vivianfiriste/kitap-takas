
import { createClient } from '@libsql/client';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

// Yerel ortamda .env dosyasını yükle
if (existsSync('.env')) {
  loadEnvFile('.env');
}

// Takas yapılabilecek binalar
export const BUILDINGS = Object.freeze([
  'Ambar',
  'Fabrika',
  'Lab',
  'Çelik'
]);

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

  building TEXT
    CHECK (building IN ('Ambar','Fabrika','Lab','Çelik')),

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

// Mevcut veritabanını veri kaybetmeden güncelle
async function migrateDb(db) {
  await transaction(db, async (tx) => {
    const result = await tx.execute(
      'PRAGMA table_info(offers)'
    );

    const hasBuilding = result.rows.some(
      (column) => column.name === 'building'
    );

    // Bina sütunu yoksa oluştur
    if (!hasBuilding) {
      await tx.execute(`
        ALTER TABLE offers
        ADD COLUMN building TEXT
        CHECK (
          building IN ('Ambar','Fabrika','Lab','Çelik')
        )
      `);

      console.log(
        'Veritabanına bina seçimi özelliği eklendi.'
      );
    }
  });
}

// Turso veritabanı bağlantısı
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
    // Eksik tabloları oluştur
    await db.executeMultiple(SCHEMA);

    // Mevcut veritabanını güncelle
    await migrateDb(db);

    // İlk açılışta kutuları oluştur
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

    console.log(
      'Turso veritabanına başarıyla bağlanıldı.'
    );

    return db;

  } catch (err) {
    db.close();
    throw err;
  }
}

// Güvenli veritabanı işlemleri
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
