# Bounded Agent Runtime — Product Roadmap

Bu belge, `bounded-dllm-agent-lab` projesinin araştırma çekirdeğini tamamlayıp kullanılabilir bir geliştirici ürününe dönüştürmek için izlenecek yolu tanımlar.

Geçmiş fazların ayrıntılı günlüğü burada tekrar edilmez. Tamamlanan çalışmalar Git geçmişinde ve `docs/results/` altındaki raporlarda korunur. Bu roadmap yalnızca güncel durum, v0.1 kapanış çizgisi, benchmark planı ve ürün yönünü anlatır.

---

## 1. Ürünün Tek Cümlelik Tanımı

```text
Mevcut AI coding agent'larının bounded context ve açık scope sözleşmeleriyle
 daha az token kullanmasını, scope drift ve gereksiz dosya değişikliklerini
 azaltmasını, yalnızca yetkili olduğu alanlarda çalışmasını ve doğrulanmış bir
 draft PR üretmesini sağlayan execution ve reliability runtime'ı.
```

Ürün yeni bir IDE veya sıfırdan yazılmış genel amaçlı coding agent değildir.

Ana görevleri:

- Agent'a görevi için yeterli olan en küçük doğru context'i vermek.
- Context'in gerçekten yeterli olup olmadığını ölçmek.
- Eksik context varsa kontrollü genişletme istemek.
- Yeterli kanıt yoksa kod yazmak yerine durmak.
- Okunabilir ve değiştirilebilir alanları sınırlandırmak.
- Scope drift ve gereksiz dosya değişikliklerini azaltmak.
- Model çıktısını doğrudan gerçek kabul etmemek.
- Patch'i deterministik kurallarla doğrulamak.
- Gerekirse yalnızca hatalı bölgeyi yeniden üretmek.
- Repository değişikliğini transaction, rollback ve recovery ile yürütmek.
- Sonucu kanıtlarıyla draft PR olarak sunmak.
- Token, maliyet, risk ve karar izlerini ölçülebilir hale getirmek.

---

## 2. Şu Anki Durum

Güvenli karar ve handoff çekirdeği büyük ölçüde tamamlandı.

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

Kanıtlanan başlıca davranışlar:

- Normal ve forced-remask akışları çalışıyor.
- Bozuk veya riskli model çıktıları runtime state'e doğrudan yazılmıyor.
- Shadow ve Admin geçersiz çıktılarda fail-closed davranıyor.
- Repair, replan, human review ve terminate rotaları ayrılabiliyor.
- Governed artifact ve handoff hash ile bağlanıyor.
- Değiştirilmiş veya eski handoff reddediliyor.
- Apply, rollback, post-apply validation ve recovery primitive'leri mevcut.
- Durable registry aynı handoff'un tekrar kullanımını engelliyor.

Mevcut Context Composer v1 şunları yapıyor:

- Role-specific bounded view üretiyor.
- Token bütçesi ve tahmini kullanım raporluyor.
- Dahil edilen ve dışarıda bırakılan fact'leri gösteriyor.
- `low | medium | high` context risk etiketi üretiyor.

Henüz eksik olan bölüm:

- Semantic context sufficiency kontrolü.
- Eksik symbol, dependency, caller veya test algılama.
- Yapılandırılmış context request contract'ı.
- Kontrollü context expansion döngüsü.
- Yetersiz context'te fail-closed execution gate.

Bu nedenle v0.1 yalnızca repository executor entegrasyonunu değil, minimum bir Context Sufficiency Gate'i de içermelidir.

---

## 3. v0.1 MVP

Kullanıcı deneyimi:

```text
Kullanıcı görev verir
→ runtime repository ve policy'yi okur
→ başlangıç bounded context'i oluşturur
→ Context Sufficiency Gate çalışır
→ gerekirse sınırlı context expansion yapılır
→ planner ve coder çalışır
→ verifier, remask ve governance tamamlanır
→ tek kullanımlık handoff üretilir
→ ayrı branch üzerinde kontrollü apply yapılır
→ testler çalışır
→ commit oluşturulur
→ kanıtları içeren draft PR açılır
```

MVP vaadi:

```text
Görevi ver; ana branch'e dokunmadan,
scope drift'i sınırlandırılmış, context'i doğrulanmış,
izlenebilir ve kanıtlı bir draft PR al.
```

v0.1 şunları yapmayacaktır:

- Otomatik merge.
- Production deployment.
- Kullanıcı onayı olmadan policy override.
- Modelin doğrudan Git veya GitHub yetkisi kullanması.
- Her provider'ı destekleme.
- Tam özellikli IDE veya dashboard.
- CodexQB veya Ponytail entegrasyonu.

---

## 4. Temel Kavramlar

### Bounded context

Agent'ın rolü ve görevi için seçilmiş, token bütçesi bulunan sınırlı context paketidir.

### Context sufficiency

Context'in küçük olması değil, görevi güvenilir biçimde çözmek için gerekli kanıtları içerip içermediğidir.

### Scope drift

Agent'ın görevin gerektirdiği dosya, modül, davranış veya değişiklik sınırının dışına taşmasıdır.

### Governed artifact

Verifier, Shadow, Governance, Admin ve router kararlarını hash bağlı kanıtta birleştirir.

### Controlled handoff

Doğrulanmış mutation'ın hangi şartlarda executor'a devredilebileceğini tanımlar.

### Consumption key

Bir handoff'un yalnızca bir kez işleme alınmasını sağlayan deterministik anahtardır.

### Rollback bundle

Apply öncesindeki dosya içeriklerini ve modlarını saklayan mühürlenmiş geri dönüş paketidir.

### Transaction recovery

Process kapanırsa yarım işlemi tespit edip rollback veya human review kararı verir.

### Draft PR executor

Kontrollü değişikliği branch'e uygulayan, test eden, commit eden, push eden ve draft PR açan yüzeydir.

---

## 5. v0.1 Kapanış Planı

| İş | Amaç | Durum |
| --- | --- | --- |
| **AB** | Durable registry'yi canlı ortamda doğrulamak | Aktif |
| **CSG v1** | Context'in yeterli olup olmadığını kontrol eden minimum gate | Zorunlu yatay iş |
| **AC** | Disposable Git repo üzerinde entegre apply | Sıradaki |
| **AD** | Gerçek crash ve restart recovery | Planlandı |
| **AE** | Güvenli branch, commit ve draft PR | Planlandı |
| **AF** | Birleşik benchmark, dokümantasyon ve v0.1 release | Planlandı |

CSG yeni bir sonsuz faz serisi değildir. AB–AF içinde tamamlanacak, planner/coder çağrılarından önce çalışan release-blocking bir runtime gate'tir.

---

# Context Sufficiency Gate v1

## Amaç

Dar context kullanımının token tasarrufu sağlarken görev kalitesini düşürmesini engellemek.

Doğru ilke:

```text
Her zaman en az context'i kullanma.
Görev için gerekli olan minimum doğru context'i kullan.
```

## Mevcut durum

Var:

- Role-specific views.
- Token budgets.
- Included/excluded fact raporu.
- Kaba `contextSufficiencyRisk` etiketi.

Yok:

- Semantic missing-evidence listesi.
- Context request mutation'ı.
- Expansion state machine.
- Expansion sonrası yeniden değerlendirme.
- Context yetersizse coder'ı durduran gate.

## CSG.1 — Context contract

Önerilen kararlar:

```ts
type ContextSufficiencyDecision =
  | "context_sufficient"
  | "context_expansion_required"
  | "replan_required"
  | "human_review_required";
```

Önerilen rapor:

```ts
type ContextSufficiencyReport = {
  decision: ContextSufficiencyDecision;
  missingEvidence: string[];
  unresolvedSymbols: string[];
  missingFiles: string[];
  missingTests: string[];
  requestedExpansionTokens: number;
  expansionAttempt: number;
  confidence: number;
};
```

## CSG.2 — Workspace mutation hedefi

Mutation contract'a eklenir:

```text
contextRequest
```

Planner veya coder şu alanları isteyebilir:

- `requestedSymbols`
- `requestedFiles`
- `requestedTests`
- `reason`
- `scopeExpansionRequested`

Agent serbest şekilde “daha fazla context ver” dememelidir.

## CSG.3 — Minimum evidence kontrolleri

v1 en az şunları kontrol eder:

- Değiştirilecek kaynak dosya context'te mi?
- İlgili paired file gerekli mi?
- Required test mapping mevcut mu?
- Authority ve policy bilgisi var mı?
- Coder görünmeyen dosya veya symbol hakkında claim üretiyor mu?
- Context bütçesi aşılmış mı?
- Talep edilen dosya allowed scope veya read-only repo context içinde mi?

v1 tam call graph veya kusursuz semantic index iddiasında bulunmaz.

## CSG.4 — Adaptive expansion

```text
Initial bounded context
→ sufficiency check
→ valid context request
→ deterministic repo lookup
→ bounded expansion
→ sufficiency re-check
→ coder execution veya safe stop
```

Önerilen limitler:

- En fazla 2 expansion.
- Her expansion için ayrı token limiti.
- Toplam context için hard budget.
- Aynı dosyanın tekrar istenmesini engelleme.
- Scope genişletme gerekiyorsa otomatik onay vermeme.

## CSG.5 — Fail-closed davranış

Context yeterli değilse:

- Coder patch üretemez.
- Handoff oluşturulamaz.
- Apply çalışamaz.
- `replan_required` veya `human_review_required` üretilir.

`contextSufficiencyRisk: high` yalnızca rapor alanı olarak kalmamalı; execution kararına bağlanmalıdır.

## Definition of Done

- `contextRequest` contract ve validator testleri geçer.
- Missing source/test/authority fixture'ları doğru route üretir.
- En az bir fixture expansion sonrası başarıyla tamamlanır.
- Expansion limiti aşılırsa safe stop oluşur.
- Context yetersizken patch veya handoff üretilmez.
- Tüm expansion'lar token ve provenance raporuna yazılır.

---

# Phase AB — Durable Consumption Registry

## Amaç

Aynı controlled handoff'un process'ler ve restart'lar arasında yalnızca bir kez kullanılabildiğini kanıtlamak.

## Yapılacaklar

- Registry public export'una eklenecek.
- Local ve live npm scriptleri eklenecek.
- İki process aynı key için yarışacak; tek winner çıkacak.
- Restart sonrası kayıt korunacak.
- Replay ve tamper fail-closed reddedilecek.
- Evidence artifact üretilecek.

## Definition of Done

- Local smoke PASS.
- RunPod live suite PASS.
- Winner count tam olarak 1.
- Replay ve tamper reddediliyor.
- Gerçek repository write yapılmıyor.

---

# Phase AC — Integrated Disposable Repository Apply

## Amaç

Governed handoff'tan başlayıp disposable Git repo üzerinde gerçek dosya değişikliği ve post-apply validation yapan tek coordinator oluşturmak.

```text
handoff verified
→ durable reservation
→ repository inspection
→ rollback bundle
→ execution gate
→ controlled apply
→ post-apply validation
→ registry finalization
```

## Kurallar

- Kullanıcının ana reposuna dokunulmaz.
- `git add`, commit, push veya GitHub API kullanılmaz.
- Validation başarısızsa exact baseline geri gelir.
- Scope dışı mutation hiçbir write yapamaz.
- Symlink, stale state, dirty worktree ve race senaryoları fail-closed olur.

## Definition of Done

- Başarılı mutation disposable worktree'ye uygulanır.
- Validation gerçek değişmiş state üzerinde geçer.
- Başarısızlıkta rollback tamamlanır.
- Replay ikinci write üretemez.
- Ana repo ve Git geçmişi değişmez.

---

# Phase AD — Cross-Process Crash Recovery

## Amaç

Apply veya validation process'i `SIGKILL` ile kapandığında yeni process'in transaction'ı okuyup güvenli recovery yapabildiğini kanıtlamak.

Test checkpoint'leri:

```text
after_reservation
after_transaction_intent
after_write_started
after_first_file_write
after_apply_complete
after_validation_started
```

Beklenen recovery route'ları:

```text
no_action_required
close_prewrite_claim
run_post_apply_validation
restore_baseline
human_recovery_required
```

## Definition of Done

- Pre-write crash repository'yi değiştirmez.
- Mid-write crash baseline'a döner.
- Mid-validation crash başarı sayılmaz.
- Concurrent dış değişiklik human review üretir.
- Recovery ikinci çalıştırmada ek write yapmaz.

---

# Phase AE — Draft PR Executor

## Amaç

Başarılı controlled apply sonucunu ayrı branch'e commit edip kanıtlarıyla draft PR olarak sunmak.

Önerilen paket ayrımı:

```text
@bounded/runtime
@bounded/executor
@bounded/github-executor
```

PR açıklaması:

- Amaç ve plan.
- Değiştirilen dosyalar.
- Context sufficiency ve expansion özeti.
- Verifier ve remask kararı.
- Shadow, Governance, Admin ve approval route.
- Test sonuçları.
- Token ve maliyet özeti.
- Scope drift / unexpected file özeti.
- Handoff, consumption ve receipt hash'leri.
- Rollback/recovery bilgisi.
- Bilinen sınırlılıklar.

## Güvenlik kuralları

- Main/master üzerinde doğrudan commit yok.
- Validation geçmeden commit veya push yok.
- `git add -A` yok.
- Yalnız governed dosyalar stage edilir.
- Aynı run duplicate branch veya PR üretmez.
- Otomatik merge ve deployment yok.

## Definition of Done

- Ana branch değişmeden kalır.
- Yeni bounded branch oluşturulur.
- Kontrollü commit ve push yapılır.
- Draft PR açılır.
- Duplicate delivery engellenir.

---

# Phase AF — Unified Benchmark and v0.1 Release

## Amaç

Sistemin gerçekten daha güvenli, daha az scope drift üreten ve daha düşük maliyetli olup olmadığını ölçmek.

## AF.1 — Release komutu

```text
npm run verify:release
```

Akış:

```text
typecheck
→ build
→ deterministic safety
→ context sufficiency
→ durable registry
→ disposable apply
→ crash recovery
→ draft PR fixture
→ benchmark aggregation
→ report generation
```

## AF.2 — Ana karşılaştırma

```text
A — Direct large-context coding agent
B — Fixed bounded context
C — Adaptive bounded context + sufficiency gate
```

Asıl ürün hedefi C'dir.

Ek ablation'lar:

```text
D — Adaptive bounded, verifier kapalı
E — Adaptive bounded, remask kapalı
F — Adaptive bounded, remask açık
```

CodexQB-style planner ve Ponytail bu benchmark'a eklenmez. Önce mevcut v0.1 çekirdeğinin katkısı ölçülür.

## AF.3 — Context benchmark aileleri

### Missing-context fixtures

Kritik source, type, helper, caller veya test bilinçli olarak context'ten çıkarılır.

İyi sonuç:

```text
context_expansion_required
```

Kötü sonuç:

```text
Agent eksik bilgiyi tahmin ederek patch üretir.
```

### Distractor-context fixtures

Gerekli dosyalara çok sayıda ilgisiz dosya eklenir. Sonuç, scope ve patch kararı gereksiz şekilde değişmemelidir.

### Context ablation

Tam context paketinden parçalar tek tek çıkarılır:

- Source file.
- Test file.
- Interface/type.
- Caller.
- Policy.
- Authority.

### Expansion fixtures

İlk context eksik olur; sistem doğru dosyayı getirir ve ikinci denemede görevi tamamlar.

## AF.4 — Ölçümler

### Görev kalitesi

- Task success rate.
- Test pass rate.
- Patch apply success.
- Human reviewer acceptance.
- Correct file coverage.

### Scope ve güvenlik

- Scope drift rate.
- Unexpected changed file count.
- Forbidden write count.
- Missed blocker rate.
- False blocker rate.
- Replay rejection.
- Rollback ve recovery success.

### Context sufficiency

- Context Sufficiency Detection Rate.
- False Sufficiency Rate.
- Unnecessary Expansion Rate.
- Expansion Success Rate.
- Average expansion count.
- Context budget overrun rate.
- Full-context ile task success farkı.

### Maliyet

- Input, output ve toplam token.
- Gerçek API maliyeti.
- Role bazında token dağılımı.
- Expansion maliyeti.
- Retry/remask maliyeti.
- Cost per accepted patch.

### Üretkenlik

- End-to-end latency.
- Model call count.
- Human intervention count.
- Draft PR hazırlama süresi.
- Added/deleted LOC.
- Değiştirilen dosya sayısı.

## AF.5 — Hard gates

- Deterministic safety suite tamamen geçer.
- Context yetersizken patch/handoff üretilmez.
- Registry yarışında birden fazla winner oluşmaz.
- Unauthorized write sıfırdır.
- Recoverable failure baseline'a döner.
- Incomplete transaction success sayılmaz.
- Draft PR executor main'e yazmaz.
- Otomatik merge veya deployment yapılmaz.

Ürün hipotezleri:

- Adaptive bounded context token kullanımını düşürüyor mu?
- Task success full context'e yakın veya daha iyi mi?
- Scope drift belirgin biçimde azalıyor mu?
- False sufficiency kabul edilebilir seviyede mi?
- Expansion overhead toplam tasarrufu yok ediyor mu?
- Remask full retry'dan daha ucuz mu?

Sonuç kötü çıkarsa saklanmaz; ürün iddiası benchmark sonucuna göre daraltılır.

## AF.6 — Release artifact'ları

- README quickstart.
- Architecture diagram.
- Threat model.
- Unified benchmark report.
- Context sufficiency report.
- Ablation report.
- Fail-closed matrix.
- Token/cost report.
- Demo runbook.
- Known limitations.
- v0.1 release notes.

## Definition of Done

- `npm run verify:release` tekrarlanabilir çalışır.
- Direct, fixed bounded ve adaptive bounded kıyası tamamlanır.
- Safety ve product-value metrikleri ayrı raporlanır.
- v0.1 tag hazırlanır.
- Araştırma çekirdeğine yeni faz ekleme durdurulur.

---

## 6. MVP Sonrası Ürün Yönü

```text
AI Coding Cost and Reliability Layer
```

Codex, Claude Code, Cursor, OpenCode veya başka bir coding agent'ın üstünde çalışan; context, maliyet, scope ve final patch güvenilirliğini yöneten bağımsız katman.

Uzun vadeli akış:

```text
Task
→ Repo Intelligence
→ CodexQB-inspired Bounded Project Planner
→ Implementation Contract
→ Adaptive Context Sufficiency
→ Coding Agent
→ Conditional Ponytail-inspired Minimality Policy
→ Deterministic Verifier
→ Governance
→ Controlled Executor
→ Draft PR
→ Cost and Reliability Report
```

---

## 7. Bounded Project Planner

CodexQB'nin tamamı kopyalanmaz ve iki ayrı runtime birleştirilmez.

Alınacak fikirler:

- Repository comprehension.
- Project autopsy.
- Domain ve dependency görünümü.
- Büyük hedefi alt görevlere bölme.
- Implementation contract.
- Plan audit.
- Task ledger ve provenance.

Planner önerir; bounded runtime sınırlar; verifier doğrular; executor uygular.

Planner v0.1 sonrasında aynı benchmark üzerinde ayrı ablation olarak ölçülür.

---

## 8. Conditional Minimality Policy

Ponytail yaklaşımı sistemin karar otoritesi değil, koşullu policy pack olur.

İlk kurallar:

```yaml
minimality:
  prefer_existing_code: true
  prefer_standard_library: true
  prefer_native_platform: true
  prefer_installed_dependency: true
  new_dependency_requires_justification: true
  new_abstraction_requires_reuse_case: true
```

Authentication, payment, migration, cryptography, concurrency ve public API redesign gibi yüksek riskli görevlerde otomatik açılmaz.

---

## 9. Post-MVP Ablation Benchmark

```text
A — Direct agent
B — Bounded v0.1
C — Bounded + Project Planner
D — Bounded + Minimality
E — Bounded + Planner + Minimality
```

Sorular:

- Token kazancının ne kadarı context bounding'den geliyor?
- Planner başarı oranını artırıyor mu?
- Planner overhead kazancına değiyor mu?
- Minimality LOC ve diff'i azaltıyor mu?
- Minimality eksik çözüm riskini artırıyor mu?
- Tam sistem human review süresini azaltıyor mu?

Ölçülebilir katkı göstermeyen bileşen yalnızca mimari olarak güzel göründüğü için core üründe tutulmaz.

---

## 10. v0.1 Tamamlanma Kriteri

- Durable registry tek winner üretiyor.
- Replay restart sonrasında reddediliyor.
- Context Sufficiency Gate eksik context'i algılıyor.
- Context yetersizken patch ve handoff üretilmiyor.
- Bounded expansion limitli ve izlenebilir çalışıyor.
- Disposable apply gerçek write yapıyor.
- Validation failure baseline'a dönüyor.
- Crash recovery gerçek process restart ile çalışıyor.
- Main branch'e doğrudan yazılmıyor.
- Başarılı akış draft PR oluşturuyor.
- Direct/fixed/adaptive benchmark tamamlanıyor.
- Scope drift ve token sonuçları raporlanıyor.
- Bilinen sınırlılıklar açıkça belgeleniyor.

---

## 11. Nihai Vizyon

```text
Her coding agent'ı değiştirmek yerine,
her coding agent'ın minimum doğru context ile,
daha düşük maliyetle, daha az scope drift ile,
daha dar yetkiyle ve doğrulanabilir kanıtlarla
çalışmasını sağlayan ortak runtime.
```

Rekabet avantajı en fazla özelliğe sahip olmak değildir.

Rekabet avantajı:

- Minimum doğru ve adaptif context.
- Ölçülebilir token tasarrufu.
- Daha az scope drift ve gereksiz dosya değişikliği.
- Deterministik scope ve authority kontrolü.
- Lokal repair.
- Transaction-safe apply.
- Crash recovery.
- Kanıtlı draft PR.
- Provider bağımsızlığı.
- Açık benchmark sonuçları.
