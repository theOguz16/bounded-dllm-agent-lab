# Bounded Agent Runtime — Product Roadmap

Bu belge, `bounded-dllm-agent-lab` araştırma çekirdeğinin kullanılabilir bir geliştirici ürününe dönüşmesi için izlenecek yolu tanımlar.

Geçmiş fazların ayrıntılı günlüğü burada tekrar edilmez. Tamamlanan çalışmalar Git geçmişinde ve `docs/results/` altında korunur. Bu roadmap yalnızca mevcut gerçek durum, v0.1 kapanış çizgisi, release blocker'lar, benchmark planı ve ürün yönünü anlatır.

Ayrıntılı teknik açık kaydı:

- [`docs/RELEASE_BLOCKING_GAPS.md`](./RELEASE_BLOCKING_GAPS.md)

Bu dosya roadmap'in ayrılmaz parçasıdır. Buradaki bir madde kapanmadan yalnızca schema, smoke test veya rapor var diye özellik “tamamlandı” sayılmaz.

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

- Agent'a görevi için yeterli olan minimum doğru context'i vermek.
- Context'in gerçekten yeterli olup olmadığını ölçmek.
- Eksik context varsa kontrollü genişletme istemek.
- Yeterli kanıt yoksa kod yazmak yerine durmak.
- Okunabilir ve değiştirilebilir alanları sınırlandırmak.
- Hard scope violation ile soft scope drift'i ayrı ayrı azaltmak.
- Model çıktısını doğrudan gerçek kabul etmemek.
- Patch'i deterministic contract, apply, test ve acceptance kanıtlarıyla doğrulamak.
- Gerekirse yalnızca hatalı bölgeyi yeniden üretmek.
- Repository değişikliğini transaction, rollback ve recovery ile yürütmek.
- Sonucu kanıtlarıyla draft PR olarak sunmak.
- Token, maliyet, risk ve karar izlerini gerçek run seviyesinde ölçmek.

---

## 2. “Var” Ne Demektir?

Bu projede aşağıdaki kavramlar birbirine karıştırılmamalıdır:

```text
Type veya schema mevcut
≠
Smoke test geçiyor
≠
Live fixture çalışıyor
≠
Gerçek ürün garantisi kanıtlandı
```

Durum dili:

- **Primitive mevcut:** Fonksiyon, type veya izole modül var.
- **Contract doğrulandı:** Pozitif ve negatif fixture'lar geçiyor.
- **Entegre edildi:** Canonical runtime akışında zorunlu gate olarak çalışıyor.
- **Ürün garantisi kanıtlandı:** Gerçek repo, model, process ve failure senaryolarında tekrar üretilebilir kanıt var.

Roadmap ve release notlarında bu dört seviye açıkça belirtilmelidir.

---

## 3. Şu Anki Durum

Güvenli karar ve handoff çekirdeği büyük ölçüde tamamlandı.

```text
Planner
→ Coder
→ Model mutation validation
→ Deterministic verifier
→ Gerekiyorsa Remask / Repair
→ Patch dry-run
→ Temporary workspace apply
→ İzole validation
→ Accountability ledger
→ Shadow Observer
→ Deterministic Governance
→ Koşullu Admin
→ Risk-based approval router
→ Governed artifact
→ Controlled apply handoff
→ Durable consumption registry
```

### Güçlü ve kanıtlanmış taraflar

- Bozuk model çıktıları runtime state'e doğrudan yazılmıyor.
- Role ve file scope ihlalleri deterministic olarak engelleniyor.
- Normal ve forced-remask akışları çalışıyor.
- Shadow ve Admin geçersiz çıktılarda fail-closed davranıyor.
- Repair, replan, human review ve terminate rotaları ayrılabiliyor.
- Governed artifact ve handoff hash ile bağlanıyor.
- Değiştirilmiş veya stale handoff reddediliyor.
- Apply, rollback, post-apply validation ve recovery primitive'leri mevcut.
- Durable registry aynı handoff'un tekrar kullanımını engelliyor.

### Henüz aynı güçte kanıtlanmayan taraflar

- Doğru kaynak kod context'inin seçilmesi.
- Context'in semantik olarak yeterli olduğunun anlaşılması.
- Modelin gerçek repo kodunu mevcut implementasyona uyumlu değiştirmesi.
- Business acceptance criteria'nın karşılanması.
- Allowed path içinde oluşan soft scope drift'in ölçülmesi.
- Gerçek end-to-end token ve maliyet tasarrufu.
- Provider failure'ın bütün canonical yollarda hard blocker olması.
- Evidence referanslarının gerçekten mevcut kanıtlara bağlanması.

Temel teşhis:

```text
Frenler, emniyet kemeri ve kara kutu büyük ölçüde var.
Navigasyonun doğru yolu seçtiği ve aracın hedefe ulaştığı aynı güçte kanıtlanmadı.
```

---

## 4. v0.1 MVP

Kullanıcı deneyimi:

```text
Kullanıcı görev verir
→ runtime repository ve policy'yi okur
→ başlangıç bounded context'i oluşturur
→ Context Sufficiency Gate çalışır
→ gerekirse sınırlı context expansion yapılır
→ planner ve coder gerçek bounded source context ile çalışır
→ verifier, remask ve governance tamamlanır
→ acceptance criteria için validation planı çalışır
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
acceptance kanıtı bulunan ve izlenebilir bir draft PR al.
```

v0.1 şunları yapmayacaktır:

- Otomatik merge.
- Production deployment.
- Kullanıcı onayı olmadan policy override.
- Modelin doğrudan Git veya GitHub yetkisi kullanması.
- Her provider'ı destekleme.
- Tam özellikli IDE veya dashboard.
- Distributed cloud registry garantisi.
- CodexQB veya Ponytail entegrasyonu.

---

## 5. Temel Kavramlar

### Bounded context

Agent'ın rolü ve görevi için seçilmiş, token bütçesi bulunan sınırlı context paketidir.

### Context sufficiency

Context'in küçük olması değil, görevi güvenilir biçimde çözmek için gerekli kanıtları içerip içermediğidir.

### Hard scope violation

Agent'ın izin verilmeyen dosya, path veya semantic region'a dokunmasıdır.

### Soft scope drift

Agent'ın izin verilen alan içinde kalmasına rağmen görev için gereksiz dosya, LOC, dependency, abstraction veya refactor üretmesidir.

### Deterministic verifier

Patch'in contract, scope ve belirli güvenlik kurallarını kontrol eder. Tek başına kodun davranışsal olarak doğru olduğunu kanıtlamaz.

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

## 6. Release-Blocking Gap Register

Ayrıntılı açıklamalar ve kapanış kriterleri [`RELEASE_BLOCKING_GAPS.md`](./RELEASE_BLOCKING_GAPS.md) içindedir.

| Gap | Mevcut gerçek durum | Kapanacağı iş | v0.1 blocker |
| --- | --- | --- | --- |
| Gerçek repo-aware coder context | Live model çağrısı var; coder her akışta gerçek source içeriğini görmüyor | CSG + AC | Evet |
| Context budget enforcement | Tahmin ve warning var; hard gate ve recomposition yok | CSG | Evet |
| Semantic context sufficiency | Kaba risk etiketi var; missing symbol/dependency döngüsü yok | CSG | Evet |
| Repo Intelligence depth | Path ve filename heuristics güçlü; AST/import/call graph yok | CSG v1 + post-MVP planner | Kısmen |
| Soft scope drift | Hard file scope kontrolü var; minimality metriği eksik | AF | Evet |
| Verifier claim boundary | Contract doğruluyor; davranışsal doğruluk iddiası yapmamalı | AC + AF docs | Evet |
| Acceptance criteria | Test command çalışıyor; task-to-evidence mapping eksik | AC + AE | Evet |
| Observed token/cost | Bazı live usage alanları var; unified run ledger yok | AF | Evet |
| Provider failure semantics | Bazı yollar fail-closed; generic fallback sessiz ilerleyebilir | CSG/runtime integration | Evet |
| Evidence reference integrity | Evidence string listesi var; referential validation yok | AE | Evet |
| Hash trust boundary | Tamper-evident; authenticated signature değil | Known limitation | Hayır |
| Distributed registry | Local SQLite persistent; multi-host distributed değil | Post-MVP | Hayır |
| İki mimari nesil | Mock/legacy ve product runtime birlikte yaşıyor | AF cleanup | Evet |
| Canonical public API | Primitive ve scriptler var; tek coordinator API eksik | AB–AE | Evet |

Bir gap şu şartlar olmadan kapalı sayılmaz:

- Canonical runtime yoluna bağlanmış olmalı.
- Negatif fixture yanlış başarı üretmemeli.
- Gerçek kullanım veya process sınırında kanıtlanmalı.
- Release artifact'ında sonucu görünmeli.
- README ve known limitations aynı iddiayı kullanmalı.

---

## 7. v0.1 Kapanış Planı

| İş | Amaç | Durum |
| --- | --- | --- |
| **AB** | Durable registry'yi canlı ortamda doğrulamak | Tamamlandı |
| **CSG v1** | Context yeterliliği, source context ve provider fail-closed gate | Tamamlandı |
| **AC** | Disposable Git repo üzerinde entegre apply ve acceptance validation | Sıradaki |
| **AD** | Gerçek crash ve restart recovery | Planlandı |
| **AE** | Güvenli branch, commit, evidence ve draft PR | Planlandı |
| **AF** | Birleşik benchmark, gap closure audit ve v0.1 release | Planlandı |

CSG yeni bir sonsuz faz serisi değildir. AB–AF içinde tamamlanacak, planner/coder çağrılarından önce çalışan release-blocking bir runtime gate'tir.

---

# Context Sufficiency Gate v1

## Amaç

Dar context kullanımının token tasarrufu sağlarken görev kalitesini düşürmesini engellemek.

```text
Her zaman en az context'i kullanma.
Görev için gerekli olan minimum doğru context'i kullan.
```

## CSG.1 — Context contract

<!-- CSG_1_CONTRACT_STATUS -->

**Durum: Tamamlandı.**

Bu adımda context sufficiency kararları,
bounded context expansion request contractı,
role-target yetkileri ve fail-closed validator
testleri eklendi.

Gerçek repository lookup, adaptive expansion ve
orchestration gate sonraki CSG adımlarında bağlanacaktır.


```ts
type ContextSufficiencyDecision =
  | "context_sufficient"
  | "context_expansion_required"
  | "replan_required"
  | "human_review_required";

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

## CSG.2 — Deterministic repository context resolver

<!-- CSG_2_RESOLVER_STATUS -->

**Durum: Tamamlandı.**

Yapılandırılmış `contextRequest`, yalnız açıkça
istenen repository-relative source ve test dosyalarını
okuyan bounded bir evidence packetına çevrilir.

Resolver:

- Repository dışına çıkan pathleri reddeder.
- Symlink takip etmez.
- Binary ve geçersiz UTF-8 dosyaları reddeder.
- Allowed ve forbidden read scopeu tekrar kontrol eder.
- Scope expansion talebi ile ayrı policy onayını ayırır.
- Aynı dosyanın ikinci kez istenmesini engeller.
- Dosya, toplam byte ve hard token limitlerini uygular.
- File, request ve packet hashlerini üretir.
- Eksik dosya ve çözülemeyen symbolleri raporlar.
- Repository write yapmaz.

CSG.2 global AST, import graph veya repository-wide
symbol search iddiasında bulunmaz. Symbol eşleşmesi
yalnız açıkça yüklenen dosyalar içinde aranır.

## CSG.3 — Minimum kontroller

<!-- CSG_3_CODER_GATE_STATUS -->

**Durum: Tamamlandı.**

Coder provider çağrısından önce çalışan
fail-closed execution gate eklendi.

Gate:

- Required source ve test dosyalarının görünür contextte bulunduğunu doğrular.
- Required symbollerin gerçek evidence içeriğinde bulunduğunu doğrular.
- Authority ve policy yoksa coder çağrısını engeller.
- Initial ve expanded evidence arasında hash çatışmasını engeller.
- Expansion packet bütünlüğünü yeniden doğrular.
- Toplam input ve output rezervini hard token bütçesine karşı ölçer.
- Hard budget aşılırsa provider çağrısını hiç yapmaz.
- Provider başarısızlığını human review olarak route eder.
- Providera source içeriği, provenance ve budget metadata gönderir.

Bu adım generic provider callback ile doğrulanır.
Gerçek adaptive resolver döngüsü ve model adapter
entegrasyonu CSG.4 kapsamında yapılacaktır.


- Değiştirilecek source dosyası gerçekten context'te mi?
- Coder'a source içeriği gönderildi mi?
- İlgili paired file gerekli mi?
- Required test mapping mevcut mu?
- Authority ve policy bilgisi var mı?
- Görünmeyen dosya veya symbol hakkında claim üretiliyor mu?
- Context hard budget içinde mi?
- İstenen dosya allowed read context içinde mi?
- Required provider çağrısı başarısız oldu mu?

v1 tam call graph veya kusursuz semantic index iddiasında bulunmaz.

## CSG.4 — Adaptive expansion

<!-- CSG_4_ADAPTIVE_ORCHESTRATOR_STATUS -->

**Durum: Tamamlandı.**

Context contract, deterministic repository resolver
ve coder execution gate tek adaptive runtime
döngüsünde birleştirildi.

Orchestrator:

- Initial context yeterliyse expansion yapmadan coder providerı çağırır.
- Yalnız missing source, test veya symbol durumlarında context ister.
- En fazla iki expansion gerçekleştirir.
- Aynı dosyanın tekrar istenmesini engeller.
- Scope expansion için ayrı ve açık policy onayı ister.
- Resolver sonucunu coder gate üzerinden yeniden doğrular.
- Total hard budget aşılırsa daha fazla context istemez.
- Context request ve coder provider hatalarında fail-closed çalışır.
- Coder providerı bütün akış boyunca en fazla bir kez çağırır.
- Expansion request, resolution, token ve provenance tracei üretir.

Model specific adapter, handoff ve apply seviyesindeki
son fail-closed bağlantılar CSG.5 kapsamında yapılacaktır.


```text
Initial bounded context
→ sufficiency check
→ valid context request
→ deterministic repo lookup
→ bounded expansion
→ budget recomposition
→ sufficiency re-check
→ coder execution veya safe stop
```

Limitler:

- En fazla 2 expansion.
- Her expansion için ayrı token limiti.
- Toplam context için hard budget.
- Aynı dosyanın tekrar istenmesini engelleme.
- Scope genişletme gerekiyorsa otomatik onay vermeme.

## CSG.5 — Fail-closed davranış

<!-- CSG_5_AUTHORIZATION_STATUS -->

**Durum: Tamamlandı.**

Başarılı adaptive coder akışı, validated patch mutation ve downstream delivery zinciri hashli context authorization receipt ile bağlandı.

Garantiler:

- Adaptive flow tamamlanmadan patch, handoff veya apply callbackleri çağrılmaz.
- Coder provider tam olarak bir kez başarılı çalışmalıdır.
- Coder çıktısı validated `patchDraft` değilse authorization üretilmez.
- Changed files coder evidence içinde görünür olmalıdır.
- Mutation, context, provenance, expansion trace ve token budget authorization hashine bağlanır.
- Patch pipeline başarısızsa handoff ve apply çalışmaz.
- Handoff başarısızsa apply çalışmaz.
- Apply başarısızlığı fail-closed human review üretir.

Bu closure gerçek repository write yapmaz. Disposable Git repository üzerinde gerçek handoff, apply ve acceptance validation Phase AC kapsamında çalıştırılacaktır.

Ürün seviyesindeki canonical entrypoint bundan sonra context-authorized delivery chain olmalıdır.

## Definition of Done

- `contextRequest` contract ve validator testleri geçer.
- Coder gerçek source context görür.
- Missing source/test/authority fixture'ları doğru route üretir.
- En az bir fixture expansion sonrası tamamlanır.
- Hard budget aşılırsa model çağrısı yapılmaz.
- Provider failure yanlış approve üretmez.
- Context yetersizken patch veya handoff üretilmez.
- Expansion'lar token ve provenance ledger'ına yazılır.

---

# Phase AB — Durable Consumption Registry

<!-- PHASE_AB_CLOSEOUT -->

## Durum

**Tamamlandı.**

RunPod live validation `2026-07-20` tarihinde başarıyla tamamlandı.

Kalıcı evidence:

[`PHASE_AB_DURABLE_REGISTRY_LIVE_VALIDATION.md`](./results/PHASE_AB_DURABLE_REGISTRY_LIVE_VALIDATION.md)


## Amaç

Aynı controlled handoff'un process'ler ve restart'lar arasında yalnızca bir kez kullanılabildiğini kanıtlamak.

## Yapılacaklar

- Registry public export'a eklenecek.
- Local ve live npm scriptleri eklenecek.
- İki process aynı key için yarışacak; tek winner çıkacak.
- Restart sonrası kayıt korunacak.
- Replay ve casual tamper fail-closed reddedilecek.
- SQLite trust boundary açıkça belgelenecek.

## Definition of Done

- Local smoke PASS.
- RunPod live suite PASS.
- Winner count tam olarak 1.
- Replay ve tamper reddediliyor.
- Gerçek repository write yapılmıyor.
- Artifact'ın imzalı olmadığı known limitation'da yazıyor.

---

# Phase AC — Integrated Disposable Repository Apply

## Amaç

Governed handoff'tan başlayıp disposable Git repo üzerinde gerçek dosya değişikliği, acceptance validation ve rollback yapan tek coordinator oluşturmak.

```text
handoff verified
→ durable reservation
→ repository inspection
→ rollback bundle
→ execution gate
→ controlled apply
→ acceptance validation
→ registry finalization
```

## Ek release blocker'lar

- Task contract'a yapılandırılmış acceptance criteria eklenir.
- Her criterion bir test, static check veya human review kanıtına bağlanır.
- Deterministic verifier sonucu “contract approved” olarak adlandırılır; “code correct” denmez.
- Validation yalnız exit code değil criterion coverage da raporlar.

## Definition of Done

- Başarılı mutation disposable worktree'ye uygulanır.
- Validation gerçek değişmiş state üzerinde geçer.
- Acceptance criteria evidence mapping tamamlanır.
- Başarısızlıkta exact baseline geri gelir.
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

- Amaç, task contract ve acceptance criteria.
- Değiştirilen dosyalar.
- Context sufficiency ve expansion özeti.
- Hard scope violation ve soft scope drift özeti.
- Verifier ve remask kararı.
- Test ve criterion evidence sonuçları.
- Gerçek token ve maliyet özeti.
- Handoff, consumption ve receipt hash'leri.
- Rollback/recovery bilgisi.
- Provider failure veya fallback bilgisi.
- Bilinen sınırlılıklar.

## Ek release blocker'lar

- Evidence string değil typed reference olur.
- File evidence content hash taşır.
- Test evidence receipt hash taşır.
- Ledger verifier referansların gerçekten var olduğunu kontrol eder.
- Aynı run duplicate branch veya PR üretmez.

## Definition of Done

- Ana branch değişmeden kalır.
- Yeni bounded branch oluşturulur.
- Yalnız governed dosyalar stage edilir.
- Kontrollü commit ve push yapılır.
- Draft PR açılır.
- Evidence referansları doğrulanır.
- Duplicate delivery engellenir.

---

# Phase AF — Unified Benchmark and v0.1 Release

## Amaç

Sistemin gerçekten daha güvenli, daha az scope drift üreten ve daha düşük maliyetli olup olmadığını ölçmek; ayrıca gap register'daki v0.1 blocker'ların kapandığını denetlemek.

## AF.1 — Release komutu

```text
npm run verify:release
```

```text
typecheck
→ build
→ deterministic safety
→ context sufficiency
→ provider failure fixtures
→ durable registry
→ disposable apply
→ acceptance validation
→ crash recovery
→ draft PR fixture
→ gap closure audit
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

Aynı model, temperature, task seti ve provider kullanılır. Direct baseline gerçekten model çağırmalıdır; changed file varsa otomatik approve eden sentetik baseline release kanıtı sayılmaz.

## AF.3 — Context benchmark aileleri

- Missing source/type/helper/caller/test fixtures.
- Distractor context fixtures.
- Context ablation.
- Expansion sonrası başarı fixture'ları.
- Hard budget overflow fixture'ları.
- Provider timeout/invalid JSON fixture'ları.

## AF.4 — Scope benchmark

Hard ve soft scope ayrı raporlanır.

- Forbidden write count.
- Unexpected-but-allowed file count.
- Expected vs actual file set farkı.
- Unnecessary LOC.
- Unrequested refactor count.
- New dependency count.
- New abstraction justification rate.

## AF.5 — Ölçümler

### Görev kalitesi

- Task success rate.
- Acceptance criteria pass rate.
- Test pass rate.
- Patch apply success.
- Human reviewer acceptance.
- Correct file coverage.

### Context sufficiency

- Context Sufficiency Detection Rate.
- False Sufficiency Rate.
- Unnecessary Expansion Rate.
- Expansion Success Rate.
- Average expansion count.
- Context budget overrun rate.
- Full-context ile task success farkı.

### Maliyet

- Observed input/output/total tokens.
- Role bazında token dağılımı.
- Retry/remask/expansion overhead.
- Provider price snapshot.
- Cost per accepted patch.

### Reliability

- Missed ve false blocker.
- Replay rejection.
- Rollback ve recovery success.
- Provider failure safe-stop rate.
- Evidence reference validation rate.

## AF.6 — Gap closure audit

Her v0.1 blocker için:

```text
primitive
→ contract tests
→ canonical integration
→ live/real evidence
→ release artifact
```

zinciri tamamlanmalıdır.

Aşağıdakiler release blocker'dır:

- Context yetersizken patch/handoff üretilmesi.
- Coder'ın gerçek source içeriği olmadan başarı kabul edilmesi.
- Provider failure sonrası yanlış approve.
- Acceptance criteria'sız “tests passed” iddiası.
- Soft scope drift'in ölçülmemesi.
- Sentetik token tahmininin gerçek tasarruf diye sunulması.
- Legacy/mock flow'un public canonical API ile karıştırılması.
- Tek coordinator ve `verify:release` komutunun bulunmaması.

## AF.7 — Release artifact'ları

- README quickstart.
- Architecture diagram.
- Threat model ve trust assumptions.
- Unified benchmark report.
- Context sufficiency report.
- Hard/soft scope drift report.
- Acceptance criteria coverage report.
- Observed token/cost report.
- Fail-closed matrix.
- Gap closure matrix.
- Known limitations.
- v0.1 release notes.

## Definition of Done

- `npm run verify:release` tekrarlanabilir çalışır.
- Direct, fixed bounded ve adaptive bounded kıyası tamamlanır.
- Safety ve product-value metrikleri ayrı raporlanır.
- `RELEASE_BLOCKING_GAPS.md` içindeki bütün v0.1 blocker'lar kapalı veya açıkça release dışı bırakılmıştır.
- Tek canonical runtime/public API seçilmiştir.
- v0.1 tag hazırlanır.

---

## 8. MVP Sonrası Ürün Yönü

```text
AI Coding Cost and Reliability Layer
```

Codex, Claude Code, Cursor, OpenCode veya başka bir coding agent'ın üstünde çalışan; context, maliyet, scope ve final patch güvenilirliğini yöneten bağımsız katman.

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

### Bounded Project Planner

CodexQB'nin tamamı kopyalanmaz ve iki runtime doğrudan birleştirilmez.

Alınacak fikirler:

- Gerçek repository comprehension.
- AST/import/dependency ve ileride call graph.
- Project autopsy.
- Domain görünümü.
- Büyük hedefi alt görevlere bölme.
- Implementation contract.
- Plan audit.
- Task ledger ve resume.

Planner önerir; bounded runtime sınırlar; verifier doğrular; executor uygular.

### Conditional Minimality Policy

Ponytail yaklaşımı karar otoritesi değil, koşullu policy pack olur.

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

### Distributed ve production reliability

v0.1 local/self-hosted SQLite registry kullanabilir. Multi-host üründe:

- PostgreSQL unique idempotency key.
- Transactional reservation veya advisory lock.
- Lease/heartbeat.
- Signed/HMAC artifact.
- Authenticated human approval.
- Append-only audit storage.

ayrı production çalışmalarıdır.

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
- Minimality LOC, file count ve diff'i azaltıyor mu?
- Minimality eksik çözüm riskini artırıyor mu?
- Tam sistem human review süresini azaltıyor mu?

Ölçülebilir katkı göstermeyen bileşen yalnızca mimari olarak güzel göründüğü için core üründe tutulmaz.

---

## 10. v0.1 Tamamlanma Kriteri

- Durable registry tek winner üretiyor.
- Replay restart sonrasında reddediliyor.
- Context Sufficiency Gate eksik context'i algılıyor.
- Coder gerçek bounded source context kullanıyor.
- Hard budget aşılırsa model çağrısı duruyor.
- Required provider failure yanlış approve üretmiyor.
- Context yetersizken patch ve handoff üretilmiyor.
- Bounded expansion limitli ve izlenebilir çalışıyor.
- Task acceptance criteria yapılandırılmış ve kanıta bağlı.
- Disposable apply gerçek write yapıyor.
- Validation failure baseline'a dönüyor.
- Crash recovery gerçek process restart ile çalışıyor.
- Main branch'e doğrudan yazılmıyor.
- Başarılı akış evidence-backed draft PR oluşturuyor.
- Hard ve soft scope drift ayrı ölçülüyor.
- Token sonuçları observed provider usage ile raporlanıyor.
- Tek canonical runtime ve public coordinator API var.
- Known limitations ve trust assumptions açıkça belgeleniyor.

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
- Ölçülebilir gerçek token tasarrufu.
- Daha az hard ve soft scope drift.
- Deterministik scope ve authority kontrolü.
- Lokal repair.
- Acceptance-evidence validation.
- Transaction-safe apply.
- Crash recovery.
- Kanıtlı draft PR.
- Provider bağımsızlığı.
- Açık benchmark sonuçları.
- Ürün iddialarıyla gerçek kanıt seviyesinin açıkça ayrılması.
