// Komut satırından yönetim:
//   npm run yonetim -- admin ornek@mail.com
//   npm run yonetim -- sifre ornek@mail.com
//   npm run yonetim -- yedek yedek.db
import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { hashPassword } from './auth.js';

const [command, arg] = process.argv.slice(2);
const db = openDb();
const findUser = () => db.prepare('SELECT id FROM users WHERE email = ?').get(String(arg).toLowerCase())
  ?? (console.error('Bu e-posta ile kullanıcı yok. Önce siteden kayıt olun.'), process.exit(1));

if (command === 'admin' && arg) {
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(findUser().id);
  console.log(`${arg} artık yönetici.`);
} else if (command === 'sifre' && arg) {
  const { id } = findUser();
  const password = randomBytes(9).toString('base64url');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  console.log(`Geçici şifre: ${password}`);
} else if (command === 'yedek' && arg) {
  db.prepare('VACUUM INTO ?').run(arg);
  console.log(`Yedek alındı: ${arg}`);
} else {
  console.log('Kullanım: admin <e-posta> | sifre <e-posta> | yedek <dosya>');
  process.exitCode = 1;
}
