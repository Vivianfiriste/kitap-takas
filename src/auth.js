
import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  createHash
} from 'node:crypto';

import { promisify } from 'node:util';
import { text, UserError } from './takas.js';

const scryptAsync = promisify(scrypt);

export const SESSION_DAYS = 30;

const sha = (s) =>
  createHash('sha256').update(s).digest('hex');

function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 8 || p.length > 200) {
    throw new UserError('Şifre 8 ile 200 karakter arasında olmalı.');
  }
}

export async function hashPassword(password) {
  checkPassword(password);

  const salt = randomBytes(16);

  return `${salt.toString('hex')}:${(
    await scryptAsync(password, salt, 64)
  ).toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');

  const actual = await scryptAsync(
    String(password ?? ''),
    Buffer.from(salt, 'hex'),
    64
  );

  return timingSafeEqual(
    actual,
    Buffer.from(hash, 'hex')
  );
}

export async function register(db, f) {
  const name = text(f.name, 'Ad soyad', 80);
  const email = text(f.email, 'E-posta', 120).toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new UserError('Geçerli bir e-posta adresi yazın.');
  }

  const hash = await hashPassword(f.password);

  try {
    const result = await db.execute({
      sql: `
        INSERT INTO users (name, email, password_hash)
        VALUES (?, ?, ?)
      `,
      args: [name, email, hash]
    });

    return Number(result.lastInsertRowid);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new UserError('Bu e-posta ile zaten bir hesap var.');
    }

    throw err;
  }
}

export async function login(db, f) {
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE email = ?',
    args: [String(f.email ?? '').trim().toLowerCase()]
  });

  const user = result.rows[0] ?? null;

  if (
    !user ||
    !(await verifyPassword(f.password, user.password_hash))
  ) {
    throw new UserError('E-posta veya şifre hatalı.');
  }

  if (user.is_banned) {
    throw new UserError(
      'Bu hesap yönetici tarafından engellenmiş.',
      403
    );
  }

  return Number(user.id);
}

export async function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');

  await db.execute({
    sql: 'DELETE FROM sessions WHERE expires_at < ?',
    args: [Date.now()]
  });

  await db.execute({
    sql: `
      INSERT INTO sessions
      (token_hash, user_id, csrf, expires_at)
      VALUES (?, ?, ?, ?)
    `,
    args: [
      sha(token),
      userId,
      randomBytes(24).toString('base64url'),
      Date.now() + SESSION_DAYS * 864e5
    ]
  });

  return token;
}

export async function userFromToken(db, token) {
  if (!token) return null;

  const result = await db.execute({
    sql: `
      SELECT
        u.id,
        u.name,
        u.email,
        u.is_admin,
        s.csrf
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
        AND s.expires_at > ?
        AND u.is_banned = 0
    `,
    args: [sha(token), Date.now()]
  });

  const user = result.rows[0] ?? null;

  if (!user) return null;

  return {
    ...user,
    id: Number(user.id)
  };
}

export async function endSession(db, token) {
  return db.execute({
    sql: 'DELETE FROM sessions WHERE token_hash = ?',
    args: [sha(token ?? '')]
  });
}

export async function changePassword(db, userId, f) {
  const result = await db.execute({
    sql: 'SELECT password_hash FROM users WHERE id = ?',
    args: [userId]
  });

  const row = result.rows[0];

  if (!row || !(await verifyPassword(f.current, row.password_hash))) {
    throw new UserError('Mevcut şifre hatalı.');
  }

  const newHash = await hashPassword(f.password);

  await db.execute({
    sql: 'UPDATE users SET password_hash = ? WHERE id = ?',
    args: [newHash, userId]
  });

  await db.execute({
    sql: 'DELETE FROM sessions WHERE user_id = ?',
    args: [userId]
  });
}
