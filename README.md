# STLOgi — Baskı öncesi STL görüntüleyici (Bambu Lab A1)

Bilgisayarda yerel çalışan hafif bir web uygulaması. Bambu Studio'ya geçmeden önce modeli
görmek, ölçmek, yönlendirmek, kesmek ve kabaca süre/filament tahmini almak için.

## Başlatma
`Baslat.bat` dosyasına çift tıklayın. Tarayıcıda `http://localhost:4173` açılır.
Kapatmak için siyah pencereyi kapatın. (İlk çalıştırmada internet gerekir; sonrasında gerekmez.)

## STL dosyalarını çift tıklamayla açmak (bir kerelik kurulum)
1. `Baslat.bat` ile uygulamayı açın (Chrome veya Edge).
2. Üst çubuktaki yeşil **⬇ Uygulamayı yükle** düğmesine basın (görünmüyorsa adres çubuğunun
   sağındaki “yükle” simgesi). STLOgi, Başlat menüsüne kendi penceresiyle eklenir.
3. Bir STL dosyasına sağ tık → **Birlikte aç** → **STLOgi**. Hep bununla açılsın isterseniz
   “Başka uygulama seç” penceresinde **Her zaman** deyin. (3MF'yi Bambu Studio'da bırakmak
   isteyebilirsiniz; her uzantı ayrı seçilir.)
4. İlk açılışta tarayıcı “dosya açmasına izin verilsin mi?” diye sorar — izin verin.

Yüklendikten sonra `Baslat.bat` gerekmez; uygulama çevrimdışı açılır. Uygulamayı
güncellediğimde bir kez `Baslat.bat` çalıştırmanız yeni sürümü yükler.

## Neler var
- STL / OBJ / 3MF açma (sürükle-bırak veya “Aç”), birden çok nesne
- A1 tablası (256×256×256 mm), tabla dışına taşma uyarısı
- Taşı (W), Döndür (E), Ölçekle (R), sayısal konum/açı/boyut, aynalama
- Yüzeye yatır (F): tıklanan yüz tablaya oturur · Otomatik yönlendir: en az destek isteyen yön
- Ölç (M): iki nokta arası mesafe ve ΔX/ΔY/ΔZ · Esc: ölçümleri temizle
- Sarkan yüzeyleri kırmızı gösterme, destek önizlemesi (ağaç/normal, sadece tabladan)
- Süre, filament (g/m) ve maliyet tahmini; kullanım amacına göre hazır profiller
- Kesme (X/Y/Z düzlemi, kesik yüzler kapatılır), Birleştir, Parçala, Kopyala, Diz (A)
- Katman önizleme kaydırıcısı, geri al / yinele (Ctrl+Z / Ctrl+Y)
- STL Kaydet (Ctrl+S): seçili ya da tüm nesneler, dönüşümler uygulanmış
- **3MF Kaydet:** sahneyi Bambu Studio için 3MF yapar; nesnelerin tablodaki yeri ve her nesnenin AMS slot numarası (1-4) dosyaya yazılır
- **AMS renkleri:** her nesneyi 4 slottan birine ata (sol panel), renkleri sağdan değiştir. Slot başına gram, renk değişim sayısı ve kaba temizleme (flush) atığı gösterilir
- **Baskı kontrolü:** tablaya oturma, devrilme riski, ince duvar (<0,8 mm), kapalı olmayan model, tabla dışına taşma ve aşırı renk atığı uyarıları
- **Destek boyama (B):** modelin üstüne boyayarak “destek koy” / “destek koyma” bölgeleri belirle; önizlemeye yansır, 3MF'ye de yazılır
- **Çoklu plaka:** Diz nesneleri sıkı yerleştirir (gerekirse Z ekseninde 90° çevirir) ve sığmayanları otomatik plakalara dağıtır; süre/filament plaka başına ve toplam gösterilir
- **Yüzeye yazı:** Ekle bölümünde “Modele kabart / Modele oy” seçip yüzeye tıkla
- **Ekle:** küp, silindir, küre, koni; kabartma yazı (isteğe bağlı altlık plakayla); **Delik (H):** yüzeye tıkla, çap/derinlik gir
- **Kütüphane:** sahneyi küçük resim ve notla kaydet, sonradan aç; baskı geçmişi kaydı. Veriler yalnızca bu tarayıcıda saklanır
- **Baskı kaydı / kalibrasyon:** gerçek süre ve gramı gir; “Süre katsayısı” ve “Filament katsayısı” başarılı baskıların medyanına göre kendiliğinden ayarlanır

## Telefonda kullanma
Telefona uygulama olarak yüklemek için uygulamanın **https** adresinde durması gerekir (bilgisayardaki `localhost` telefondan görünmez).
`dist` klasörü düz statik dosyadır; Netlify Drop, Cloudflare Pages ya da GitHub Pages'e olduğu gibi yüklenebilir (modeller sunucuya gitmez, hepsi cihazda işlenir).
1. Telefonda Chrome ile adresi aç → menü → **Ana ekrana ekle / Uygulamayı yükle** (iPhone: Safari → Paylaş → Ana Ekrana Ekle).
2. Android'de indirdiğin STL'yi **Dosyalar/İndirilenler**'de uzun bas → **Paylaş → STLOgi** (iPhone'da bu yok; uygulamada 📂 Aç ile seç).
3. 1 parmak: döndür · 2 parmak: kaydır/yakınlaştır. Üstteki ☰ Nesneler ve ⚙ Ayarlar düğmeleri yan panelleri açar.
Bilgisayar ve telefon kütüphaneleri ayrı tutulur (veriler cihaza özeldir).

## Tahminler hakkında
Süre ve gramaj gerçek dilimleme değil, hacim tabanlı yaklaşık hesaptır. Bir baskıda Bambu
Studio'nun verdiği süre ve gramı “Baskı kaydı” bölümüne girerseniz sonraki tahminler
yazıcınıza yaklaşır. Renk değişimi atığı Bambu'nun varsayılan temizleme hacmine (≈280 mm³)
dayanan kaba bir tahmindir; gerçek değer Bambu Studio'da renk çiftine göre değişir.

## Bilinen sınırlar
- 3MF dışa aktarma Bambu Studio ile denenmedi (yalnızca dosya yapısı ve geri okuma test edildi);
  ilk kullanımda renklerin slotlara doğru oturduğunu kontrol edin, gerekirse filamentleri elle eşleyin.
- Elle destek boyaması 3MF'ye üçgen bazında (`paint_supports` 4/8) yazılır ama Bambu Studio'nun bunu okuduğu denenmedi;
  büyük üçgenler tümüyle boyanır. Okumazsa Bambu'da destek boyamasını yeniden yapın.
- Çoklu plaka: sığmayan nesneler **Diz** ile otomatik sonraki plakalara dağıtılır; 3MF Kaydet her plaka için ayrı dosya verir
  (tek dosyada çok plakalı 3MF yazılmıyor). Tek STL birden çok plakayı kapsayamaz.
- Yüzeye yazı kabartma/oyma ve delik, Boolean (CSG) ile yapılır; çıktıda küçük yüzey kusurları kalabilir
  (hacim doğru). Uygulama bunu "Baskı kontrolü"nde yumuşak uyarı olarak gösterir.
- Kütüphane tarayıcı verisini silerseniz gider; önemli dosyaların orijinallerini saklayın.

## Geliştirme
`npm install`, ardından `npm run dev`.
