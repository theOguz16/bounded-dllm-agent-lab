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
| **AC** | Disposable Git repo üzerinde entegre apply ve acceptance validation | Tamamlandı |
| **AD** | Gerçek crash ve restart recovery | Tamamlandı |
| **AE** | Güvenli branch, commit, evidence ve draft PR | Tamamlandı |
| **AF** | Birleşik benchmark, gap closure audit ve v0.1 release | Tamamlandı — `v0.1.0` yayımlandı |

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

## AC.1 — Structured acceptance criteria contract

<!-- PHASE_AC_1_ACCEPTANCE_CONTRACT_STATUS -->

**Durum: Tamamlandı.**

Task objective ile hash üzerinden bağlanan yapılandırılmış acceptance criteria contractı eklendi.

Her version 1 criterion zorunludur ve tam olarak bir evidence kaynağına bağlanır:

- `test` → temporary execution command id
- `static_check` → temporary execution command id
- `human_review` → hashli human review evidence key

Evaluator:

- Contract, command specification, execution step ve review evidence bütünlüğünü doğrular.
- Command id ile step hashini deterministik olarak eşler.
- Eksik evidence için `contract_needs_review` üretir.
- Başarısız criterion için `contract_failed` üretir.
- Bozuk veya eşleşmeyen evidence için `contract_invalid` üretir.
- Yalnız bütün required criteria approved ise `contract_approved` üretir.
- Criterion coverage receipt ve downstream verification sonucu oluşturur.

Bu karar `code correct` iddiası değildir. Yalnız tanımlı acceptance contractının sağlandığını ifade eder.

AC.2b integrated coordinator, X.4 apply ve X.5 validation sonuçlarını bu receipt ve context-to-apply binding olmadan başarılı kabul etmeyecektir.

## AC.2a — Context-to-apply derivation binding

<!-- PHASE_AC_2A_CONTEXT_APPLY_BINDING_STATUS -->

**Durum: Tamamlandı.**

X.4 gerçek repository executor yalnız `remask → repairDraft`
mutationını uygularken CSG authorization `coder → patchDraft`
için üretilir.

Bu iki güvenlik alanı hashli ve fail-closed bir derivation
binding ile birleştirildi.

Binding:

- Context authorization receipt ile kaynak coder patch mutationını doğrular.
- X.3 execution authorizationı gerçek gate inputuna karşı yeniden doğrular.
- Final mutationın yalnız validated `remask → repairDraft` olmasına izin verir.
- Repair mutation hash ve changed files alanlarını X.3 authorization ile eşler.
- Repair dosyalarının context-authorized coder scopeunun dışına çıkmasını engeller.
- Final repair dosyalarının coderın gördüğü evidence içinde bulunmasını zorunlu kılar.
- Context authorization, coder mutation, repair mutation, governed artifact,
  handoff, consumption key ve X.3 authorization hashlerini tek receiptte bağlar.
- Tampered veya stale bindingi downstream apply için uygun saymaz.

Bu receipt repository write yapmaz. AC.2b coordinator bu binding
current olmadan X.4 apply çağrısı yapmayacaktır.

## AC.2b — Integrated disposable apply coordinator

<!-- PHASE_AC_2B_INTEGRATED_COORDINATOR_STATUS -->

**Durum: Tamamlandı.**

Context authorization, context-to-apply binding, acceptance contract,
X.4 gerçek repository apply ve X.5 isolated validation tek canonical
coordinator altında birleştirildi.

Coordinator:

- Context-to-apply binding current değilse gerçek write başlatmaz.
- Acceptance contract objective hashini governed artifact objective ile eşler.
- Phase V evidence ile governed artifact bindingini write öncesinde doğrular.
- Eksik human review, başarısız criterion veya bozuk mapping varsa X.4 çağrılmaz.
- Yalnız `contract_approved` preflight sonrasında X.4 apply çalıştırır.
- X.4 başarılı olduktan sonra aynı specificationı X.5 ile applied state üzerinde çalıştırır.
- X.5 başarısızlığında sealed rollback bundle ile exact baseline dönüşünü taşır.
- X.5 current evidenceını yeniden acceptance criteria evaluatora bağlar.
- Yalnız final criterion coverage tamamlandıysa integrated final receipt üretir.
- X.4, X.5, acceptance coverage, context binding, handoff ve consumption hashlerini
  tek receipt içinde birleştirir.
- Replay ikinci repository write veya ikinci başarı receiptı üretemez.
- Git index ve history coordinator tarafından değiştirilmez.

Bu karar `code correct` iddiası değildir. Yalnız tanımlı acceptance contractının
gerçek applied state üzerindeki izole validation evidenceı ile onaylandığını gösterir.

## AC.3 — Integrated failure matrix

<!-- PHASE_AC_3_FAILURE_MATRIX_STATUS -->

**Durum: Tamamlandı.**

Canonical coordinator gerçek disposable Git repositorylerde pozitif ve negatif
failure matrix ile doğrulandı.

Ek write-öncesi X.5 infrastructure preflight:

- Validation workspace parentının gerçek, symlinksiz ve OS temporary root içinde olduğunu doğrular.
- Repository, Git directory, durable registry ve rollback bundle overlaplerini engeller.
- Beklenmeyen pre-existing isolated workspace veya validation transactionı write öncesinde durdurur.
- X.5 output boundunun trusted limit içinde olduğunu doğrular.
- Bilinen validation altyapı hatalarında X.4 consumption claim veya repository write üretmez.

Failure matrix:

- Başarılı apply, isolated validation ve `contract_approved` receipt.
- Eksik veya reddedilmiş acceptance evidence için sıfır X.4 call.
- Objective, Phase V ve context-to-apply binding mismatchleri için sıfır write.
- Validation failure sonrası sealed bundle ile exact baseline rollback.
- Workspace overlap, symlink, stale workspace ve stale transaction preflightları.
- Concurrent coordinator çağrılarında yalnız bir finalized sonuç.
- Replay sırasında ikinci write ve ikinci başarı receiptı üretilmemesi.
- Repository drift sonrası integrated receiptın stale olması.
- Git index, refs, config ve history metadata invariants.

Phase AC kararı davranışsal olarak `code correct` değildir. Sonuç yalnız tanımlı
acceptance contractının gerçek applied state üzerindeki evidence ile onaylandığını
ve failure yollarının fail-closed çalıştığını kanıtlar.

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

## AD.1 — Real X4 SIGKILL checkpoint recovery

<!-- PHASE_AD_1_X4_SIGKILL_STATUS -->

**Durum: Tamamlandı.**

X.4 apply ayrı Node processinde çalıştırılır. Durable checkpointlar bağımsız
worker thread tarafından izlenir; hedef checkpoint görüldüğünde process
`SIGSTOP`, ardından parent process tarafından gerçek `SIGKILL` alır.

Yeni process X.6 recovery primitiveini kullanarak kalıcı registry evidenceını
okur ve güvenli state transitionı gerçekleştirir.

Doğrulanan checkpointlar:

- `after_reservation`: repository write olmadan durable prewrite closeout.
- `after_transaction_intent`: repository write olmadan durable prewrite closeout.
- `after_write_started`: sealed rollback bundle ile exact X.1 baseline.
- `after_first_file_write`: kısmi multi-file mutation sonrası exact baseline.
- `after_apply_complete`: committed X.4 state korunur ve X.5 yeni process tarafından devam ettirilir.

Her senaryoda permanent consumption claim korunur; Git index, refs, config ve
history metadata değişmez. Crash state başarı olarak yorumlanmaz.

AD.2, gerçek `after_validation_started` SIGKILL senaryosunu, concurrent dış
değişikliği ve recovery replay davranışını doğrulayacaktır.

## AD.2 — Real X5 SIGKILL recovery

<!-- PHASE_AD_2_X5_SIGKILL_STATUS -->

**Durum: Tamamlandı.**

X.5 isolated validation ayrı Node processinde çalıştırılır ve gerçek durable
checkpointlarda `SIGSTOP` ardından parent process tarafından `SIGKILL` alır.
Yeni process X.6 registry inspection ve recovery boundarysini çalıştırır.

Doğrulanan durumlar:

- `validation-intent.json` sonrası crash başarı sayılmaz ve exact X.1 baseline geri yüklenir.
- `VALIDATION_STARTED` sonrası crash hiçbir zaman validation pass olarak yorumlanmaz.
- Validation subprocessi çalışırken crash sonrası orphan process sonlandırılır,
  deterministic isolated workspace temizlenir ve baseline geri yüklenir.
- Concurrent unrelated worktree drift varken automatic rollback yapılmaz;
  human review üretilir ve recovery attempt açılmaz.
- Drift kaldırıldıktan sonra fresh inspection güvenli rollback yapabilir.
- Başarılı recovery replay ikinci repository write veya ikinci recovery attempt üretmez.
- Original X.4/X.5 registry evidenceı korunur; recovery ayrı immutable namespace kullanır.
- Git index, refs, config ve history metadata değişmez.

Bu sonuç local transaction crash recovery garantisidir; deployment veya distributed
multi-host recovery garantisi değildir.

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

## AE.1 — Evidence-bound draft PR delivery contract

<!-- PHASE_AE_1_DELIVERY_CONTRACT_STATUS -->

**Durum: Tamamlandı.**

Validated integrated apply receipt, X.4 applied file hashes, target repository,
deterministic branch, commit/PR metni ve typed evidence referansları tek bir
hash-bound delivery contractında birleştirilir.

Contract guarantees:

- Her governed changed file için exact content-hash bağlı file evidence.
- Integrated apply, context binding, acceptance coverage, X.4 ve X.5 için typed receipt references.
- Final isolated validation resultı için typed test evidence.
- Deterministic branch ve duplicate-safe delivery key.
- Base revision ve repository identity bağları.
- Builder hiçbir Git veya GitHub write gerçekleştirmez.
- `ready` sonucu repository/GitHub freshness veya delivery başarısı değildir;
  yalnız structural ve cryptographic delivery-plan bütünlüğüdür.

AE.2 contractı current repository state üzerinde yeniden doğrulayıp bounded local
branch oluşturacak, yalnız governed dosyaları stage edecek ve evidence-bound commit
üretecektir.

## AE.2 — Controlled local branch and commit executor

<!-- PHASE_AE_2_LOCAL_DELIVERY_STATUS -->

**Durum: Tamamlandı.**

Current AE.1 delivery contract ve validated applied repository state yeniden
doğrulanır. Executor deterministic bounded branch oluşturur, yalnız governed
dosyaları indexe alır ve Git plumbing ile evidence-bound commit üretir.

Garantiler:

- Repository identity, base revision ve checked-out base branch eşleşir.
- Başlangıç indexi temizdir; worktree changed path seti governed scope ile exact eşleşir.
- Her worktree file state X.4 applied receipt ile yeniden doğrulanır.
- Staged path seti ve staged blob bytes verified worktree bytes ile exact eşleşir.
- Commit `write-tree`, `commit-tree`, `update-ref` ile oluşturulur; hooks çalışmaz.
- Base branch ref ve remote-tracking refs değişmez.
- Commit message delivery key, contract, evidence set, integrated/X.4/X.5 receipt trailerları taşır.
- Durable local delivery claim duplicate branch/commit üretimini engeller.
- Replay mevcut current receipt ve commit'i döndürür; ikinci Git write yapmaz.
- Push, GitHub write veya shell execution yapılmaz.

AE.3 current local delivery receiptini remote freshness ile doğrulayıp branch push
ve draft PR oluşturma işini ayrı connector/executor sınırında gerçekleştirecektir.

## AE.3a — Controlled remote branch push

<!-- PHASE_AE_3A_REMOTE_PUSH_STATUS -->

**Durum: Tamamlandı.**

Current AE.2 local delivery receipt yeniden doğrulanır. Repository identity, local
base/head refs ve remote base freshness eşleşirse deterministic bounded branch
lease-protected exact-commit refspec ile remote'a gönderilir.

Garantiler:

- Repository identity X.1 ile aynı root-commit ve normalized remote hash algoritmasıyla doğrulanır.
- Local base ve bounded branch refs AE.2 receipt ile exact eşleşir.
- Remote base branch contracted revisionda olmalıdır.
- Remote bounded branch ilk push öncesinde mevcut olamaz.
- Durable push claim `PUSH_STARTED` markerından önce yazılır.
- Push exact commit hash refspeci ve empty-expectation `--force-with-lease` kullanır.
- Unconditional force push kullanılmaz.
- Push sonrası remote base değişmemiş, remote head exact commit olmuş olmalıdır.
- Local base ve bounded branch refs push sırasında değişmez.
- Replay current durable receipt üzerinden ikinci push yapmaz.
- Push reddi veya post-push doğrulama sorunu recovery-required üretir.
- GitHub API, draft PR veya shell execution bu boundaryde yoktur.

AE.3b yalnız current remote push receipt üzerinden GitHub draft PR oluşturacak,
base/head/draft/evidence alanlarını API'den yeniden okuyacak ve duplicate PR
deliverysini engelleyecektir.

## AE.3b — Controlled GitHub draft PR delivery

<!-- PHASE_AE_3B_GITHUB_DRAFT_PR_STATUS -->

**Durum: Tamamlandı.**

Current AE.3a remote push receipt Git ve durable registry üzerinden yeniden
doğrulanır. Typed GitHub client repository/base/head durumunu okur, duplicate
open PR kontrolü yapar ve yalnız durable intentten sonra draft PR oluşturur.

Garantiler:

- GitHub repository owner/name/default branch contract ile exact eşleşir.
- GitHub base/head commitleri remote push receipt ile exact eşleşir.
- Aynı base/head için mevcut open PR varken unclaimed duplicate oluşturulmaz.
- Durable `CREATE_STARTED` claim GitHub write öncesinde yazılır.
- Create isteği title/body/base/head ve `draft: true` alanlarını exact taşır.
- Oluşturulan PR API'den yeniden okunur; open/draft/text/ref alanları doğrulanır.
- PR changed-file seti governed file setiyle exact eşleşir.
- PR oluşturma sırasında base/head branch commitleri değişemez.
- Immutable receipt contract, push receipt, local receipt, evidence set ve PR numarasına bağlıdır.
- Replay current receipt üzerinden ikinci PR oluşturmaz.
- Create sonrası belirsiz veya uyumsuz durum recovery-required üretir.
- Core executor shell veya Git write çalıştırmaz.

Production REST adapter yalnız `https://api.github.com` kullanır, bounded JSON
responses uygular ve token değerini hiçbir receipt veya sonuç nesnesine koymaz.

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

## AF.1a — Deterministic v0.1 gap closure audit

<!-- PHASE_AF_1A_GAP_AUDIT_STATUS -->

**Durum: Tamamlandı.**

G1–G14 gap registrysi typed ve tamper-evident bir audit contractına çevrilir.
Her kapalı v0.1 blocker için aşağıdaki beş aşamalı evidence zinciri zorunludur:

```text
primitive
→ contract tests
→ canonical integration
→ live/real evidence
→ release artifact
```

Audit ayrıca tek canonical coordinator declarationını, `verify:release` komutunu
ve on iki zorunlu release artifactını ayrı blocker olarak değerlendirir.

Mevcut matrix kasıtlı olarak release-ready değildir:

- G5 soft scope drift ölçümü açıktır.
- G8 unified observed token/cost ledger açıktır.
- G13 legacy/canonical runtime ayrımı açıktır.
- `verify:release` henüz repository-bound runner değildir.
- Release artifact seti henüz üretilmemiştir.

Bu aşama yalnız structural ve cryptographic audit contractını kapatır. Evidence
locatorlarının repository içindeki gerçek dosya/komutlarla eşleşmesi AF.1b'de
read-only repository inspection ile doğrulanacaktır.

AF.1b audit matrixini gerçek package scripts, runtime exports, test/report
artifacts ve repository hashes ile bağlayacak; yalnız tüm blockerlar kapandığında
`npm run verify:release` başarı döndürecektir.

## AF.1b — Repository-bound release evidence runner

<!-- PHASE_AF_1B_REPOSITORY_EVIDENCE_STATUS -->

**Durum: Tamamlandı.**

AF.1a matrixindeki evidence locatorları repository içindeki gerçek regular-file
bytes veya exact npm script değerleriyle yeniden doğrulanır.

Garantiler:

- Evidence dosyaları repository root dışına çıkamaz.
- Symlink segmentleri ve symlink evidence entryleri takip edilmez.
- Per-file ve total byte limitleri vardır.
- Kapalı gap evidence hashleri mevcut repository bytes ile exact eşleşir.
- `verify:release` scripti exact repository-bound komutla eşleşir.
- Canonical coordinator hem source exportu hem public index exportu üzerinden doğrulanır.
- On iki release artifactının declared present/missing durumu gerçek filesystem ile eşleşir.
- Report deterministic ve tamper-evident hash taşır.
- Blocker veya eksik artifact olduğunda `verify:release` non-zero çıkar.
- Runner repository write, shell, network veya Git mutation yapmaz.

Mevcut repository-bound sonuç release-blocked olarak kalır:

- G5 soft scope drift benchmarkı açık.
- G8 observed token/cost ledger açık.
- G13 legacy/canonical runtime ayrımı açık.
- On iki release artifactı henüz missing olarak kayıtlıdır.

`report:release-evidence` blockerları exit 0 ile raporlar. `verify:release`
yalnız release-ready durumda exit 0 üretir.

## AF.2 — Ana karşılaştırma

```text
A — Direct large-context coding agent
B — Fixed bounded context
C — Adaptive bounded context + sufficiency gate
```

Asıl ürün hedefi C'dir.

Aynı model, temperature, task seti ve provider kullanılır. Direct baseline gerçekten model çağırmalıdır; changed file varsa otomatik approve eden sentetik baseline release kanıtı sayılmaz.

## AF.2a — Deterministic soft scope drift benchmark contract

<!-- PHASE_AF_2A_SOFT_SCOPE_STATUS -->

**Durum: Tamamlandı.**

Hard scope violation ile izinli alan içindeki soft scope drift ayrı contract,
metric ve karar alanlarıyla değerlendirilir.

Ölçümler:

- Expected ve actual file set farkı.
- Unexpected-but-allowed file count.
- Forbidden ve outside-allowed file count.
- Unnecessary ve uncertain LOC.
- Unrequested refactor count.
- New, unrequested ve unjustified dependency count.
- New abstraction justification rate.
- Human reviewer unnecessary-label count ve rate.
- Direct, fixed bounded ve adaptive bounded strategy aggregate'ları.

Kararlar:

```text
hard_scope_blocked
soft_scope_review
scope_clean
```

Fixture reportu `evidenceClass=deterministic_fixture` ve
`releaseClaimEligible=false` taşır. Bu nedenle sentetik fixture sonucu gerçek
model performansı, ürün tasarrufu veya release benchmark kanıtı sayılamaz.

G5 bu aşamada tamamen kapanmaz. AF.2b observed run evidence'ını canonical
runtime/PR delivery akışına bağlayacak, `reports/release/SCOPE_DRIFT.json`
artifactını üretecek ve draft PR body içinde soft drift özetini zorunlu kılacaktır.

## AF.2b — Observed scope integration and release report

<!-- PHASE_AF_2B_OBSERVED_SCOPE_STATUS -->

**Durum: Tamamlandı.**

AF.2a soft-scope contractı gerçek disposable Git repository diff gözlemine
bağlanır. Observed report integrated apply receipt, X.4 apply receipt ve AE.1
delivery contract hashlerini tek binding hash altında taşır.

Garantiler:

- `evidenceClass=observed_run` ve `releaseClaimEligible=true`.
- Actual file ve LOC değerleri gerçek `git diff --numstat` gözleminden gelir.
- Hard violation ve soft drift kararları ayrı kalır.
- Report receipt-binding hashleri değiştiğinde farklılaşır.
- Draft PR body'ye tek canonical `Soft Scope Drift` bölümü eklenir.
- Summary report hashine bağlı marker taşır ve duplicate section reddedilir.
- Core integration filesystem, shell, network veya Git write çalıştırmaz.
- `reports/release/SCOPE_DRIFT.json` gerçek disposable repository observation taşır.
- Artifact model kalitesi, token tasarrufu veya production latency iddiası yapmaz.

G5 beş aşamalı evidence zinciri:

```text
primitive
→ contract tests
→ canonical integration
→ live/real evidence
→ release artifact
```

AF.2b sonunda G5 kapanır. Release audit G8 ve G13 blockerları ile diğer eksik
release artifactları nedeniyle blocked kalmaya devam eder.

## AF.3a — Unified run cost ledger contract

<!-- PHASE_AF_3A_RUN_COST_LEDGER_STATUS -->

**Durum: Tamamlandı.**

Provider usage ve maliyet muhasebesi tek `RunCostLedger` contractında
birleştirilir. Ledger mevcut `AgentEventLedger` hash zincirine bağlanır; event
token usage ile cost observation token usage exact eşleşmeden maliyet kaydı
üretilemez.

Usage sınıfları kesin biçimde ayrıdır:

```text
observed
estimated
unavailable
```

`estimated` veya `unavailable` değerler observed token/cost toplamına hiçbir
zaman eklenmez.

Ledger aşağıdaki dağılımları ayrı taşır:

- Planner, coder ve verifier input/output/total tokenları.
- Remask ve repair tokenları.
- Expansion overhead.
- Shadow ve admin overhead.
- Retry invocation ve retry tokenları.
- Provider/model provenance.
- Provider price snapshot.
- Exact nano-USD/token maliyeti.
- Tam observed coverage varsa cost per accepted patch.

A/B/C benchmark contractı:

```text
A — direct_large_context
B — fixed_bounded_context
C — adaptive_bounded_context
```

Tasarruf karşılaştırmasının release-claim eligible olması için:

- Üç stratejinin de bulunması.
- Aynı task seti.
- Aynı provider/model seti.
- Aynı pricing snapshot seti.
- Bütün run'ların live provider call olması.
- Her invocation'ın provider-reported usage taşıması.
- Bütün invocation'ların fiyatlandırılmış olması.
- En az bir accepted patch bulunması.

AF.3a smoke reportu `evidenceClass=deterministic_fixture` ve
`releaseClaimEligible=false` taşır. Sentetik fixture gerçek token veya maliyet
tasarrufu kanıtı sayılamaz.

G8 bu aşamada tamamen kapanmaz. Evidence zinciri:

```text
primitive                 ✅
contract tests            ✅
canonical integration     ✅
live/real evidence        ⏳
release artifact          ⏳
```

AF.3b aynı provider, model, task seti ve pricing snapshot ile gerçek A/B/C
çağrılarını capture edecek ve yalnız o zaman
`reports/release/OBSERVED_TOKEN_COST.json` artifactını üretecektir.

## AF.3b — Live A/B/C token-cost capture

<!-- PHASE_AF_3B_LIVE_COST_STATUS -->

**Durum: Tamamlandı.**

Aynı provider, model, temperature, task seti ve price snapshot altında üç
strateji gerçek OpenAI-compatible HTTP çağrılarıyla çalıştırılır:

```text
A — direct_large_context
B — fixed_bounded_context
C — adaptive_bounded_context
```

Her strateji iki aynı görev için planner, coder ve verifier çağrısı yapar.
Toplam 18 provider invocation gözlemlenir.

Release artifact yazımı ancak aşağıdaki şartların tamamında açılır:

- `AF3B_LIVE_REQUIRED=1`.
- Açık operator attestation vardır.
- Bütün provider response'ları observed usage taşır.
- Üç stratejide bütün görevler deterministic acceptance ve verifier onayından geçer.
- Provider/model seti aynıdır.
- Pricing snapshot seti aynıdır.
- Input/output price snapshot birlikte sıfır değildir.
- Benchmark `releaseClaimEligible=true` üretir.
- `AF3B_WRITE_RELEASE_ARTIFACTS=1`.

Local HTTP mock suite gerçek network round-trip yapar fakat
`evidenceClass=deterministic_fixture` taşır ve hiçbir release artifact yazamaz.

Coder acceptance, literal implementation parçaları yerine TypeScript AST üzerinden
doğrulanır. Böylece `Math.min/Math.max` ve eşdeğer guard-clause clamp
uygulamaları kabul edilir; tek taraflı veya eksik sınır uygulamaları reddedilir.

Başarılı live koşu:

- `reports/release/OBSERVED_TOKEN_COST.json`
- `docs/release/OBSERVED_TOKEN_COST.md`

artifactlarını üretir, G8'i beş aşamalı evidence zinciriyle kapatır ve release
audit'i yalnız G13 blockerıyla bırakır.

Self-hosted inference için operator-configured token fiyatı tam altyapı TCO'su
olarak sunulamaz; yalnız operatorün açıkça tanımladığı maliyet snapshot'ıdır.

## AF.3 — Context benchmark aileleri

- Missing source/type/helper/caller/test fixtures.
- Distractor context fixtures.
- Context ablation.
- Expansion sonrası başarı fixture'ları.
- Hard budget overflow fixture'ları.
- Provider timeout/invalid JSON fixture'ları.

## AF.4a — Canonical runtime generation boundary

<!-- PHASE_AF_4A_RUNTIME_BOUNDARY_STATUS -->

**Durum: Tamamlandı.**

`@bounded-dllm-agent-lab/product-runtime` package rootu yalnız
`canonical-runtime.ts` yüzeyini dışa açar. Historical `index.ts` mock,
synthetic workspace ve research compatibility API'lerini korur fakat package
`exports` mapinde bulunmaz.

Repository-bound boundary reportu:

- package `main` ve `exports` alanlarını,
- canonical coordinator exportunu,
- canonical entrypointte legacy symbol bulunmamasını,
- research-only entrypoint markerını,
- fixture scan ile observed repository scan ayrımını

fail-closed olarak doğrular.

G13 evidence zinciri:

```text
runtime boundary primitive
→ negative contract tests
→ package export integration
→ repository source scan report
→ architecture release artifact
```

AF.2a/AF.2b hard ve soft scope benchmarklarını daha önce tamamlamıştır.

## AF.4b — Unified v0.1 release artifact pack

<!-- PHASE_AF_4B_RELEASE_PACK_STATUS -->

**Durum: Tamamlandı.**

Repositorydeki observed Qwen token/cost, disposable-repo scope ve canonical
runtime boundary evidenceı tek release synthesis altında birleştirildi.
Synthesis yeni live sonuç uydurmaz; her source artifactın evidence classını,
file hashini ve claim boundarysini korur.

Tamamlanan artifactlar:

- README quickstart.
- Architecture diagram.
- Threat model.
- Unified benchmark report.
- Context sufficiency report.
- Hard/soft scope drift report.
- Acceptance criteria coverage report.
- Observed token/cost report.
- Fail-closed matrix.
- Gap closure audit.
- Known limitations.
- v0.1 release notes.

`npm run verify:release`, 55/55 repository evidence locatorı ve 12/12 required
artifact hashini doğruladığında `repository_release_evidence_ready` üretir.

## AF.4c — v0.1 tag and release publication

<!-- PHASE_AF_4C_RELEASE_PUBLICATION_STATUS -->

**Durum: Tamamlandı.**

Clean `main` üzerinde `npm run verify:release` tekrar geçti. `v0.1.0`
annotated tagi doğrulanmış AF.4b commitine bağlandı ve aynı tagden kararlı
GitHub Release yayımlandı. v0.1 evidence zinciri bu tag ile dondurulmuştur.
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

## AG — Post-v0.1 Product Intelligence

`v0.1.0` release evidenceı yayımlanmış tag üzerinde dondurulmuştur. Post-v0.1
geliştirmeler eski release hashlerini geriye dönük yeniden yazmaz; yeni primitive,
integration ve benchmark zincirleri ayrı AG evidenceı üretir.

### AG.1a — Canonical Repo Intelligence primitive and contract

<!-- PHASE_AG_1A_REPO_INTELLIGENCE_STATUS -->

**Durum: Tamamlandı.**

Amaç, eski `packages/repo-intelligence` path ve naming heuristiklerini doğrudan
canonical API diye yeniden kullanmak değil; product runtime neslinde deterministic,
salt-okunur ve hard-limitli bir repository intelligence primitive'i oluşturmaktır.

AG.1a kapsamı:

- TypeScript compiler AST ile JavaScript/TypeScript import, re-export, dynamic
  import ve CommonJS `require` referanslarını çıkarmak.
- NodeNext `.js` source specifierlarını repositorydeki `.ts`/`.tsx` kaynaklarına
  deterministik biçimde çözmek.
- Top-level symbol, export ve external dependency envanteri üretmek.
- Seed file'lardan bounded dependency closure oluşturmak.
- File, byte, edge ve dependency-depth limitlerinde fail-closed davranmak.
- Root traversal, eksik seed, unresolved reachable relative import ve symlink
  durumlarını reddetmek.
- Çıktıyı canonical JSON hashine bağlamak ve tamper verification sağlamak.
- Filesystem write, shell ve network erişimi yapmamak.

Bu adım primitive ve contract seviyesidir. `canonical-runtime.ts` package exportu
bilinçli olarak AG.1b'ye bırakılır; böylece yayımlanmış v0.1 runtime-boundary
evidence hashleri geriye dönük değiştirilmez.

### AG.1b — Canonical integration and context binding

<!-- PHASE_AG_1B_CONTEXT_BINDING_STATUS -->

**Durum: Tamamlandı.**

AG.1a intelligence çıktısı coder çağrısından önce zorunlu bir canonical gate
olarak bağlandı:

```text
seed files
→ AST import/export/symbol graph
→ bounded dependency closure
→ content-hash evidence validation
→ context binding receipt
→ adaptive Context Sufficiency Gate
→ coder provider
```

Dependency closure `requiredSourceFiles` ve `allowedContextFiles` sınırını üretir.
Required testler yalnız aynı intelligence snapshotında mevcutsa eklenir. Initial
evidence path, byte length ve content hash ile snapshot'a bağlanır. Stale,
boundary dışı veya allowed/forbidden çakışmalı evidence coder çağrısından önce
fail-closed reddedilir.

`repositoryIdentityHash`, absolute checkout path yerine sıralı path/content-hash
snapshotından üretilir. Aynı repository bytesı farklı checkout klasörlerinde aynı
intelligence ve binding hashlerini verir.

Canonical public entrypoint `canonical-product-runtime/v0.2-dev` olarak
sürümlendi. `typescript`, AST analizi runtime dependency'si olarak
`@bounded-dllm-agent-lab/product-runtime` package sınırına eklendi.

AG evidence:

- `docs/results/AG1B_REPO_INTELLIGENCE_CONTEXT_BINDING.md`
- `reports/ag/AG1B_REPO_INTELLIGENCE_CONTEXT_BINDING.json`
- `npm run verify:ag1b`

Evidence class `deterministic_fixture`dır. Live-model task quality, latency,
token savings veya altyapı maliyeti iddiası üretmez. Yayımlanmış v0.1 evidenceı
`v0.1.0` taginde dondurulmuş kalır; post-v0.1 main üzerinde eski artifact hashleri
geriye dönük yeniden yazılmaz.

### AG.1c — Task-to-seed implementation contract

<!-- PHASE_AG_1C_TASK_TO_SEED_STATUS -->

**Durum: Tamamlandı.**

Kullanıcı görevinin kimliği; seed file, required symbol, required test ve mevcut
Acceptance Criteria Contract hashine bağlandı. Implementation contract ve graph
audit receipt canonical JSON hashleri taşır.

```text
taskId + objectiveHash
→ seed/symbol/test proposal
→ acceptance identity binding
→ Repo Intelligence graph audit
→ intelligence snapshot lock
→ AG.1b context binding
→ coder
```

Seed dependency closure içinde çözülemeyen symbol, intelligence snapshotında
bulunmayan test veya bozuk acceptance kimliği provider çağrılarından önce
fail-closed durur.

Audit sonrası repository AG.1b tarafından yeniden taranır. İkinci
`intelligenceHash` audit hashinden farklıysa
`repo_context_intelligence_snapshot_mismatch` üretilir ve coder çağrılmaz.
Başarılı akış contract, audit, repo binding ve coder context hashlerini tek
execution receiptte bağlar.

AG.1c evidence:

- `docs/results/AG1C_TASK_TO_SEED_IMPLEMENTATION_CONTRACT.md`
- `reports/ag/AG1C_TASK_TO_SEED_IMPLEMENTATION_CONTRACT.json`
- `npm run verify:ag1c`

Evidence class `deterministic_fixture`dır ve 14 contract/integration checki
taşır. Live-model kalite, token, latency veya maliyet iddiası değildir.

### AG.2a — Bounded planner proposal contract

<!-- PHASE_AG_2A_BOUNDED_PLANNER_STATUS -->

**Durum: Tamamlandı.**

Task identity, acceptance contract, authority ve policy hashleri tek bounded
planner proposal içinde bağlandı. Planner yalnızca seed file, seed rationale,
required symbol, required test ve expansion-attempt önerisi üretebilir.

```text
task
→ bounded planner proposal
→ exact schema + authority/policy checks
→ scope and forbidden-file budgets
→ AG.1c implementation contract
→ graph audit
→ coder
```

Proposal geçersizse AG.1c ve coder çağrılmaz. Proposal hash, implementation
contract hash ve task-seed execution binding hash başarılı akışta tek execution
binding receipt içinde zincirlenir.

AG.2a evidence:

- `docs/results/AG2A_BOUNDED_PLANNER_PROPOSAL_CONTRACT.md`
- `reports/ag/AG2A_BOUNDED_PLANNER_PROPOSAL_CONTRACT.json`
- `npm run verify:ag2a`

Evidence class `deterministic_fixture`dır ve 15 check taşır. Live-model kalite,
token, latency veya maliyet iddiası değildir.

### AG.2b — Planner provider adapter and live proposal validation

<!-- PHASE_AG_2B_PLANNER_PROVIDER_STATUS -->

**Durum: Tamamlandı.**

AG.2a planner-provider yüzeyi OpenAI-compatible chat-completions adapterına
bağlandı:

```text
bounded planner context
→ strict provider prompt
→ JSON draft
→ trusted reason/proposal hashing
→ AG.2a proposal validation
→ observed attempt/run evidence
```

Modelden cryptographic hash üretmesi beklenmez. Model yalnız seed, rationale
text, symbol, test ve expansion önerisi döndürür. Adapter reason ve proposal
hashlerini üretip AG.2a contractına yeniden doğrulatır.

Adapter:

- timeout, network, 429 ve 5xx için en fazla iki bounded attempt;
- malformed JSON/draft için tek corrective retry;
- non-retryable HTTP, response-byte ve task-context-byte fail-closed sınırları;
- provider-reported usage capture;
- operator-configured token-rate comparison;
- hash-linked attempt ve run evidence

sağlar.

Deterministic evidence:

- `docs/results/AG2B_OPENAI_COMPATIBLE_PLANNER_PROVIDER.md`
- `reports/ag/AG2B_OPENAI_COMPATIBLE_PLANNER_PROVIDER.json`
- `npm run verify:ag2b`
- 16 check
- `readyForRunPodLiveValidation=true`

Deterministic fixture live-model kalite, live token veya altyapı maliyeti iddiası
değildir.

RunPod RTX 3090 üzerinde `qwen2.5-coder-7b` ile iki gerçek planner vakası
tek attempt ile geçti. Provider-reported usage 1.422 input, 857 output ve toplam
2.279 tokendır. Live report `evidenceClass=observed_run`,
`ag2b_live_planner_validation_passed` ve
`sha256:9fd6b85fde3a6c5410e5bd186df26145820bac7e0818c308805659a5d959d4dc`
hashini taşır. Pricing yapılandırılmadığı için maliyet üretilmez ve
`infrastructureCostObserved=false` kalır.

Live komut:

```text
npm run validate:ag2b-live
```

Live artifact:

```text
reports/ag/AG2B_OPENAI_COMPATIBLE_PLANNER_PROVIDER_LIVE.json
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
