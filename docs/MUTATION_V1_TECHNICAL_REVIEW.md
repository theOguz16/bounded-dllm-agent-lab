# Task 6 — Mutation v1 teknik inceleme önerisi

Durum: Kullanıcı teknik tasarımı onayladı; mutation v1 schema ve ortak doğrulama uygulandı.

## Mevcut bulgular

- `workspace-mutation.ts` claim'leri `unknown[]` olarak taşıyor. Dosya güncellemesinin ortak, kesin bir alt sözleşmesi yok.
- `deterministic-verifier-v2.ts` coder `patch_draft` claim'lerini doğruluyor. Task 3–5 ile duplicate, kapsam ve kaynak hash kontrolleri var.
- `controlled-repository-apply.ts:collectClaims` yalnız remask `repair_draft` kabul ediyor; `proposedPatch` değerini UTF-8 baytlara çeviriyor. `deriveOperations` absent baseline için create üretiyor.
- Dry-run ve temporary apply de `proposedPatch` alanını tam yeni içerik olarak yorumluyor. Sınırlar bazı yerlerde karakter, bazı yerlerde bayt cinsinden.
- Kontrollü apply no-op'u genel operation hatasıyla reddediyor; dosya modunu 0644/0755'e indirgeyebiliyor. Tam izin koruma sözleşmesi henüz yok.

## Önerilen schema

WorkspaceMutation dış zarfı korunur. Dosya değiştiren claim'ler için tek sürümlü alt sözleşme tanımlanır:

```typescript
type TextFileUpdateClaimV1 = {
  claimVersion: "text-file-update/v1";
  type: "patch_draft" | "repair_draft";
  operation: "update";
  file: string;
  expectedContentHash: string;
  newContent: string;
  description: string;
};
```

- `type` mevcut rol/target kurallarını korur; iki türün dosya işlemi anlamı aynıdır. Coder patchDraft ve remask repairDraft aynı dosya doğrulayıcısını kullanır.
- Alanlar zorunludur; bilinmeyen alanlar reddedilir. `operation` yalnız `update` olabilir.
- `newContent` dosyanın tamamının yeni içeriğidir. Unified diff uygulanmaz, içerikten işlem türü tahmin edilmez, metin trim edilmez veya satır sonları normalize edilmez.
- `newContent: ""` mevcut dosyayı sıfır bayta indirir; dosya silme değildir. Mevcut dosya zaten boşsa no-op'tur.
- Dosya başına tam bir claim vardır. Claim dosyaları ile touchedFiles birebir eşleşir; Task 4 kapsam kesişimi korunur.
- `expectedContentHash` kaynak baytlarının SHA-256 hash'idir; Task 5 gereği trusted bound context ve güncel disk baytlarıyla eşleşir.

## Ortak doğrulama ve apply anlamı

1. Ortak saf parser schema, canonical yol, duplicate, işlem, Unicode ve yeni içerik limitlerini kontrol eder. Sessiz alan silme veya işlem dönüştürme yapmaz.
2. Ortak dosya doğrulayıcısı tüm üst dizinleri ve hedefi kontrol eder. Hedef mevcut normal dosya olmalıdır; symlink, gitlink ve özel dosyalar kabul edilmez.
3. Kaynak dosya UTF-8 fatal decode ile okunur. Geçersiz UTF-8 ve NUL içeren kaynak/yeni içerik reddedilir. JavaScript string içindeki eşlenmemiş surrogate da reddedilir; Buffer dönüşümünün yerine koyma karakteri üretmesine izin verilmez. BOM, CRLF ve diğer geçerli Unicode metinleri baytları korunarak işlenir. Bu, metin politikasıdır; her olası binary formatını anlamsal olarak tanıdığı iddia edilmez.
4. Parser'ın ürettiği UTF-8 baytları dry-run, verifier ve built-in apply tarafından aynı şekilde kullanılır. Ortak operasyon kaydı kaynak hash'ini, yeni içerik hash'ini ve güvenilir dosya izinlerini taşır.
5. Apply yazmadan hemen önce kaynak hash'ini, dosya türünü ve izinlerini yeniden kontrol eder. İçerik yalnız doğrulanan baytlarla değiştirilir; kaynak izinleri aynen korunur. Model izin belirleyemez. Özel izin bitleri desteklenmiyorsa sessizce değiştirmek yerine reddedilir.
6. Herhangi bir claim no-op ise bütün mutation gereksiz değişiklik sonucu ile durur; claim ayıklanıp farklı bir mutation hash'iyle devam edilmez. İlk sürümde apply çağrılmaz.
7. Custom `applyExecutor` bağımsız bir güven sınırıdır. Runtime yalnız doğrulanmış mutation'ı verir; callback'in diske ne yazacağını garanti edemez. Yerleşik executor ve adaptörler ortak işlem sözleşmesine uymalıdır.

## Hata kodları ve sonuçlar

Ortak parser kodları verifier issue ve apply failure ayrıntılarında aynı `mutationCode` ile korunur. Dış failure sözleşmeleri korunur.

| Kod | Anlam | Sonuç |
| --- | --- | --- |
| `MUTATION_SCHEMA_INVALID` | Eksik/yanlış veya bilinmeyen alan | invalid, apply yok |
| `MUTATION_LEGACY_PATCH_FIELD` | Eski proposedPatch alanı | invalid, açık migration mesajı |
| `MUTATION_CREATE_UNSUPPORTED` | Create isteği veya absent hedef | invalid, apply yok |
| `MUTATION_DELETE_UNSUPPORTED` | Delete isteği | invalid, apply yok |
| `MUTATION_RENAME_UNSUPPORTED` | Rename isteği veya rename alanları | invalid, apply yok |
| `MUTATION_BINARY_UNSUPPORTED` | NUL veya binary/encoding isteği | invalid, apply yok |
| `MUTATION_UTF8_INVALID` | Kaynakta geçersiz UTF-8 veya yeni içerikte bozuk Unicode | invalid, apply yok |
| `MUTATION_SYMLINK_UNSUPPORTED` | Hedef veya üst bileşende symlink | invalid, apply yok |
| `MUTATION_MODE_CHANGE_UNSUPPORTED` | mode/chmod isteği veya korunamayan özel izinler | invalid, apply yok |
| `MUTATION_FILE_TYPE_UNSUPPORTED` | Directory, gitlink veya özel dosya | invalid, apply yok |
| `MUTATION_DUPLICATE_FILE` | Aynı canonical dosyaya iki claim | invalid, apply yok |
| `MUTATION_SOURCE_HASH_MISMATCH` | Trusted context/disk/claim uyuşmazlığı | replan, apply yok |
| `MUTATION_NO_CHANGE` | Kaynak ve yeni baytlar aynı | stopped + replan, apply yok |
| `MUTATION_FILE_LIMIT_EXCEEDED` | Dosya başına bayt sınırı | invalid, apply yok |
| `MUTATION_TOTAL_LIMIT_EXCEEDED` | Toplam bayt sınırı | invalid, apply yok |
| `MUTATION_FILE_COUNT_EXCEEDED` | Claim sayısı sınırı | invalid, apply yok |

Desteklenmeyen işlemlerin bilinen alanları generic unknown-field kontrolünden önce tanınır. Bir dosya context'te mevcutken sonradan silinmişse create isteği sayılmaz; source mismatch ile replan gerekir. Apply başladıktan sonraki hata mevcut rollback/recovery sözleşmesine tabidir.

## Önerilen ilk sürüm sınırları

- Dosya başına en fazla **1 MiB** kaynak ve **1 MiB** yeni içerik.
- Mutation başına kaynak toplamı ve yeni içerik toplamı ayrı ayrı en fazla **4 MiB**.
- En fazla **32 dosya**; plan/context sınırları daha darsa dar sınır geçerlidir.
- Hepsi UTF-8 bayt sınırıdır; eşitlik kabul edilir. Caller yalnız daraltabilir, ilk sürüm tavanlarını yükseltemez.
- Dosya okuması sınırlandırılır; yalnız stat kontrolünden sonra sınırsız read yapılmaz.
- Bunlar önerilen ürün limitleridir; mevcut apply'ın 100 MiB/dosya ve 1 GiB/toplam teknik tavanları canonical v1 mutation'larını genişletmez. Rollback payload limitleri ayrı kalır.

## Migration ve uygulama sırası

Bu değişiklik schema açısından kırıcıdır. Eski ve yeni alanlar sessizce eşanlamlı kabul edilmez; ikisini birden taşıyan claim reddedilir. Provider talimatları, canonical ve remask fixture'ları, dry-run, temporary apply, kontrollü apply ve doküman örnekleri birlikte taşınır. Eski mutation hash'leri yeniden kullanılamaz; governance/receipt kanıtları yeni claim üzerinden üretilir. Eski create/delete işlem kayıtlarını okuyabilen rollback/recovery kodu silinmez.

1. Teknik incelemede alan adları, no-op sonucu ve limitler onaylanır.
2. Ortak parser ve bounded dosya doğrulayıcısı yazılır.
3. Verifier ve tüm yerleşik apply girişleri ortak sözleşmeye geçirilir; raw mutation üzerinden alternatif yazma yolu bırakılmaz.
4. Provider/fixture migration'ı ve paket declaration/export doğrulaması yapılır.

## Kabul testleri

- Her desteklenmeyen işlem ayrı kodla, yazma öncesinde reddedilir; absent hedef, symlink parent, gitlink ve chmod alanı ayrıca denenir.
- Tek tam içerik update, UTF-8 çok baytlı karakterler, CRLF/BOM ve boş yeni içerik verifier ile apply'da aynı yeni içerik hash'ini üretir.
- Aynı/farklı içerikli duplicate, yanlış kaynak hash'i ve context sonrası disk değişimi Task 3–5 davranışlarını korur.
- No-op tek başına ve değişiklik yapan başka claim ile birlikte apply'ı engeller.
- Kaynak/yeni içerik için sınır−1, sınır ve sınır+1; toplam ve dosya sayısı için eşitlik/aşım test edilir. Çok baytlı Unicode ile karakter/bayt karışıklığı yakalanır.
- Hatalı UTF-8 kaynak, NUL, lone surrogate ve binary alanları reddedilir.
- Mevcut 0644/0755 ve desteklenen diğer normal izinler aynen korunur; doğrulama sonrası izin değişimi apply'ı durdurur.
- npm pack tüketicisi yeni declaration'ları paket adı üzerinden kullanabilir.

İnceleme kararı: claim schema'sı, limitler ve no-op için stopped/replan davranışı kullanıcı tarafından onaylandı.
