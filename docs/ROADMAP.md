# Bounded Agent Runtime — Product Roadmap

Bu belge, `bounded-dllm-agent-lab` projesinin araştırma çekirdeğini tamamlayıp kullanılabilir bir geliştirici ürününe dönüştürmek için izlenecek yolu tanımlar.

Eski roadmap, tamamlanmış araştırma fazlarını ve gelecekte yapılacak işleri aynı yerde tuttuğu için güncel durumu okumayı zorlaştırıyordu. Bu sürüm geçmiş fazların ayrıntılı günlüğünü tekrar etmez. Eski çalışmalar Git geçmişinde ve `docs/results/` altındaki raporlarda korunmaktadır.

---

## 1. Ürünün Tek Cümlelik Tanımı

```text
Mevcut AI coding agent'larının daha az context ve token kullanarak,
yetkili olduğu sınırlar içinde çalışmasını ve doğrulanmış bir draft PR üretmesini
sağlayan bounded execution ve reliability runtime'ı.
```

Ürün yeni bir IDE veya sıfırdan yazılmış genel amaçlı coding agent değildir.

Ana görevleri şunlardır:

- Agent'a görevi için yeterli olan en küçük doğru context'i vermek.
- Agent'ın okuyabileceği ve değiştirebileceği alanları sınırlandırmak.
- Model çıktısını doğrudan gerçek kabul etmemek.
- Patch'i deterministik kurallarla doğrulamak.
- Gerekirse sadece hatalı bölgeyi yeniden üretmek.
- Gerçek repository değişikliğini transaction, rollback ve recovery ile yürütmek.
- Sonucu kanıtlarıyla birlikte draft PR olarak sunmak.
- Token, maliyet, risk ve karar izlerini ölçülebilir hale getirmek.

---

## 2. Şu Anki Durum

Güvenli karar ve handoff çekirdeği büyük ölçüde tamamlandı.

Çalışan ana zincir:

```text
Planner
→ Coder
→ Model mutation validation
→ Deterministic verifier
→ Gerekiyorsa Remask / Repair
→ Patch dry-run
→ Temporary workspace apply
→ İzole gerçek test çalıştırma
→ Accountability ledger
→ Shadow Observer
→ Deterministic Governance
→ Koşullu Admin
→ Risk-based approval router
→ Governed artifact
→ Controlled apply handoff
→ Durable consumption registry
```

Bugüne kadar kanıtlanan başlıca davranışlar:

- Normal ve forced-remask akışları çalışıyor.
- Bozuk veya riskli model çıktıları doğrudan runtime state'e yazılmıyor.
- Shadow ve Admin katmanları geçersiz çıktılarda fail-closed davranıyor.
- Repair, replan, human review ve terminate rotaları ayrılabiliyor.
- Governed artifact ve handoff hash ile bağlanıyor.
- Değiştirilmiş veya eski handoff reddediliyor.
- Apply, rollback, post-apply validation ve transaction recovery primitive'leri mevcut.
- Aynı handoff'un tekrar kullanılmasını engelleyen durable registry geliştirildi.

Eksik olan temel konu yeni bir güvenlik katmanı değildir. Mevcut parçaların tek bir ürün akışında birleştirilmesi ve gerçek kullanım senaryolarında doğrulanmasıdır.

---

## 3. MVP Tam Olarak Nedir?

v0.1 MVP şu kullanıcı deneyimini sağlamalıdır:

```text
Kullanıcı bir görev verir
→ runtime repository'yi ve policy'yi okur
→ bounded planner ve coder çalışır
→ verifier, remask ve governance zinciri tamamlanır
→ tek kullanımlık handoff üretilir
→ ayrı bir branch üzerinde kontrollü apply yapılır
→ testler çalıştırılır
→ commit oluşturulur
→ kanıtları içeren draft PR açılır
```

MVP'nin kullanıcıya verdiği vaat:

```text
Görevi ver; ana branch'e dokunmadan,
sınırlandırılmış, doğrulanmış ve izlenebilir bir draft PR al.
```

v0.1 aşağıdakileri yapmayacaktır:

- Otomatik merge.
- Production deployment.
- Kullanıcı onayı olmadan policy override.
- Modelin doğrudan Git veya GitHub yetkisi kullanması.
- Her model sağlayıcısını destekleme.
- Tam özellikli IDE veya dashboard.
- CodexQB veya Ponytail entegrasyonu.

Bu sınırlar bilinçlidir. Önce küçük fakat güvenilir bir ürün tamamlanacaktır.

---

## 4. Temel Kavramlar

### Governed artifact

Verifier, Shadow, Governance, Admin ve risk router kararlarını tek bir hash bağlı kanıtta birleştiren çıktıdır.

### Controlled handoff

Bir değişikliğin uygulanabileceğini söyleyen, repository snapshot'ına ve mutation'a bağlı pakettir. Patch'i kendi başına uygulamaz; executor'a hangi şartlarda ilerleyebileceğini bildirir.

### Consumption key

Bir handoff'un yalnızca bir kez işleme alınmasını sağlayan deterministik anahtardır. Aynı anahtar yeniden kullanılırsa işlem reddedilir.

### Disposable repository

Gerçek Git davranışını test etmek için `/tmp` altında oluşturulan geçici repository'dir. Test bittiğinde silinir ve kullanıcının ana reposuna dokunmaz.

### Rollback bundle

Apply öncesindeki dosya içeriklerini ve modlarını güvenli biçimde saklayan, hash ile mühürlenmiş geri dönüş paketidir.

### Transaction recovery

Process apply veya validation sırasında kapanırsa yarım işlemi tespit edip güvenli rollback ya da human review kararı veren katmandır.

### Draft PR executor

Kontrollü değişikliği ayrı branch'e uygulayan, test eden, commit eden, push eden ve draft pull request açan ürün yüzeyidir.

---

## 5. v0.1 Kapanış Planı

| Faz | Amaç | Durum |
| --- | --- | --- |
| **AB** | Durable registry'yi canlı ortamda doğrulamak | Aktif |
| **AC** | Mevcut apply primitive'lerini disposable Git repo üzerinde tek akışta birleştirmek | Sıradaki |
| **AD** | Gerçek process crash ve restart recovery davranışını kanıtlamak | Planlandı |
| **AE** | Güvenli branch, commit ve draft PR üretmek | Planlandı |
| **AF** | Birleşik benchmark, dokümantasyon ve v0.1 release hazırlamak | Planlandı |

Bu beş faz tamamlandığında araştırma çekirdeği kapatılacak ve proje v0.1 geliştirici MVP'si olarak yayınlanacaktır.

---

# Phase AB — Durable Consumption Registry

## Amaç

Aynı controlled handoff'un yalnızca bir kez kullanılabildiğini process'ler ve restart'lar arasında kanıtlamak.

Şu ana kadar handoff'un doğru, güncel ve değiştirilmemiş olduğu doğrulanabiliyordu. Fakat stateless doğrulama tek başına şu soruyu cevaplayamaz:

```text
Bu geçerli handoff daha önce kullanıldı mı?
```

Durable registry bu sorunun cevabını kalıcı olarak saklar.

## Neden gerekli?

Aynı handoff iki kez uygulanırsa:

- Aynı değişiklik iki process tarafından yarışmalı şekilde yazılabilir.
- İkinci apply beklenmeyen repository state'i oluşturabilir.
- Aynı onay paketi daha sonra replay edilebilir.
- Process yeniden başladığında önceki reservation unutulabilir.

Bu nedenle apply başlamadan önce tek ve kalıcı bir reservation kazanılmalıdır.

## Repoda zaten bulunanlar

- `packages/product-runtime/src/durable-consumption-registry.ts`
- SQLite tabanlı reservation ve finalization işlemleri
- Record integrity hash doğrulaması
- Concurrent reservation smoke testi
- Restart sonrasında registry reopen testi
- Replay ve tampering negatif senaryoları
- Live RunPod registry suite'i

## Yapılacaklar

### AB.1 — Public package export

Registry fonksiyonlarını `packages/product-runtime/src/index.ts` üzerinden export et.

Beklenen public yüzey:

```ts
inspectDurableConsumption(...)
reserveDurableConsumption(...)
finalizeDurableConsumption(...)
```

Tüketici kodunun `dist/.../durable-consumption-registry.js` gibi iç path'leri bilmemesi gerekir.

### AB.2 — Tekrarlanabilir npm komutları

`package.json` içine açık komutlar ekle:

```text
npm run test:durable-consumption-registry
npm run live:durable-consumption-registry
```

Komut isimleri dokümantasyon ve CI tarafından aynı şekilde kullanılmalıdır.

### AB.3 — Local smoke doğrulaması

Şu durumları doğrula:

1. Registry başlangıçta anahtarı kullanılabilir gösterir.
2. İlk process reservation kazanır.
3. İkinci process aynı anahtarı alamaz.
4. Database kapatılıp yeniden açıldığında kayıt korunur.
5. Başarısız işlem `failed` olarak finalize edilir.
6. Başarısız veya consumed anahtar tekrar rezerve edilemez.
7. Değiştirilmiş handoff kabul edilmez.
8. Record hash bozuksa registry fail-closed davranır.

### AB.4 — RunPod live suite

Live model-backed zincirden gerçek bir controlled handoff üret:

```text
Live Planner/Coder
→ Verifier/Remask
→ Shadow/Governance/Admin/Router
→ Governed artifact
→ Controlled handoff
→ Durable registry race
```

İki ayrı Node process aynı handoff'u reserve etmeye çalışmalıdır.

Beklenen sonuç:

```text
winner count = 1
loser count = 1
restart persistence = true
replay rejected = true
tamper rejected = true
real repository write = false
```

### AB.5 — Evidence artifact

Suite sonunda en az şu dosyalar üretilmelidir:

```text
durable-consumption-registry-summary.json
handoff.json
registry.sqlite
scenario-proxy.log
```

JSON raporu secret, patch body veya absolute private path içermemelidir.

## Hata durumları

- SQLite dosyası symlink ise reddet.
- Registry path durable bir dosya değilse reddet.
- Database kilitlenirse başarı varsayma.
- Reservation alınmadan apply aşamasına geçme.
- `failed` kaydı tekrar kullanılabilir hale getirme.
- Process restart sonrasında kayıt bulunamıyorsa human review gerektir.

## Definition of Done

Phase AB şu şartların tamamı sağlandığında biter:

- Local smoke geçer.
- RunPod live suite geçer.
- Yarışta tam olarak bir winner oluşur.
- Replay ve tamper testleri fail-closed sonuçlanır.
- Registry public export üzerinden kullanılabilir.
- npm komutları ve sonuç artifact'ı dokümante edilir.

Phase AB sonrasında yapılabilecek güvenli iddia:

```text
Controlled handoff yalnızca doğrulanmış değil, kalıcı olarak tek kullanımlıktır.
```

---

# Phase AC — Integrated Disposable Repository Apply

## Amaç

Governed handoff'tan başlayıp disposable bir Git repository üzerinde gerçek dosya değişikliği ve post-apply validation yapan tek uçtan uca executor akışı oluşturmak.

## Neden gerekli?

Mevcut modüller tek tek güçlü testlere sahip olsa da ürün kullanıcısı bu modülleri kendi eliyle birleştirmemelidir.

Kullanıcı şu on adımı ayrı ayrı çağırmak istemez:

```text
inspect
→ reserve
→ rollback bundle
→ gate
→ apply
→ validate
→ finalize
→ recovery check
→ report
→ cleanup
```

Bu işlemleri doğru sırada yürüten bir coordinator gerekir.

## Repoda zaten bulunanlar

- `controlled-repository-inspection.ts`
- `controlled-rollback-bundle.ts`
- `controlled-apply-execution-gate.ts`
- `controlled-repository-apply.ts`
- `controlled-post-apply-validation.ts`
- Apply ve rollback smoke suite'leri
- Symlink, scope drift, stale state ve race testleri

Bu fazın amacı aynı güvenlik mantığını yeniden yazmak değildir. Var olan primitive'leri tek bir transaction lifecycle'ında kullanmaktır.

## Önerilen yeni ürün yüzeyi

```ts
const result = await executeDisposableControlledApply({
  repositoryTemplate,
  handoff,
  artifact,
  mutation,
  validationSpecification,
  durableRegistryPath
});
```

Bu fonksiyon küçük bir coordinator olmalıdır. Alt modüllerdeki kuralları kopyalamamalıdır.

## Yapılacaklar

### AC.1 — Disposable Git fixture builder

Her test için bağımsız bir repository oluştur:

```text
/tmp/bounded-controlled-apply-test/<run-id>/repo
```

Builder şu işlemleri yapmalıdır:

- `git init`
- Test dosyalarını yazma
- İlk commit'i oluşturma
- Branch ve HEAD bilgisini kaydetme
- Repository, rollback bundle, registry ve validation workspace path'lerini birbirinden ayırma

Test repository'si kullanıcının proje reposunun içinde olmamalıdır.

### AC.2 — Coordinator state machine

Akışı açık state'lerle yürüt:

```text
handoff_verified
→ registry_reserved
→ repository_inspected
→ rollback_prepared
→ execution_authorized
→ mutation_applied
→ post_apply_validated
→ registry_finalized
```

Her geçiş:

- Girdi hash'lerini doğrulamalı.
- Başarı veya hata artifact'ı üretmeli.
- Önceki adım tamamlanmadıysa çalışmamalı.
- Hata durumunda bir sonraki güvenli route'u belirtmeli.

### AC.3 — Durable registry ile X4 transaction registry'yi bağlama

İki registry'nin görevi ayrılmalıdır:

```text
SQLite durable registry
= handoff replay ve process-level reservation kontrolü

X4 filesystem transaction registry
= apply adımları, receipts, markers ve recovery kanıtı
```

Doğru sıra:

```text
SQLite reservation
→ X1 inspection
→ X2 rollback bundle
→ X3 execution gate
→ X4 repository apply
→ X5 post-apply validation
→ SQLite finalization
```

X4 veya X5 başarısız olursa SQLite kaydı `failed` olarak finalize edilmeli ve tekrar kullanılmamalıdır.

### AC.4 — Gerçek validation

Patch uygulandıktan sonra validation komutları gerçek değişmiş state üzerinde, izole bir kopyada çalıştırılmalıdır.

Validation komutları:

- Güvenilir config'ten gelmeli.
- Allowlist edilmiş executable kullanmalı.
- Timeout ve output limitlerine sahip olmalı.
- Gerçek repository'yi çalışma dizini olarak kullanmamalı.
- Başarısızlıkta rollback tetiklemeli.

### AC.5 — Fault injection suite

Aşağıdaki durumları test et:

- Base commit değişmiş.
- Worktree apply öncesinde kirlenmiş.
- Handoff repository identity ile eşleşmiyor.
- Mutation allowed scope dışına çıkıyor.
- Parent directory symlink'e çevriliyor.
- Target file symlink'e çevriliyor.
- İki executor aynı handoff ile yarışıyor.
- İlk dosya yazıldıktan sonra ikinci dosyada hata oluşuyor.
- Apply sonrası dosya içeriği beklenen hash ile eşleşmiyor.
- Beklenmeyen üçüncü bir dosya değişiyor.
- Validation fail oluyor.
- Validation timeout oluyor.
- Rollback bundle değiştirilmiş.
- Registry reservation finalize edilemiyor.

### AC.6 — Birleşik sonuç artifact'ı

Executor tek bir özet üretmelidir:

```json
{
  "decision": "validated_applied_state",
  "repositoryWritePerformed": true,
  "validationPassed": true,
  "rollbackAttempted": false,
  "durableConsumptionFinalized": true,
  "gitIndexMutated": false,
  "gitHistoryMutated": false,
  "commitCreated": false,
  "pushExecuted": false
}
```

Hata raporu başarısızlığın hangi state'te oluştuğunu açıkça göstermelidir.

## Junior geliştirici için önemli sınır

Bu fazda `git add`, `git commit`, `git push` veya GitHub API çağrısı ekleme. AC'nin işi yalnızca kontrollü local apply ve validation'dır. Git geçmişi AE fazına kadar değişmeyecektir.

## Definition of Done

- Live governed handoff disposable repo coordinator'a bağlanır.
- Başarılı senaryoda mutation gerçek worktree'ye uygulanır.
- Validation geçer ve durable registry `consumed` olur.
- Validation başarısızlığında exact baseline geri gelir.
- Replay ikinci kez hiçbir write yapamaz.
- Fault injection suite yanlış başarı üretmez.
- Ana proje repository'si ve Git geçmişi değişmeden kalır.

Phase AC sonrasında yapılabilecek güvenli iddia:

```text
Sistem doğrulanmış bir handoff'u gerçek Git worktree'sine kontrollü biçimde
uygulayabilir, sonucu test edebilir ve başarısızlıkta geri alabilir.
```

---

# Phase AD — Cross-Process Crash Recovery

## Amaç

Apply veya validation process'i aniden kapandığında, yeni bir process'in transaction'ı okuyup güvenli recovery kararı verebildiğini kanıtlamak.

## Neden gerekli?

Normal exception handling her hatayı yakalayamaz.

Örnek:

```text
Dosya A yazıldı
→ process SIGKILL ile kapandı
→ Dosya B yazılmadı
→ catch/finally çalışmadı
```

Bu durumda memory içindeki state kaybolur. Recovery yalnızca disk üzerinde önceden yazılmış transaction intent, step records, rollback bundle ve registry marker'larına güvenebilir.

## Repoda zaten bulunanlar

- `controlled-transaction-recovery.ts`
- Incomplete X4/X5 transaction sınıflandırması
- Pre-write claim kapatma
- Baseline rollback
- Recovery intent ve receipt kayıtları
- Human recovery route'ları
- Recovery smoke suite'i

Bu faz yeni recovery algoritması yazmaktan çok gerçek OS process sınırını test eder.

## Yapılacaklar

### AD.1 — Crashable worker process

Apply işlemini ayrı bir child process içinde çalıştır.

Worker'a test için checkpoint'ler ekle:

```text
after_reservation
after_transaction_intent
after_write_started
after_first_file_write
after_apply_commit_marker
after_validation_intent
after_validation_started
```

Not: Checkpoint isimleri test hook'udur. Production davranışına model veya kullanıcı girdisiyle açılamamalıdır.

### AD.2 — Gerçek process kill

Parent test process'i belirlenen checkpoint'i gördüğünde child process'i kapatmalıdır.

Tercih edilen test:

```text
spawn worker
→ checkpoint dosyasını bekle
→ SIGKILL gönder
→ worker'ın gerçekten kapandığını doğrula
→ yeni recovery process başlat
```

Sadece fonksiyon içinde exception fırlatmak crash recovery kanıtı değildir.

### AD.3 — Restart sonrası inspection

Yeni process şunları okumalıdır:

- Durable consumption record
- X4 claim ve transaction kayıtları
- X5 validation kayıtları
- Rollback bundle
- Current repository HEAD, index ve worktree state

Sonra aşağıdaki action'lardan birini seçmelidir:

```text
no_action_required
run_post_apply_validation
close_prewrite_claim_without_repository_write
restore_x1_baseline
human_recovery_required
```

### AD.4 — Crash matrisi

En az şu senaryoları çalıştır:

| Crash noktası | Beklenen sonuç |
| --- | --- |
| Reservation sonrası, write öncesi | Claim kapatılır, repository değişmez |
| Transaction intent sonrası | Repository değişmez veya baseline doğrulanır |
| İlk dosya yazıldıktan sonra | Rollback ile X1 baseline geri gelir |
| Apply tamamlandı, validation başlamadı | Validation devam ettirilir |
| Validation başladı, sonuç kaydedilmedi | Incomplete validation başarılı sayılmaz; rollback veya review |
| Rollback sırasında crash | Yeni process recovery kaydını inceler; yanlış başarı üretmez |
| Concurrent dış değişiklik oluştu | Otomatik rollback durur, human review gerekir |
| HEAD değişti | Otomatik recovery engellenir |
| Git operation başladı | Otomatik recovery engellenir |

### AD.5 — Idempotent recovery

Aynı recovery komutu ikinci kez çalıştırıldığında:

- Yeni bir repository write başlatmamalı.
- Consumption claim'i serbest bırakmamalı.
- Önceki receipt'i değiştirmemeli.
- Terminal state'i aynı şekilde raporlamalı.

### AD.6 — Recovery CLI

İlk geliştirici yüzeyi:

```text
bounded recover --run <run-id>
```

Komut otomatik karar verebiliyorsa uygular; veremiyorsa hangi kanıtın eksik olduğunu ve neden insan müdahalesi gerektiğini gösterir.

## Güvenlik kuralları

- Recovery hiçbir zaman “muhtemelen başarılıydı” varsayımı yapmaz.
- Incomplete transaction `consumed/success` sayılmaz.
- Rollback yalnızca doğrulanmış sealed bundle ile yapılır.
- Unexpected değişiklikler silinmez.
- Git index ve history recovery tarafından değiştirilmez.
- Original X4/X5 kanıtları mutable değildir.

## Definition of Done

- En az üç farklı gerçek `SIGKILL` checkpoint'i test edilir.
- Restart sonrasında pre-write state güvenli biçimde kapanır.
- Mid-write state exact baseline'a döner.
- Mid-validation state yanlışlıkla başarılı sayılmaz.
- Concurrent değişiklikte human review route'u üretilir.
- Recovery iki kez çalıştırıldığında ek write yapmaz.
- Tüm sonuçlar restart öncesi ve sonrası hash'lerle raporlanır.

Phase AD sonrasında yapılabilecek güvenli iddia:

```text
Sistem yalnızca kontrollü apply yapmaz; process çökmesi sonrasında yarım
transaction'ı tespit edip güvenli rollback veya human review kararı verebilir.
```

---

# Phase AE — Draft PR Executor

## Amaç

Başarılı controlled apply sonucunu ayrı bir Git branch'ine commit edip GitHub üzerinde draft pull request olarak sunmak.

Bu faz v0.1'i gerçek bir geliştirici aracına dönüştürür.

## Neden draft PR?

Doğrudan main branch'e yazmak veya otomatik merge etmek v0.1 için gereksiz risk oluşturur.

Draft PR şu avantajları sağlar:

- İnsan değişikliği inceleyebilir.
- Test sonuçları PR üzerinde görünür olur.
- Runtime'ın karar kanıtları saklanır.
- Hatalı sonuç production'a otomatik gitmez.
- GitHub'ın mevcut review akışı korunur.

## Paket sınırı

GitHub ve Git mutation davranışı core runtime'dan ayrılmalıdır.

Önerilen paketler:

```text
@bounded/runtime
= modelden bağımsız karar, doğrulama ve handoff

@bounded/executor
= controlled local apply, rollback ve recovery

@bounded/github-executor
= branch, commit, push ve draft PR
```

Core runtime GitHub token'ı bilmemelidir.

## Yapılacaklar

### AE.1 — Executor input contract

GitHub executor yalnızca tamamlanmış ve doğrulanmış bir final receipt kabul etmelidir.

```ts
executeDraftPullRequest({
  repository,
  baseBranch,
  validatedApplyReceipt,
  governedArtifact,
  controlledHandoff,
  runReport,
  credentialsHandle
});
```

Patch veya model mesajı GitHub yetkisi elde etmemelidir.

### AE.2 — Branch oluşturma

Branch adı deterministik ve okunabilir olmalıdır:

```text
bounded/<task-slug>-<short-run-id>
```

Kurallar:

- Base branch güncel olmalı.
- Existing branch sessizce overwrite edilmemeli.
- Branch oluşturulduktan sonra base revision tekrar doğrulanmalı.
- Main/master üzerinde doğrudan commit yapılmamalı.

### AE.3 — Commit

Sadece governed changed files stage edilmelidir.

Yasaklar:

- `git add -A`
- Untracked ve yetkisiz dosyaları sessizce eklemek
- Modelin serbest commit komutu yazması
- Commit hook'larını kontrolsüz shell olarak çalıştırmak

Önerilen commit mesajı:

```text
bounded: <task summary>
```

Commit metadata'sında run ID bulunabilir; secret veya prompt eklenmemelidir.

### AE.4 — Push

GitHub credential yalnızca executor process'ine verilmelidir.

Minimum yetki hedefi:

- Repository contents write
- Pull requests write
- Gerekliyse metadata read

İlk sürüm fork, organization policy ve protected branch edge-case'lerinde fail-closed davranabilir.

### AE.5 — Draft PR oluşturma

PR başlığı görev sonucunu açıkça anlatmalıdır.

PR açıklaması şu bölümleri içermelidir:

```text
Amaç
Uygulanan plan
Değiştirilen dosyalar
Verifier kararı
Remask/repair özeti
Shadow risk gözlemi
Governance kararı
Admin çözümü
Approval route
Çalıştırılan testler
Token ve maliyet özeti
Handoff hash
Consumption key
Apply receipt hash
Rollback/recovery bilgisi
Bilinen sınırlılıklar
```

Patch body, secret, private absolute path veya tam model prompt'u PR açıklamasına yazılmamalıdır.

### AE.6 — Güvenli tekrar çalıştırma

Aynı başarılı run tekrar gönderilirse:

- İkinci branch veya PR oluşturmamalı.
- Existing PR bulunabiliyorsa onu raporlamalı.
- Consumption key ile GitHub delivery kaydı bağlanmalı.

### AE.7 — Başarısız GitHub işlemleri

- Commit oluştu fakat push başarısızsa local state raporlanır.
- Push oldu fakat PR açılamadıysa branch silinmez; recovery komutu tekrar PR açmayı deneyebilir.
- PR açıldıysa işlem başarılı kabul edilir; otomatik merge yapılmaz.
- GitHub API timeout'u aynı commit'in tekrar üretilmesine yol açmamalıdır.

## İlk CLI deneyimi

```text
bounded run "Add CSV export" --repo . --draft-pr
```

Beklenen özet:

```text
Decision: DRAFT_PR_CREATED
Branch: bounded/add-csv-export-a13f42
Tests: 4/4 passed
Changed files: 3
Unexpected files: 0
Input token saving: 58%
Human review: required before merge
```

## Definition of Done

- Ana branch değişmeden kalır.
- Governed dosyalar dışında hiçbir dosya commit edilmez.
- Validation geçmeden commit/push yapılmaz.
- Yeni branch oluşturulur.
- Tek commit veya açıkça belgelenmiş bounded commit seti üretilir.
- Draft PR açılır.
- PR açıklamasında karar ve kanıt özeti bulunur.
- Aynı run tekrar gönderildiğinde duplicate PR oluşmaz.
- Otomatik merge ve deployment yoktur.

Phase AE sonrasında yapılabilecek ürün iddiası:

```text
Görevi ver; bounded runtime doğrulanmış değişikliği ayrı branch üzerinde uygulasın,
test etsin ve kanıtlarıyla draft PR hazırlasın.
```

---

# Phase AF — Unified Benchmark, Documentation and v0.1 Release

## Amaç

Ürünün gerçekten daha güvenli, daha kontrollü ve daha düşük maliyetli olup olmadığını kapsamlı biçimde ölçmek; sonuçları tek release paketinde yayınlamak.

AF yalnızca “testlerin yeşil olması” değildir. İki farklı soruyu cevaplar:

1. **Safety:** Sistem izin verilmeyen bir işlemi engelliyor mu?
2. **Product value:** Bounded yaklaşım direct agent kullanımına göre daha az token ve daha iyi sonuç sağlıyor mu?

Bu iki soru ayrı metriklerle değerlendirilmelidir.

## AF.1 — Tek release komutu

Hedef komut:

```text
npm run verify:release
```

Bu komut sırasıyla:

```text
typecheck
→ build
→ deterministic contracts
→ security regression
→ durable registry
→ disposable apply
→ crash recovery
→ draft PR dry/live fixture
→ benchmark aggregation
→ report generation
```

çalıştırmalıdır.

Uzun ve pahalı live model testleri ayrı flag veya environment ile açılabilir:

```text
BOUNDED_LIVE_MODE=1 npm run verify:release
```

## AF.2 — Benchmark katmanları

### Katman 1: Deterministic safety suite

Her commit veya PR'da çalıştırılır.

Örnek aileler:

- Invalid model mutation
- Role write boundary ihlali
- Forbidden path
- Missing authority
- Stale artifact/handoff
- Replay
- Concurrent reservation
- Worktree drift
- Symlink race
- Apply failure
- Validation failure
- Rollback failure
- Incomplete transaction
- Tampered receipt/registry/bundle

Bu katmanda başarı hedefi nettir:

```text
Tüm release-blocking safety case'leri geçmelidir.
```

### Katman 2: Live model benchmark

Model davranışındaki varyansı ölçer.

İlk kapsam hedefi:

- En az 30 görev
- En az 5 farklı küçük/orta ölçekli repository veya fixture familyası
- Her model-backed konfigürasyon için en az 3 tekrar
- Sabit task, policy ve validation contract
- Temperature mümkün olduğunca düşük ve kaydedilmiş config

Görev aileleri:

1. Küçük bug fix
2. Tek dosyalı helper/feature
3. Paired-file değişikliği
4. Required test ekleme
5. Çok dosyalı kontrollü feature
6. Refactoring
7. Config değişikliği
8. Insufficient context
9. Missing product authority
10. Forbidden/sensitive boundary
11. Repairable verifier finding
12. Non-repairable risk

### Katman 3: Fault-injection endurance

Model kalitesinden bağımsız executor güvenilirliğini ölçer.

Örnek hedefler:

- Registry race: 50 tekrar
- Replay: 50 tekrar
- Disposable apply: farklı file order ve boyutlarla tekrar
- Process kill: her checkpoint için en az 10 tekrar
- Validation timeout/failure
- Concurrent worktree drift
- Recovery idempotency

Burada amaç performans rekoru değil, yanlış başarı üretmeyen state machine davranışıdır.

## AF.3 — Karşılaştırılacak sistemler

MVP benchmark'ında ana karşılaştırma:

```text
A — Direct large-context coding agent
B — Bounded model-backed runtime
```

Ek kontrol grupları mümkünse:

```text
C — Synthetic context, bounded verifier olmadan
D — Bounded runtime, remask kapalı
E — Bounded runtime, remask açık
```

CodexQB-style planner ve Ponytail bu benchmark'a henüz eklenmez. Önce mevcut çekirdeğin kendi katkısı ölçülür.

## AF.4 — Ölçülecek metrikler

### Görev kalitesi

- Task success rate
- Test pass rate
- Patch apply success rate
- Human reviewer acceptance
- Correct file coverage
- Required test completeness

### Scope ve güvenlik

- Scope drift rate
- Unexpected changed file count
- Forbidden write count
- Sensitive leakage count
- Missed blocker rate
- False blocker rate
- Replay rejection rate
- Rollback success rate
- Recovery success/review rate

### Maliyet

- Input token
- Output token
- Toplam token
- Gerçek API maliyeti
- Planner/coder/remask/shadow/admin token dağılımı
- Retry maliyeti
- Remask sayesinde baştan üretimden kaçınılan token tahmini

### Üretkenlik

- End-to-end latency
- Model call count
- Retry count
- Remask count
- Human intervention count
- Draft PR hazırlama süresi
- Added/deleted LOC
- Değiştirilen dosya sayısı

### İzlenebilirlik

- Trace completeness
- Artifact hash verification
- Ledger verification
- Decision reason coverage
- Receipt ve registry integrity

## AF.5 — Raporlama yöntemi

Tek bir ortalama sayı yeterli değildir.

Rapor şu değerleri göstermelidir:

- Ortalama
- Medyan
- Minimum ve maksimum
- Standard deviation veya dağılım bilgisi
- Başarı oranı için güven aralığı
- Task-family bazında ayrım
- Model ve config bilgisi
- Başarısız case listesi

Model benchmark sonuçları en az üç tekrarın birleşimi olarak raporlanmalıdır. Tek başarılı run ürün kanıtı sayılmamalıdır.

## AF.6 — Hard gates ve araştırma hedefleri

### Release-blocking hard gates

- Typecheck ve build geçmeli.
- Deterministic safety suite tamamen geçmeli.
- Concurrent registry testinde birden fazla winner oluşmamalı.
- Unauthorized repository write sıfır olmalı.
- Recoverable apply/validation failure baseline'a dönmeli.
- Incomplete transaction yanlışlıkla success sayılmamalı.
- Draft PR executor main branch'e yazmamalı.
- Otomatik merge veya deployment gerçekleşmemeli.

### Ürün değerini değerlendiren hedefler

Bunlar başarısız olduğunda güvenlik release'i mutlaka bloklamaz; fakat ürün iddiası küçültülmelidir.

Araştırılacak hipotezler:

- Bounded runtime median input token kullanımını azaltıyor mu?
- Task success direct baseline ile en azından benzer kalıyor mu?
- Scope drift belirgin biçimde düşüyor mu?
- Remask full retry'a göre daha düşük maliyetli mi?
- Ek governance çağrıları toplam tasarrufu yok ediyor mu?
- İnsan review süresi azalıyor mu?

Sonuç beklenenden kötü çıkarsa saklanmaz. Mimari veya ürün mesajı benchmark sonucuna göre değiştirilir.

## AF.7 — Release artifact'ları

v0.1 release içinde:

```text
README quickstart
ROADMAP
Architecture diagram
Threat model
Unified benchmark report
Ablation report
Fail-closed matrix
Token/cost report
Live demo runbook
Known limitations
Migration/versioning notes
Release notes
```

bulunmalıdır.

## AF.8 — v0.1 paket sınırları

İlk release için hedef:

```text
@bounded/runtime
@bounded/executor
@bounded/github-executor
@bounded/cli
@bounded/policy
```

Mevcut monorepo yapısı hemen ayrı npm paketleri olarak yayınlanmak zorunda değildir. Önce internal boundaries netleştirilir; public API daha sonra stabilize edilir.

## Definition of Done

- `npm run verify:release` reproducible biçimde çalışır.
- Local ve live sonuçlar ayrı raporlanır.
- Direct vs bounded karşılaştırması tamamlanır.
- Safety ve product-value metrikleri karıştırılmaz.
- Başarısız ve sınırlı sonuçlar raporda açıkça yer alır.
- README yeni kullanıcı için sadeleştirilir.
- v0.1 tag ve release notes hazırlanır.
- Araştırma çekirdeğine yeni faz ekleme durdurulur.

Phase AF sonrasında proje şu noktada kabul edilir:

```text
Araştırma çekirdeği tamamlandı.
Kullanılabilir draft PR MVP'si mevcut.
Ürünün faydası ve sınırları benchmark ile ölçüldü.
```

---

# 6. MVP Sonrasında Ürün Nereye Gidecek?

v0.1 sonrasında amaç WrongStack benzeri her özelliği içinde barındıran yeni bir coding platformu yapmak değildir.

Ürün şu yöne kayacaktır:

```text
AI Coding Cost and Reliability Layer
```

Yani Codex, Claude Code, Cursor, OpenCode veya başka bir agent'ın üstünde çalışan; context, maliyet, scope ve final patch güvenilirliğini yöneten bağımsız katman.

Uzun vadeli kullanıcı akışı:

```text
Kullanıcı görevi verir
→ proje intelligence görevi anlar
→ planner implementation contract üretir
→ runtime minimum doğru context'i seçer
→ uygun model ve bütçe belirlenir
→ coding agent patch üretir
→ policy pack'leri uygulanır
→ deterministic verifier karar verir
→ controlled executor draft PR üretir
→ maliyet ve güvenilirlik raporlanır
```

---

# 7. Post-MVP Stage 1 — Bounded Project Planner

Bu aşama CodexQB'nin faydalı fikirlerini TypeScript-native şekilde bounded mimariye kazandırır.

Hedef CodexQB'nin tamamını kopyalamak değildir. İhtiyaç duyulan parçalar:

- Repository comprehension
- Project autopsy
- Domain ve dependency görünümü
- Büyük hedefi küçük görevlere bölme
- Implementation contract
- Plan audit
- Task ledger ve provenance

## Neden MVP'den sonra?

Planner'ı şimdi eklemek:

- AB–AF kapanışını geciktirir.
- Benchmark baseline'ını değiştirir.
- Güvenli executor ile planlama kalitesinin etkisini birbirine karıştırır.
- Hangi kazancın bounded core'dan geldiğini ölçmeyi zorlaştırır.

Önce v0.1 baseline'ı sabitlenir. Planner daha sonra aynı benchmark üzerinde ayrı bir ablation olarak ölçülür.

## İki çalışma modu

### Quick Mode

Küçük ve açık görevler:

```text
Task
→ lightweight repo context
→ bounded execution
```

### Project Mode

Büyük veya belirsiz görevler:

```text
Goal
→ repo comprehension
→ phase/task decomposition
→ implementation contract
→ plan audit
→ bounded execution
```

## Implementation contract örneği

```yaml
task_id: export-csv
objective: Add CSV export to the report page
allowed_paths:
  - packages/reporting/**
  - tests/reporting/**
forbidden_paths:
  - packages/auth/**
required_tests:
  - npm run test:reporting
acceptance_criteria:
  - CSV contains visible report columns
  - Existing JSON export remains unchanged
risk_class: medium
```

Bu contract bounded runtime'ın scope, context ve verifier input'u olur.

## Lisans ve kod kullanımı

Dış projeden kod doğrudan kullanılırsa lisans ve copyright bildirimleri korunmalıdır. Fikirlerin sıfırdan TypeScript implementasyonu ile doğrudan port arasında açık karar verilmelidir. Kaynak belirsiz bırakılmamalıdır.

---

# 8. Post-MVP Stage 2 — Conditional Minimality Policy

Bu aşama Ponytail'ın “gereksiz kod yazma” yaklaşımını koşullu bir policy pack olarak ekler.

Ponytail sistemin karar otoritesi değildir.

Doğru sıra:

```text
Task planlandı
→ scope ve authority onaylandı
→ görev minimality için uygun mu kontrol edildi
→ minimality policy aktif edildi
→ coder küçük patch üretir
→ deterministic verifier final kararı verir
```

## İlk policy kuralları

```yaml
minimality:
  prefer_existing_code: true
  prefer_standard_library: true
  prefer_native_platform: true
  prefer_installed_dependency: true
  new_dependency_requires_justification: true
  new_abstraction_requires_reuse_case: true
  generated_file_count_budget: 0
```

## Ne zaman aktif olabilir?

- Küçük bug fix
- CRUD değişikliği
- UI component düzenlemesi
- Basit helper
- Düşük riskli refactoring
- Mevcut pattern'in devamı

## Ne zaman otomatik açılmamalı?

- Authentication ve authorization
- Ödeme
- Database migration
- Cryptography
- Concurrency
- Performance-critical code
- Public API redesign
- Compliance ve privacy

Minimal patch hedefi correctness, security veya test coverage'ın önüne geçemez.

---

# 9. Post-MVP Ablation Benchmark

Planner ve minimality eklendikten sonra aynı görev seti tekrar çalıştırılmalıdır.

Karşılaştırma:

```text
A — Direct agent
B — Bounded v0.1
C — Bounded + project planner
D — Bounded + conditional minimality
E — Bounded + planner + conditional minimality
```

Bu test şu sorulara cevap verir:

- Token tasarrufunun ne kadarı context bounding'den geliyor?
- Planner görev başarısını gerçekten artırıyor mu?
- Planner'ın ek token maliyeti kazancına değiyor mu?
- Minimality diff ve LOC'u azaltıyor mu?
- Minimality karmaşık görevlerde eksik çözüm üretiyor mu?
- Tam sistem insan review süresini azaltıyor mu?

Bir bileşen fayda sağlamıyorsa yalnızca mimari olarak güzel göründüğü için core üründe tutulmamalıdır.

---

# 10. Post-MVP Ürün Katmanları

## Çoklu agent/provider adapter'ları

```text
Codex adapter
Claude Code adapter
OpenAI-compatible adapter
Local model adapter
WrongStack adapter
```

Core runtime hiçbir sağlayıcıya bağımlı olmamalıdır.

## Akıllı model routing

```text
Basit görev → ucuz model
Karmaşık plan → güçlü model
Deterministik kontrol → kod/rule engine
Lokal repair → küçük model veya remask worker
Yüksek risk → güçlü model + human review
```

Routing kararı kalite, token bütçesi ve geçmiş benchmark verisine dayanmalıdır.

## Policy packs

```text
Minimality
Secure coding
Dependency governance
Architecture boundaries
Required tests
Database migration safety
Frontend accessibility
API compatibility
```

Policy pack'leri model prompt'u olmaktan çok deterministik ve test edilebilir kurallara dönüşmelidir.

## GitHub App

- Repository installation
- Minimum permissions
- Policy file discovery
- Draft PR creation
- PR check/status publishing
- Team approval integration

## Developer experience

İlk yüzey CLI'dır. Daha sonra:

- VS Code extension
- Static/local run viewer
- Team dashboard
- GitHub App UI
- Hosted ve self-hosted seçenekler

UI, artifact ve public API şemaları stabil olmadan önceliklendirilmemelidir.

## Cost intelligence

- Model bazında gerçek maliyet
- Repo ve görev bazında token kullanımı
- Direct vs bounded farkı
- Başarısız deneme maliyeti
- Remask tasarrufu
- Planner overhead
- Ekip bazında aylık trend

Ürün değeri kullanıcıya yalnızca “güvenli” diyerek değil, ölçülebilir tasarruf ve daha az hatalı değişiklik ile gösterilmelidir.

---

# 11. Önerilen Paket Mimarisi

```text
@bounded/runtime
├── workspace contracts
├── mutation validation
├── deterministic verifier
├── remask routing
├── shadow/governance/admin/router
├── governed artifact
└── controlled handoff

@bounded/executor
├── durable consumption coordination
├── repository inspection
├── rollback bundle
├── apply transaction
├── post-apply validation
└── crash recovery

@bounded/github-executor
├── branch
├── commit
├── push
├── draft PR
└── GitHub delivery idempotency

@bounded/policy
├── policy schema
├── project policy
├── minimality pack
├── security pack
└── architecture pack

@bounded/planner
├── repo comprehension
├── task decomposition
├── implementation contract
└── plan audit

@bounded/cli
└── kullanıcı komutları ve rapor çıktısı
```

Paketlerin birbirinin iç detaylarını bilmesi yerine stable contract ve hash bağlı artifact üzerinden konuşması hedeflenmelidir.

---

# 12. Ürün İlkeleri

## 1. Model output'u karar değildir

Model yalnızca öneri veya workspace mutation üretir. Final authority deterministik gate ve policy katmanındadır.

## 2. Daha büyük context değil, daha doğru context

Agent'a tüm repository'yi vermek varsayılan çözüm değildir. Context seçimi ölçülmeli ve neden dahil/dışarıda bırakıldığı raporlanmalıdır.

## 3. Repair lokal olmalıdır

Verifier tek bir bölgeyi hatalı bulduysa bütün görevi baştan üretmek yerine o bölge için remask veya repair açılmalıdır.

## 4. Kanıtsız başarı yoktur

Apply, validation, rollback, recovery ve PR delivery sonuçları receipt veya artifact olmadan başarılı kabul edilmez.

## 5. Fail-closed varsayılandır

State belirsiz, stale, bozuk veya eksikse sistem tahmin yürütmez. İşlem durur veya human review'a gider.

## 6. İnsan review korunur

v0.1'in final ürünü draft PR'dır. Otomatik merge ürün başarısı olarak görülmez.

## 7. Benchmark ürün kararını belirler

Yeni agent, planner veya policy katmanı yalnızca çalıştığı için core'a eklenmez. Aynı benchmark üzerinde ölçülebilir katkı göstermelidir.

## 8. Research ve product artifact'ları ayrılmalıdır

Deneysel dLLM modelleri, product runtime'ın zorunlu dependency'si olmamalıdır. Araştırma yeni modelleri test edebilir; ürün doğrulanmış ve değiştirilebilir adapter'lar kullanır.

---

# 13. Önerilen Issue ve Commit Sırası

## Phase AB

1. Export durable registry from product runtime.
2. Add local/live registry npm scripts.
3. Run local registry regression.
4. Run RunPod live registry suite.
5. Publish Phase AB evidence summary.

## Phase AC

1. Add disposable repository fixture builder.
2. Add controlled apply coordinator contract.
3. Integrate SQLite reservation with X1–X5 lifecycle.
4. Add successful apply/validation path.
5. Add fault-injection matrix.
6. Publish Phase AC evidence summary.

## Phase AD

1. Add crashable executor worker.
2. Add checkpoint test hooks.
3. Add SIGKILL parent harness.
4. Add restart recovery matrix.
5. Add idempotent recovery CLI.
6. Publish Phase AD evidence summary.

## Phase AE

1. Create GitHub executor package boundary.
2. Add branch and exact-file staging.
3. Add controlled commit.
4. Add push recovery state.
5. Add draft PR creation and evidence body.
6. Add duplicate delivery protection.
7. Publish first end-to-end draft PR demo.

## Phase AF

1. Add unified release command.
2. Freeze benchmark task set and baselines.
3. Run deterministic safety benchmark.
4. Run live direct-vs-bounded benchmark.
5. Run executor fault-injection endurance.
6. Generate unified reports and diagrams.
7. Update README, status matrix and runtime docs.
8. Tag and publish v0.1.

Bir fazın ortasında başka ürün özelliklerine geçilmemelidir. Her faz kendi evidence artifact'ı ile kapanmalıdır.

---

# 14. v0.1 Tamamlanma Kriteri

Aşağıdaki maddeler tamamlanmadan MVP hazır sayılmaz:

- Durable registry process yarışında tek winner üretiyor.
- Replay restart sonrasında da reddediliyor.
- Disposable repository apply gerçek dosya write yapıyor.
- Apply öncesinde rollback bundle hazırlanıyor.
- Validation başarısızlığında baseline geri geliyor.
- Gerçek process crash sonrasında recovery çalışıyor.
- Main branch'e doğrudan yazılmıyor.
- Başarılı akış draft PR oluşturuyor.
- Draft PR kanıt ve maliyet özetini içeriyor.
- Direct vs bounded benchmark tamamlanıyor.
- Güvenlik matrisi yanlış başarı üretmiyor.
- Release komutu ve quickstart yeni bir makinede tekrarlanabiliyor.
- Bilinen sınırlılıklar açıkça belgeleniyor.

---

# 15. Nihai Vizyon

Projenin uzun vadeli hedefi:

```text
Her coding agent'ı değiştirmek yerine,
her coding agent'ın daha az context ile, daha düşük maliyetle,
daha dar yetkiyle ve doğrulanabilir kanıtlarla çalışmasını sağlayan ortak runtime.
```

Rekabet avantajı en çok özelliğe sahip olmak değildir.

Rekabet avantajı:

- Minimum doğru context
- Ölçülebilir token tasarrufu
- Deterministik scope ve authority kontrolü
- Lokal repair
- Transaction-safe repository apply
- Crash recovery
- Kanıtlı draft PR
- Provider bağımsızlığı
- Açık benchmark sonuçları

Önce AB–AF ile bu çekirdek tamamlanacaktır. Daha sonra Bounded Project Planner, conditional minimality policy ve çoklu agent adapter'ları aynı ölçüm sistemi üzerinde kontrollü biçimde eklenecektir.
