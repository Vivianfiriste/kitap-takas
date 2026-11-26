# Kitap Takas

Öğrenciler ilan açar, diğerleri kitapla teklif verir, ilan sahibi kabul ederse iki kitap için iki kutu ayrılır.

## Bilgisayarında çalıştırma

1. [Node.js](https://nodejs.org) 22.13 veya üstünü kur.
2. Bu klasörde terminal aç ve `npm start` yaz. Ek paket kurmaya gerek yok.
3. Tarayıcıda http://localhost:3000 adresini aç.

"SQLite is an experimental feature" uyarısı görürsen sorun değil.

Veritabanı ilk açılışta `data/takas.db` dosyasında kendiliğinden oluşur.

## İlk ayarlar

1. Siteden kendi hesabını aç.
2. Aynı klasörde: `npm run yonetim -- admin senin@mailin.com`
3. Sitede **Yönetim** sayfasından 10 örnek kutunun adını ve gerçek konumunu gir. Olmayanların "Kullanımda" işaretini kaldır.

## Takas nasıl işler?

1. A ilan açar, B karşılığında vereceği kitabı yazarak teklif verir.
2. A kabul eder. Her kitap için bir boş kutu ayrılır; kutu numaralarını yalnızca iki taraf ve yöneticiler görür.
3. İkisi de kitabını kendi kutusuna bırakıp "Kitabımı bıraktım" der.
4. İki kitap da bırakılınca herkes karşı tarafın kutusundan alıp "Kitabı aldım" der.
5. İkisi de alınca takas tamamlanır, kutular boşalır.

Kitap bırakılmadan önce taraflar takası iptal edebilir. Sonrasında bir aksilik olursa "Sorun bildir" kullanılır; yönetici kutuları kontrol edip karar verir.

**Kutular kilitsiz olduğu için uygulama kitabın gerçekten bırakıldığını doğrulayamaz.** Düzenli kutu kontrolü yapacak bir sorumlu belirleyin. Yönetim sayfasındaki eski tarihli açık takaslar elle kapatılmalıdır (otomatik süre dolumu yok).

## İnternette yayınlama

Herkesin kullanabilmesi için sürekli açık bir sunucu gerekir. Şartlar:

- **Kalıcı disk:** `DB_PATH` kalıcı bir diskte olmalı. Diski her yeniden başlatmada silinen servislerde (çoğu ücretsiz plan) tüm veriler kaybolur.
- **Tek kopya:** SQLite için uygulamayı tek sunucuda, tek örnek olarak çalıştırın.
- **HTTPS zorunlu:** `NODE_ENV=production` iken oturum çerezi yalnızca HTTPS üzerinden gönderilir.
- Önünde tek bir ters vekil (nginx, Caddy, platform yönlendiricisi) varsa `TRUST_PROXY=1` ayarlayın. Vekil asıl `Host` başlığını iletmelidir (nginx: `proxy_set_header Host $host;`).

Docker ile:

    docker build -t kitap-takas .
    docker run -d --restart unless-stopped -p 127.0.0.1:3000:3000 -v takas-veri:/data -e TRUST_PROXY=1 kitap-takas

Yönetici yapmak: `docker exec <konteyner> node src/yonetim.js admin senin@mailin.com`

Örnek Caddy ayarı (HTTPS sertifikasını kendisi alır):

    alanadin.com {
        reverse_proxy 127.0.0.1:3000
    }

## Bakım

- Yedek: `npm run yonetim -- yedek yedek-2026-11-26.db` (Docker'da hedefi `/data/...` yapın). Yedeği başka bir yere de kopyalayın.
- Şifresini unutan kullanıcı: `npm run yonetim -- sifre kullanici@mail.com` geçici şifre üretir. Kimliğinden emin olmadan verme.
- Testler: `npm test`

## Bilinen eksikler

- E-posta doğrulaması yok: herkes istediği adresle kayıt olabilir.
- E-posta bildirimi yok: teklifler "Hesabım" sayfasından takip edilir.
- Kitap fotoğrafı yükleme yok.
- Ad ve e-posta sakladığınız için yayına açmadan önce KVKK aydınlatma metni ekleyin. Üniversite adı ve kampüste kutu koymak için okuldan izin alın.

## Dosyalar

| Dosya | İçerik |
|---|---|
| `src/db.js` | Veritabanı tabloları |
| `src/takas.js` | İlan, teklif, takas kuralları |
| `src/auth.js` | Kayıt, giriş, oturum |
| `src/server.js` | Sayfa adresleri ve güvenlik |
| `src/views.js` | Sayfaların görünümü |
| `public/style.css` | Stil |
