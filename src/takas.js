
// Takas kuralları. Her işlem yetkiyi ve durumu burada denetler.
// Turso / @libsql/client uyumlu sürüm.

export const CONDITIONS = [
  'Yeni gibi',
  'İyi',
  'Notlu / çizili',
  'Yıpranmış'
];

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const need = (ok, message, status) => {
  if (!ok) throw new UserError(message, status);
};

// Ortak yardımcı: SELECT sorgusu
async function query(db, sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows;
}

// Ortak yardımcı: INSERT / UPDATE / DELETE
async function execute(db, sql, args = []) {
  return db.execute({ sql, args });
}

// Turso transaction yönetimi
async function transaction(db, fn) {
  const tx = await db.transaction('write');

  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export function text(value, label, max, required = true) {
  const v = String(value ?? '').trim();

  need(!required || v, `${label} boş bırakılamaz.`);
  need(v.length <= max, `${label} en fazla ${max} karakter olabilir.`);

  return v;
}

function bookFields(f) {
  need(CONDITIONS.includes(f.condition), 'Kitabın durumunu seçin.');

  return [
    text(f.title, 'Kitap adı', 150),
    text(f.author, 'Yazar', 100),
    f.condition
  ];
}

// İlan oluşturma
export async function createListing(db, user, f) {
  const r = await execute(
    db,
    `INSERT INTO listings
      (owner_id, title, author, condition, description, wanted)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      user.id,
      ...bookFields(f),
      text(f.description, 'Açıklama', 1000, false),
      text(f.wanted, 'İstediğin kitaplar', 300, false)
    ]
  );

  return Number(r.lastInsertRowid);
}

// İlan bilgisi
export async function getListing(db, id) {
  const rows = await query(
    db,
    `SELECT l.*, u.name owner_name
     FROM listings l
     JOIN users u ON u.id = l.owner_id
     WHERE l.id = ?`,
    [id]
  );

  return rows[0] ?? null;
}

// İlan iptali
export async function cancelListing(db, user, id) {
  await transaction(db, async (tx) => {
    const l = await getListing(tx, id);

    need(l, 'İlan bulunamadı.', 404);
    need(
      Number(l.owner_id) === Number(user.id) || user.is_admin,
      'Bu ilanı kaldıramazsın.',
      403
    );
    need(l.status === 'open', 'Yalnızca açık ilanlar kaldırılabilir.');

    await execute(
      tx,
      "UPDATE listings SET status = 'cancelled' WHERE id = ?",
      [id]
    );

    await execute(
      tx,
      "UPDATE offers SET status = 'rejected' WHERE listing_id = ? AND status = 'pending'",
      [id]
    );
  });
}

// Teklif oluşturma
export async function createOffer(db, user, listingId, f) {
  return transaction(db, async (tx) => {
    const l = await getListing(tx, listingId);

    need(l, 'İlan bulunamadı.', 404);
    need(l.status === 'open', 'Bu ilan artık teklife açık değil.');
    need(
      Number(l.owner_id) !== Number(user.id),
      'Kendi ilanına teklif veremezsin.'
    );

    const existing = await query(
      tx,
      `SELECT 1 FROM offers
       WHERE listing_id = ?
       AND user_id = ?
       AND status = 'pending'`,
      [listingId, user.id]
    );

    need(!existing.length, 'Bu ilanda zaten bekleyen bir teklifin var.');

    const r = await execute(
      tx,
      `INSERT INTO offers
       (listing_id, user_id, title, author, condition, message)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        listingId,
        user.id,
        ...bookFields(f),
        text(f.message, 'Mesaj', 500, false)
      ]
    );

    return Number(r.lastInsertRowid);
  });
}

// Teklif bilgisi
async function getOffer(db, id) {
  const rows = await query(
    db,
    `SELECT o.*, l.owner_id, l.status listing_status,
      u.is_banned offerer_banned
     FROM offers o
     JOIN listings l ON l.id = o.listing_id
     JOIN users u ON u.id = o.user_id
     WHERE o.id = ?`,
    [id]
  );

  return rows[0] ?? null;
}

// Teklifi geri çekme
export async function withdrawOffer(db, user, id) {
  return transaction(db, async (tx) => {
    const o = await getOffer(tx, id);

    need(
      o && Number(o.user_id) === Number(user.id),
      'Teklif bulunamadı.',
      404
    );
    need(o.status === 'pending', 'Bu teklif artık geri çekilemez.');

    await execute(
      tx,
      "UPDATE offers SET status = 'withdrawn' WHERE id = ?",
      [id]
    );

    return Number(o.listing_id);
  });
}

// Teklifi reddetme
export async function rejectOffer(db, user, id) {
  return transaction(db, async (tx) => {
    const o = await getOffer(tx, id);

    need(
      o && Number(o.owner_id) === Number(user.id),
      'Teklif bulunamadı.',
      404
    );
    need(o.status === 'pending', 'Bu teklif artık beklemede değil.');

    await execute(
      tx,
      "UPDATE offers SET status = 'rejected' WHERE id = ?",
      [id]
    );

    return Number(o.listing_id);
  });
}

// Boş kutuları bulma
export async function freeBoxes(db) {
  return query(
    db,
    `SELECT * FROM boxes b
     WHERE b.active = 1
     AND NOT EXISTS (
       SELECT 1 FROM swaps s
       WHERE s.status IN ('active', 'problem')
       AND (
         (s.owner_box = b.id AND s.offerer_picked_at IS NULL)
         OR
         (s.offerer_box = b.id AND s.owner_picked_at IS NULL)
       )
     )
     ORDER BY b.id`
  );
}

// Teklifi kabul etme ve iki kutuyu rezerve etme
export async function acceptOffer(db, user, id) {
  return transaction(db, async (tx) => {
    const o = await getOffer(tx, id);

    need(
      o && Number(o.owner_id) === Number(user.id),
      'Teklif bulunamadı.',
      404
    );

    need(
      o.status === 'pending' && o.listing_status === 'open',
      'Bu teklif artık kabul edilemez.'
    );

    need(!o.offerer_banned, 'Teklifi veren hesap engellenmiş.');

    const boxes = await freeBoxes(tx);

    need(
      boxes.length >= 2,
      'Şu anda iki boş kutu yok. Kutular boşalınca tekrar dene.'
    );

    await execute(
      tx,
      "UPDATE offers SET status = 'accepted' WHERE id = ?",
      [id]
    );

    await execute(
      tx,
      "UPDATE listings SET status = 'reserved' WHERE id = ?",
      [o.listing_id]
    );

    const r = await execute(
      tx,
      `INSERT INTO swaps
       (listing_id, offer_id, owner_box, offerer_box)
       VALUES (?, ?, ?, ?)`,
      [
        o.listing_id,
        id,
        boxes[0].id,
        boxes[1].id
      ]
    );

    return Number(r.lastInsertRowid);
  });
}

// Takas sorgusu
const SWAP_SQL = `
  SELECT s.*, l.owner_id, o.user_id offerer_id,
    l.title owner_title, l.author owner_author,
    o.title offerer_title, o.author offerer_author,
    a.name owner_name, a.email owner_email,
    b.name offerer_name, b.email offerer_email,
    x.name owner_box_name, x.location owner_box_location,
    y.name offerer_box_name, y.location offerer_box_location
  FROM swaps s
  JOIN listings l ON l.id = s.listing_id
  JOIN offers o ON o.id = s.offer_id
  JOIN users a ON a.id = l.owner_id
  JOIN users b ON b.id = o.user_id
  JOIN boxes x ON x.id = s.owner_box
  JOIN boxes y ON y.id = s.offerer_box
`;

// Tek takas bilgisi
export async function getSwap(db, user, id) {
  const rows = await query(
    db,
    `${SWAP_SQL} WHERE s.id = ?`,
    [id]
  );

  const s = rows[0] ?? null;

  need(
    s && (
      user.is_admin ||
      Number(s.owner_id) === Number(user.id) ||
      Number(s.offerer_id) === Number(user.id)
    ),
    'Takas bulunamadı.',
    404
  );

  return s;
}

// Kullanıcının takasları
export async function userSwaps(db, userId) {
  return query(
    db,
    `${SWAP_SQL}
     WHERE l.owner_id = ? OR o.user_id = ?
     ORDER BY s.id DESC`,
    [userId, userId]
  );
}

// Açık takaslar (yönetim)
export async function openSwaps(db) {
  return query(
    db,
    `${SWAP_SQL}
     WHERE s.status IN ('active', 'problem')
     ORDER BY s.status = 'problem' DESC, s.id`
  );
}

// Takas tarafını belirleme
export function sideOf(swap, user) {
  if (Number(swap.owner_id) === Number(user.id)) {
    return ['owner', 'offerer'];
  }

  if (Number(swap.offerer_id) === Number(user.id)) {
    return ['offerer', 'owner'];
  }

  return null;
}

async function activeSwapFor(db, user, id) {
  const s = await getSwap(db, user, id);
  const side = sideOf(s, user);

  need(side, 'Bu işlemi yalnızca takasın tarafları yapabilir.', 403);
  need(s.status === 'active', 'Bu takas şu anda işleme kapalı.');

  return [s, ...side];
}

// Takas kapatma
async function finish(db, swap, status, listingStatus) {
  if (listingStatus === 'open') {
    const rows = await query(
      db,
      'SELECT is_banned FROM users WHERE id = ?',
      [swap.owner_id]
    );

    if (rows[0]?.is_banned) {
      listingStatus = 'cancelled';
    }
  }

  await execute(
    db,
    'UPDATE swaps SET status = ? WHERE id = ?',
    [status, swap.id]
  );

  await execute(
    db,
    'UPDATE listings SET status = ? WHERE id = ?',
    [listingStatus, swap.listing_id]
  );

  if (status === 'cancelled') {
    await execute(
      db,
      "UPDATE offers SET status = 'cancelled' WHERE id = ?",
      [swap.offer_id]
    );
  }

  if (listingStatus !== 'open') {
    await execute(
      db,
      `UPDATE offers SET status = 'rejected'
       WHERE listing_id = ? AND status = 'pending'`,
      [swap.listing_id]
    );
  }
}

// Kitabını kutuya bıraktığını bildirme
export async function markDropped(db, user, id) {
  await transaction(db, async (tx) => {
    const [s, me] = await activeSwapFor(tx, user, id);

    need(
      !s[`${me}_dropped_at`],
      'Kitabını bıraktığını zaten bildirdin.'
    );

    await execute(
      tx,
      `UPDATE swaps
       SET ${me}_dropped_at = datetime('now')
       WHERE id = ?`,
      [id]
    );
  });
}

// Kitabı teslim aldığını bildirme
export async function markPicked(db, user, id) {
  await transaction(db, async (tx) => {
    const [s, me, other] = await activeSwapFor(tx, user, id);

    need(
      s.owner_dropped_at && s.offerer_dropped_at,
      'İki kitap da kutuya bırakılmadan teslim alınamaz.'
    );

    need(
      !s[`${me}_picked_at`],
      'Kitabı aldığını zaten bildirdin.'
    );

    await execute(
      tx,
      `UPDATE swaps
       SET ${me}_picked_at = datetime('now')
       WHERE id = ?`,
      [id]
    );

    if (s[`${other}_picked_at`]) {
      await finish(tx, s, 'completed', 'completed');
    }
  });
}

// Takas iptali
export async function cancelSwap(db, user, id) {
  await transaction(db, async (tx) => {
    const [s] = await activeSwapFor(tx, user, id);

    need(
      !s.owner_dropped_at && !s.offerer_dropped_at,
      'Kutuya kitap bırakıldıktan sonra iptal edilemez. "Sorun bildir" seçeneğini kullan.'
    );

    await finish(tx, s, 'cancelled', 'open');
  });
}

// Sorun bildirimi
export async function reportProblem(db, user, id, note) {
  await transaction(db, async (tx) => {
    await activeSwapFor(tx, user, id);

    await execute(
      tx,
      `UPDATE swaps
       SET status = 'problem', problem_note = ?
       WHERE id = ?`,
      [
        `${user.name}: ${text(note, 'Sorun açıklaması', 500)}`,
        id
      ]
    );
  });
}

// Yönetici takas çözümü
export async function adminResolve(db, admin, id, action) {
  need(admin.is_admin, 'Yetkin yok.', 403);

  await transaction(db, async (tx) => {
    const s = await getSwap(tx, admin, id);

    need(
      ['active', 'problem'].includes(s.status),
      'Bu takas zaten kapanmış.'
    );

    if (action === 'resume') {
      need(
        s.status === 'problem',
        'Bu takasta açık bir sorun yok.'
      );

      await execute(
        tx,
        `UPDATE swaps
         SET status = 'active', problem_note = NULL
         WHERE id = ?`,
        [id]
      );

    } else if (action === 'complete') {
      await finish(tx, s, 'completed', 'completed');

    } else if (action === 'cancel') {
      await finish(
        tx,
        s,
        'cancelled',
        s.owner_dropped_at || s.offerer_dropped_at
          ? 'cancelled'
          : 'open'
      );

    } else {
      need(false, 'Geçersiz işlem.');
    }
  });
}

// Engellenen kullanıcının ilanları ve teklifleri kapatılır
export async function setBanned(db, admin, userId, banned) {
  need(admin.is_admin, 'Yetkin yok.', 403);
  need(
    Number(admin.id) !== Number(userId),
    'Kendini engelleyemezsin.'
  );

  await transaction(db, async (tx) => {
    await execute(
      tx,
      'UPDATE users SET is_banned = ? WHERE id = ?',
      [banned ? 1 : 0, userId]
    );

    if (!banned) return;

    await execute(
      tx,
      'DELETE FROM sessions WHERE user_id = ?',
      [userId]
    );

    await execute(
      tx,
      `UPDATE offers SET status = 'rejected'
       WHERE status = 'pending'
       AND (
         user_id = ?
         OR listing_id IN (
           SELECT id FROM listings WHERE owner_id = ?
         )
       )`,
      [userId, userId]
    );

    await execute(
      tx,
      `UPDATE listings SET status = 'cancelled'
       WHERE status = 'open' AND owner_id = ?`,
      [userId]
    );
  });
}

// Kutu kaydetme
export async function saveBox(db, admin, f) {
  need(admin.is_admin, 'Yetkin yok.', 403);

  const name = text(f.name, 'Kutu adı', 50);
  const location = text(f.location, 'Konum', 150);
  const id = Number(f.id) || 0;

  const existing = await query(
    db,
    'SELECT 1 FROM boxes WHERE name = ? AND id != ?',
    [name, id]
  );

  need(
    !existing.length,
    'Bu adda bir kutu zaten var.'
  );

  if (f.id) {
    await execute(
      db,
      `UPDATE boxes
       SET name = ?, location = ?, active = ?
       WHERE id = ?`,
      [name, location, f.active ? 1 : 0, id]
    );
  } else {
    await execute(
      db,
      'INSERT INTO boxes (name, location) VALUES (?, ?)',
      [name, location]
    );
  }
}

