import { CONDITIONS, sideOf } from './takas.js';

// html`` içine konan her değer otomatik kaçışlanır (XSS koruması).
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const render = (v) => v instanceof Safe ? v.s : Array.isArray(v) ? v.map(render).join('')
  : v === null || v === undefined || v === false ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]);
const html = (parts, ...values) => new Safe(parts.reduce((out, p, i) => out + p + (i < values.length ? render(values[i]) : ''), ''));

const LABEL = {
  open: 'Açık', reserved: 'Takasta', completed: 'Tamamlandı', cancelled: 'İptal', pending: 'Bekliyor',
  accepted: 'Kabul edildi', rejected: 'Reddedildi', withdrawn: 'Geri çekildi', active: 'Devam ediyor', problem: 'Sorun bildirildi',
};
const badge = (s) => html`<span class="badge ${s}">${LABEL[s]}</span>`;

export function layout({ title, user, body, error, notice }) {
  return '<!doctype html>' + html`<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Kitap Takas</title><link rel="stylesheet" href="/style.css"></head><body>
<header><a class="brand" href="/">Kitap<b>Takas</b></a><nav>
<a href="/">İlanlar</a>
${user ? html`<a href="/ilan/yeni">İlan aç</a><a href="/hesabim">Hesabım</a>
${user.is_admin ? html`<a href="/yonetim">Yönetim</a>` : ''}
<form method="post" action="/cikis"><input type="hidden" name="_csrf" value="${user.csrf}"><button class="link">Çıkış</button></form>`
    : html`<a href="/giris">Giriş</a><a href="/kayit">Kayıt ol</a>`}
</nav></header><main>
${error ? html`<p class="alert error" role="alert">${error}</p>` : ''}
${notice ? html`<p class="alert ok" role="status">${notice}</p>` : ''}
${body}
</main><footer>Abdullah Gül Üniversitesi öğrencileri için kitap takası. Üniversitenin resmî uygulaması değildir.</footer>
</body></html>`;
}

const form = (user, action, content, cls = '') => html`<form method="post" action="${action}" class="${cls}">
<input type="hidden" name="_csrf" value="${user?.csrf}">${content}</form>`;
const button = (user, action, label, cls = '') => form(user, action, html`<button class="${cls}">${label}</button>`, 'inline');

const field = (label, name, v, { type = 'text', max = 150, required = true, extra = '' } = {}) => html`<label>${label}
<input type="${type}" name="${name}" value="${v[name]}" maxlength="${max}" ${required ? 'required' : ''} ${new Safe(extra)}></label>`;
const area = (label, name, v, max) => html`<label>${label}<textarea name="${name}" maxlength="${max}" rows="3">${v[name]}</textarea></label>`;
const bookInputs = (v) => html`${field('Kitap adı', 'title', v)}${field('Yazar', 'author', v, { max: 100 })}
<label>Durumu<select name="condition" required><option value="">Seçin</option>
${CONDITIONS.map((c) => html`<option ${v.condition === c ? new Safe('selected') : ''}>${c}</option>`)}</select></label>`;

export const registerPage = (v) => html`<section class="narrow"><h1>Kayıt ol</h1>
${form(null, '/kayit', html`${field('Ad soyad', 'name', v, { max: 80 })}${field('E-posta', 'email', v, { type: 'email', max: 120 })}
${field('Şifre (en az 8 karakter)', 'password', {}, { type: 'password', max: 200, extra: 'minlength="8" autocomplete="new-password"' })}
<p class="muted">E-posta adresin yalnızca takas yaptığın kişiye ve yöneticilere gösterilir.</p><button>Hesap oluştur</button>`)}</section>`;

export const loginPage = (v, next) => html`<section class="narrow"><h1>Giriş</h1>
${form(null, '/giris', html`<input type="hidden" name="next" value="${next}">
${field('E-posta', 'email', v, { type: 'email', max: 120 })}${field('Şifre', 'password', {}, { type: 'password', max: 200 })}<button>Giriş yap</button>`)}
<p class="muted">Hesabın yok mu? <a href="/kayit">Kayıt ol</a>. Şifreni unuttuysan yöneticiye başvur.</p></section>`;

export function homePage({ listings, q, page, hasNext }) {
  const link = (p) => `/?${new URLSearchParams({ q, sayfa: p })}`;
  return html`<h1>Takasa açık kitaplar</h1>
<form class="search" method="get" action="/"><input type="search" name="q" value="${q}" placeholder="Kitap veya yazar ara" aria-label="Ara"><button>Ara</button></form>
${listings.length ? html`<ul class="grid">${listings.map((l) => html`<li class="card"><a href="/ilan/${l.id}">
<h2>${l.title}</h2><p>${l.author}</p><p class="muted">${l.condition} · ${l.owner_name}</p>
${l.wanted ? html`<p class="wanted">İstediği: ${l.wanted}</p>` : ''}</a></li>`)}</ul>`
    : html`<p class="empty">${q ? 'Aramana uyan açık ilan yok.' : 'Henüz açık ilan yok. İlk ilanı sen aç.'}</p>`}
<p class="pager">${page > 1 ? html`<a href="${link(page - 1)}">← Önceki</a>` : ''}${hasNext ? html`<a href="${link(page + 1)}">Sonraki →</a>` : ''}</p>`;
}

export const newListingPage = (user, v) => html`<section class="narrow"><h1>İlan aç</h1>
${form(user, '/ilan/yeni', html`${bookInputs(v)}${area('Açıklama (isteğe bağlı)', 'description', v, 1000)}
${field('Karşılığında istediğin kitaplar (isteğe bağlı)', 'wanted', v, { max: 300, required: false })}<button>İlanı yayınla</button>`)}</section>`;

export function listingPage({ user, listing: l, offers, swapId, v }) {
  const mine = user?.id === l.owner_id;
  const myPending = offers.find((o) => o.user_id === user?.id && o.status === 'pending');
  return html`<article><h1>${l.title} ${badge(l.status)}</h1><p class="lead">${l.author}</p>
<p class="muted">${l.condition} · İlan sahibi: ${l.owner_name}</p>
${l.description ? html`<p class="pre">${l.description}</p>` : ''}
${l.wanted ? html`<p class="wanted">İstediği: ${l.wanted}</p>` : ''}
${swapId ? html`<p><a class="btn" href="/takas/${swapId}">Takas sayfasına git</a></p>` : ''}
${l.status === 'open' && (mine || user?.is_admin) ? button(user, `/ilan/${l.id}/kaldir`, 'İlanı kaldır', 'danger') : ''}</article>
${offers.length ? html`<h2>${mine ? 'Gelen teklifler' : 'Tekliflerin'}</h2><ul class="list">${offers.map((o) => html`<li>
<div><strong>${o.title}</strong> — ${o.author} ${badge(o.status)}<br><span class="muted">${o.condition} · ${o.user_name}</span>
${o.message ? html`<p class="pre">${o.message}</p>` : ''}</div>
<div class="actions">${mine && o.status === 'pending' && l.status === 'open' ? html`${button(user, `/teklif/${o.id}/kabul`, 'Kabul et')}${button(user, `/teklif/${o.id}/reddet`, 'Reddet', 'secondary')}` : ''}
${o.user_id === user?.id && o.status === 'pending' ? button(user, `/teklif/${o.id}/geri-cek`, 'Geri çek', 'secondary') : ''}</div></li>`)}</ul>`
    : mine ? html`<p class="empty">Henüz teklif gelmedi.</p>` : ''}
${l.status !== 'open' || mine || myPending ? '' : !user
    ? html`<p><a class="btn" href="/giris?next=/ilan/${l.id}">Teklif vermek için giriş yap</a></p>`
    : html`<section class="narrow"><h2>Takas teklifi ver</h2><p class="muted">Karşılığında vereceğin kitabı yaz. İlan sahibi kabul ederse takas başlar.</p>
${form(user, `/ilan/${l.id}/teklif`, html`${bookInputs(v)}${area('Mesaj (isteğe bağlı)', 'message', v, 500)}<button>Teklifi gönder</button>`)}</section>`}`;
}

export function accountPage({ user, swaps, listings, offers }) {
  return html`<h1>Merhaba, ${user.name}</h1>
<h2>Takasların</h2>${swaps.length ? html`<ul class="list">${swaps.map((s) => html`<li><a href="/takas/${s.id}">${s.owner_title} ⇄ ${s.offerer_title}</a>${badge(s.status)}</li>`)}</ul>` : html`<p class="empty">Henüz takasın yok.</p>`}
<h2>İlanların</h2>${listings.length ? html`<ul class="list">${listings.map((l) => html`<li><a href="/ilan/${l.id}">${l.title}</a>
<span>${l.pending ? html`<span class="badge pending">${l.pending} yeni teklif</span> ` : ''}${badge(l.status)}</span></li>`)}</ul>` : html`<p class="empty">İlanın yok. <a href="/ilan/yeni">İlan aç</a></p>`}
<h2>Verdiğin teklifler</h2>${offers.length ? html`<ul class="list">${offers.map((o) => html`<li><a href="/ilan/${o.listing_id}">${o.title} → ${o.listing_title}</a>${badge(o.status)}</li>`)}</ul>` : html`<p class="empty">Teklif vermedin.</p>`}
<section class="narrow"><h2>Şifre değiştir</h2>${form(user, '/hesabim/sifre', html`${field('Mevcut şifre', 'current', {}, { type: 'password', max: 200 })}
${field('Yeni şifre', 'password', {}, { type: 'password', max: 200, extra: 'minlength="8"' })}<button>Şifreyi değiştir</button>`)}</section>`;
}

export function swapPage({ user, swap: s }) {
  const side = sideOf(s, user);
  let actions = '';
  if (side && s.status === 'active') {
    const [me, other] = side;
    const bothIn = s.owner_dropped_at && s.offerer_dropped_at;
    let step;
    if (!s[`${me}_dropped_at`]) {
      step = html`<p>Kendi kitabını (<strong>${s[`${me}_title`]}</strong>) <strong>${s[`${me}_box_name`]}</strong> içine bırak. Konum: ${s[`${me}_box_location`]}</p>
${button(user, `/takas/${s.id}/biraktim`, 'Kitabımı bıraktım')}`;
    } else if (!bothIn) {
      step = html`<p>Kitabını bıraktın. ${s[`${other}_name`]} kendi kitabını bırakınca bu sayfada teslim alma adımı açılacak.</p>`;
    } else if (!s[`${me}_picked_at`]) {
      step = html`<p><strong>${s[`${other}_title`]}</strong> kitabını <strong>${s[`${other}_box_name`]}</strong> içinden al. Konum: ${s[`${other}_box_location`]}</p>
${button(user, `/takas/${s.id}/aldim`, 'Kitabı aldım')}`;
    } else {
      step = html`<p>Kitabını aldın. ${s[`${other}_name`]} de alınca takas tamamlanacak.</p>`;
    }
    actions = html`<section class="step"><h2>Sıradaki adımın</h2>${step}</section>
${!s.owner_dropped_at && !s.offerer_dropped_at ? button(user, `/takas/${s.id}/iptal`, 'Takası iptal et', 'secondary') : ''}
<details><summary>Sorun bildir</summary>${form(user, `/takas/${s.id}/sorun`, html`${area('Ne oldu? (kutu boş, yanlış kitap vb.)', 'note', {}, 500)}<button class="danger">Yöneticiye bildir</button>`)}</details>`;
  }
  const row = (p) => html`<li><div><strong>${s[`${p}_title`]}</strong> — ${s[`${p}_author`]}<br>
<span class="muted">Veren: ${s[`${p}_name`]} (<a href="mailto:${s[`${p}_email`]}">${s[`${p}_email`]}</a>)<br>${s[`${p}_box_name`]} · ${s[`${p}_box_location`]}</span></div>
<div class="muted">Kutuya bırakıldı: ${s[`${p}_dropped_at`] ? '✓' : '—'}<br>Karşı taraf aldı: ${s[`${p === 'owner' ? 'offerer' : 'owner'}_picked_at`] ? '✓' : '—'}</div></li>`;
  return html`<h1>Takas #${s.id} ${badge(s.status)}</h1>
${s.status === 'problem' ? html`<p class="alert error">Yönetici inceliyor. ${s.problem_note}</p>` : ''}
<ul class="list">${row('owner')}${row('offerer')}</ul>${actions}`;
}

export function adminPage({ user, swaps, boxes, users }) {
  const resolve = (s, action, label, cls) => form(user, `/yonetim/takas/${s.id}`, html`<input type="hidden" name="action" value="${action}"><button class="${cls}">${label}</button>`, 'inline');
  return html`<h1>Yönetim</h1><h2>Açık takaslar</h2>
${swaps.length ? html`<p class="muted">Takası kapatmadan önce kutuları kontrol edip boşaltın.</p><ul class="list">${swaps.map((s) => html`<li><div><a href="/takas/${s.id}">#${s.id} ${s.owner_title} ⇄ ${s.offerer_title}</a> ${badge(s.status)}
<br><span class="muted">${s.owner_box_name}, ${s.offerer_box_name} · ${s.created_at} (UTC)</span>${s.problem_note ? html`<p>${s.problem_note}</p>` : ''}</div>
<div class="actions">${s.status === 'problem' ? resolve(s, 'resume', 'Devam ettir', '') : ''}${resolve(s, 'complete', 'Tamamlandı say', 'secondary')}${resolve(s, 'cancel', 'İptal et', 'danger')}</div></li>`)}</ul>` : html`<p class="empty">Açık takas yok.</p>`}
<h2>Kutular</h2><ul class="list">${boxes.map((b) => html`<li>${form(user, '/yonetim/kutu', html`<input type="hidden" name="id" value="${b.id}">
<input name="name" value="${b.name}" aria-label="Kutu adı" maxlength="50" required><input name="location" value="${b.location}" aria-label="Konum" maxlength="150" required>
<label class="check"><input type="checkbox" name="active" value="1" ${b.active ? new Safe('checked') : ''}>Kullanımda</label><button>Kaydet</button>`, 'row')}</li>`)}
<li>${form(user, '/yonetim/kutu', html`<input name="name" placeholder="Yeni kutu adı" aria-label="Yeni kutu adı" maxlength="50" required><input name="location" placeholder="Konum" aria-label="Yeni kutu konumu" maxlength="150" required><button>Kutu ekle</button>`, 'row')}</li></ul>
<h2>Kullanıcılar</h2><ul class="list">${users.map((u) => html`<li><div>${u.name} <span class="muted">${u.email}${u.is_admin ? ' · yönetici' : ''}${u.is_banned ? ' · engelli' : ''}</span></div>
${u.id === user.id ? '' : form(user, `/yonetim/kullanici/${u.id}`, html`<input type="hidden" name="banned" value="${u.is_banned ? '' : '1'}"><button class="secondary">${u.is_banned ? 'Engeli kaldır' : 'Engelle'}</button>`, 'inline')}</li>`)}</ul>`;
}

export const messagePage = (message) => html`<h1>${message}</h1><p><a href="/">Ana sayfaya dön</a></p>`;
