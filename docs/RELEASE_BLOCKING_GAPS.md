# Release-Blocking Gaps and Claim Boundaries

Bu belge, `bounded-dllm-agent-lab` içinde mevcut görünen fakat henüz ürün garantisi seviyesine ulaşmamış alanları kaydeder. Amaç yapılan çalışmaları küçümsemek değil; schema, smoke test, live fixture ve gerçek ürün garantisi arasındaki farkın kaybolmasını engellemektir.

Bu dosya `ROADMAP.md` ile birlikte okunur. Roadmap hangi fazın neyi kapatacağını gösterir; bu kayıt ise neden eksik olduğunu, yanlış anlaşılabilecek iddiayı ve kapanış kriterini saklar.

---

## 1. Durum dili

Her özellik şu dört durumdan biriyle değerlendirilir:

1. **Primitive mevcut**  
   Fonksiyon, type, script veya izole modül vardır.

2. **Contract doğrulandı**  
   Pozitif ve negatif fixture'lar beklenen kararı üretir.

3. **Canonical runtime'a entegre edildi**  
   Özellik gerçek ürün akışında zorunlu gate veya coordinator adımıdır.

4. **Ürün garantisi kanıtlandı**  
   Gerçek repo, model, process ve failure senaryolarında tekrar üretilebilir evidence vardır.

Aşağıdaki ifadeler eşdeğer değildir:

```text
Type var
≠ smoke test geçiyor
≠ live fixture çalışıyor
≠ ürün garantisi kanıtlandı
```

Bir gap yalnızca son iki seviye tamamlandığında release açısından kapalı sayılır.

---

## 2. Gap özeti

| ID | Gap | Sahibi | v0.1 blocker |
| --- | --- | --- | --- |
| G1 | Coder gerçek repo source context'i her zaman görmüyor | CSG + AC | Evet |
| G2 | Context budget hard-enforced değil | CSG | Evet |
| G3 | Semantic context sufficiency ve adaptive expansion eksik | CSG | Evet |
| G4 | Repo Intelligence ağırlıklı heuristic | CSG v1 + post-MVP planner | Kısmen |
| G5 | Soft scope drift ölçümü eksik | AF | Evet |
| G6 | Deterministic verifier'ın claim boundary'si belirsizleşebilir | AC + AF docs | Evet |
| G7 | Structured acceptance criteria ve criterion evidence eksik | AC + AE | Evet |
| G8 | Unified observed token/cost ledger eksik | AF | Evet |
| G9 | Provider failure bütün yollarda hard blocker değil | CSG + runtime integration | Evet |
| G10 | Evidence string'leri referential olarak doğrulanmıyor | AE | Evet |
| G11 | Hash tamper-evident fakat authenticated değil | Known limitation | Hayır |
| G12 | SQLite registry distributed değil | Post-MVP | Hayır |
| G13 | Legacy/mock ve product runtime nesilleri birlikte yaşıyor | AF cleanup | Evet |
| G14 | Tek canonical public coordinator API eksik | AB–AE | Evet |

---

# G1 — Coder gerçek repo-aware source context'i her zaman görmüyor

## Mevcut durum

Worker-backed canlı akış model çağırabiliyor ve modelden bounded `patchDraft` alabiliyor. Fixture içinde dosya içeriği tanımlanmış olsa da bazı coder prompt yollarında yalnızca:

- görev,
- planner mutation,
- allowed files,
- forbidden files

bulunuyor. Mevcut source dosyasının içeriği, ilgili type'lar, helper'lar ve caller'lar her canonical çağrıda garanti edilmiyor.

## Yanlış anlaşılabilecek iddia

```text
Live coder çalışıyor
```

ifadesi şu an yalnızca modelin contract-shaped patch önerisi ürettiğini gösterebilir. Bu, modelin gerçek kod tabanını okuyup uyumlu değişiklik yaptığı anlamına gelmez.

## Risk

- Mevcut implementasyon tekrar yazılabilir.
- Var olmayan symbol kullanılabilir.
- Import stili veya public API bozulabilir.
- Test fixture'a özel hard-coded patch üretilebilir.

## Kapanış kriteri

- Coder prompt packet'ında target source content bulunur.
- Gerekli import/type/helper/test context'i provenance ile listelenir.
- Missing source fixture patch üretmeden durur.
- Existing implementation'a bağlı gerçek görev başarıyla çözülür.
- Context packet ve source hash release artifact'ında görünür.

## Faz sahibi

`CSG v1` ve `AC`.

---

# G2 — Context budget ölçülüyor fakat hard-enforced değil

## Mevcut durum

Context Composer:

- token tahmini,
- budget utilization,
- warning,
- `sufficient | risky | insufficient`

alanları üretir.

Bütçe aşıldığında context otomatik küçültülmeyebilir ve model çağrısı kesin olarak engellenmeyebilir.

## Yanlış anlaşılabilecek iddia

```text
Agent 2.200 token bütçesiyle çalışıyor
```

ifadesi, yalnızca raporlanan hedef bütçeyi gösterebilir; gerçek hard ceiling olduğunu garanti etmez.

## Kapanış kriteri

- `estimatedTokens > hardBudget` durumunda provider çağrısı yapılmaz.
- Composer deterministic recomposition yapar.
- Hâlâ sığmıyorsa `replan_required` veya `human_review_required` üretir.
- Bütçe aşımı negatif fixture'ı yanlış başarı üretmez.
- Observed provider input tokenı ayrıca raporlanır.

## Faz sahibi

`CSG v1`.

---

# G3 — Semantic context sufficiency ve adaptive expansion eksik

## Mevcut durum

Context risk hesabı çoğunlukla:

- fact varlığı,
- missing authority,
- tahmini token bütçesi

üzerinden yapılır.

Henüz tam olarak bulunmayanlar:

- unresolved symbol tespiti,
- missing dependency/caller/test listesi,
- `contextRequest` mutation'ı,
- bounded expansion state machine,
- expansion sonrası yeniden değerlendirme,
- yetersiz context'te hard execution stop.

## Kapanış kriteri

- Structured `contextRequest` contract'ı vardır.
- En fazla iki expansion yapılır.
- Aynı dosya tekrar istenemez.
- Scope expansion otomatik onaylanmaz.
- Missing-context fixture doğru dosyayı ister.
- Expansion limiti aşılırsa patch ve handoff üretilmez.

## Faz sahibi

`CSG v1`.

---

# G4 — Repo Intelligence gerçek semantic graph değildir

## Mevcut durum

Repo Intelligence v1/v2 ağırlıklı olarak:

- klasör yapısı,
- dosya adı ve uzantı,
- test naming convention,
- top-level module path,
- hafif content signal

kullanır.

Henüz ürün garantisi seviyesinde bulunmayanlar:

- TypeScript AST,
- import graph,
- symbol resolution,
- interface implementation graph,
- call graph,
- Git co-change history,
- gerçek CODEOWNERS çözümleme.

## Doğru claim

```text
Lightweight repository heuristics
```

## Yanlış claim

```text
Tam repository comprehension
```

## Kapanış kriteri

v0.1 için:

- Heuristic fact'ler `inferred` olarak etiketlenir.
- Uncertain fact deterministic authority gibi kullanılmaz.
- Missing semantic evidence human review üretebilir.

Post-MVP için:

- AST/import graph eklenir.
- Symbol ve dependency lookup CSG'ye bağlanır.
- Aynı benchmark üzerinde katkısı ölçülür.

## Faz sahibi

CSG v1 sınırlı koruma; Bounded Project Planner tam geliştirme.

---

# G5 — Hard scope kontrolü var, soft scope drift ölçümü eksik

## Mevcut durum

Mutation validator:

- allowed file,
- forbidden file,
- role/target permission

kontrollerini yapar.

Bununla birlikte agent allowed path içinde gereksiz dosyalar değiştirebilir.

## Ayrım

```text
Hard scope violation
= Yetkisiz dosya veya region'a dokunmak

Soft scope drift
= Yetkili alanda fakat görev için gereksiz değişiklik yapmak
```

## Gerekli ölçümler

- Expected vs actual file set farkı.
- Unexpected-but-allowed file count.
- Unnecessary LOC.
- Unrequested refactor count.
- New dependency count.
- New abstraction justification rate.
- Human reviewer “gereksiz değişiklik” etiketi.

## Kapanış kriteri

- Hard ve soft drift ayrı raporlanır.
- Scope drift sadece final decision proxy'siyle ölçülmez.
- En az bir allowed-but-unnecessary fixture blocker veya review üretir.
- Draft PR'da soft drift özeti vardır.

## Faz sahibi

`AF`; minimality policy post-MVP iyileştirme.

---

# G6 — Deterministic verifier kodun tamamen doğru olduğunu kanıtlamaz

## Mevcut durum

Verifier güçlü biçimde şunları kontrol eder:

- mutation contract,
- coder/patchDraft rolü,
- patch claim varlığı,
- touched file uyumu,
- allowed/forbidden scope,
- belirli unsafe string sinyalleri,
- minimum confidence.

Doğrudan kanıtlamadığı alanlar:

- syntax ve type correctness,
- symbol existence,
- API compatibility,
- behavior correctness,
- business acceptance criteria,
- edge case coverage.

## Doğru claim

```text
Patch contract ve boundary kontrollerinden geçti.
```

## Yanlış claim

```text
Kod kesin doğrudur.
```

## Kapanış kriteri

Doğrulama zinciri açıkça ayrılır:

```text
mutation/schema verifier
→ patch parse/apply
→ typecheck/lint/tests
→ acceptance criteria evidence
→ gerektiğinde semantic/human review
```

## Faz sahibi

`AC` ve `AF` dokümantasyonu.

---

# G7 — Test çalışması acceptance criteria kanıtı değildir

## Mevcut durum

Temporary execution verifier:

- allowlisted executable,
- shell kapalı çalışma,
- timeout,
- output limiti,
- exit code

kontrollerini yapar.

Fakat görev contract'ında yapılandırılmış acceptance criteria ve criterion-to-evidence mapping henüz canonical değildir.

## Risk

Tüm mevcut testler geçebilir fakat kullanıcı tarafından istenen davranış çözülmemiş olabilir.

## Kapanış kriteri

```ts
type TaskSpec = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  requiredValidation: ValidationRequirement[];
};
```

Her criterion:

- test receipt,
- static check,
- file/symbol evidence,
- human review

kanıtlarından birine bağlanır.

`tests passed` ile `task accepted` ayrı sonuçlardır.

## Faz sahibi

`AC` ve `AE`.

---

# G8 — Unified observed token/cost ledger eksik

## Mevcut durum

Projede iki ölçüm türü birlikte bulunur:

- `JSON.stringify(...).length / 4` gibi estimated token hesabı,
- bazı worker/live suite'lerde provider usage alanları.

Eski cost benchmark'larda direct output gibi bazı değerler sentetik veya sabit olabilir.

## Yanlış anlaşılabilecek iddia

Estimated benchmark sonucu gerçek üretim maliyet tasarrufu gibi sunulmamalıdır.

## Kapanış kriteri

Tek `RunCostLedger`:

- planner input/output,
- coder input/output,
- verifier input/output,
- remask input/output,
- shadow/admin overhead,
- expansion,
- retries,
- provider price snapshot,
- cost per accepted patch

alanlarını taşır.

Direct ve bounded kıyas aynı model/provider/task setiyle gerçek çağrı yapar.

## Faz sahibi

`AF`.

---

# G9 — Provider failure bütün canonical yollarda hard blocker değil

## Mevcut durum

Bazı yeni worker-backed zincirlerde required/fail-closed davranış güçlüdür. Generic provider adapter yolunda geçersiz çıktı safe fallback'e çevrilebilir:

- confidence `0`,
- rejected claim,
- boş verifier finding.

Fallback bilgisi final deterministic karara zorunlu blocker olarak taşınmazsa yanlış approve riski oluşabilir.

## Kapanış kriteri

- Required provider failure explicit finding üretir.
- Planner/coder/verifier required rol hatası sessiz fallback değildir.
- `provider_execution_failed` sonucu `human_review_required` veya `reject` üretir.
- Timeout, HTTP error, invalid JSON ve invalid shape fixture'ları yanlış approve üretmez.

## Faz sahibi

`CSG v1` ve canonical runtime integration.

---

# G10 — Evidence alanı typed ve referential değil

## Mevcut durum

Bazı claim'lerde evidence `string[]` olarak tutulur. String'in gerçekten:

- dosyaya,
- event'e,
- test receipt'e,
- policy rule'a,
- snapshot'a

işaret ettiği doğrulanmayabilir.

## Kapanış kriteri

```ts
type EvidenceReference =
  | { type: "file"; path: string; contentHash: string }
  | { type: "event"; eventId: string }
  | { type: "test_receipt"; receiptHash: string }
  | { type: "policy_rule"; ruleId: string }
  | { type: "repository_snapshot"; snapshotHash: string };
```

Ledger verifier:

- referans var mı,
- hash eşleşiyor mu,
- run'a ait mi,
- stale mi

kontrollerini yapar.

## Faz sahibi

`AE`.

---

# G11 — Hash integrity authentication değildir

## Mevcut durum

Artifact ve registry record hash'leri accidental/casual tampering'i görünür kılar. Ancak gizli key veya signature yoksa full filesystem write erişimi olan aktör içeriği ve hash'i birlikte değiştirebilir.

## Doğru claim

```text
Tamper-evident under the assumed local filesystem trust model.
```

## Yanlış claim

```text
Cryptographically authenticated against a malicious local administrator.
```

## v0.1 kararı

Release blocker değildir; threat model ve known limitations içinde açıkça yazılır.

## Post-MVP

- HMAC,
- Ed25519,
- KMS signing,
- append-only remote audit,
- GitHub check attestation

seçenekleri değerlendirilir.

---

# G12 — Durable registry distributed değildir

## Mevcut durum

SQLite registry aynı makine veya ortak persistent volume üzerinde:

- process race,
- restart persistence,
- replay control

için uygundur.

Farklı disk kullanan iki cloud worker aynı reservation'ı ayrı ayrı kazanabilir.

## v0.1 kararı

Local/self-hosted kullanım sınırı açıkça belirtilirse release blocker değildir.

## Post-MVP kapanış

- PostgreSQL unique idempotency key.
- Transactional reservation.
- Advisory lock veya lease.
- Heartbeat ve abandoned reservation recovery.

---

# G13 — İki mimari nesil birlikte yaşıyor

## Kapanış durumu

**Kapalı — AF.4a.**

Repository tarihsel araştırma ve fixture yüzeylerini silmez; bunun yerine
ürün ve araştırma nesillerini package boundary seviyesinde ayırır:

- Package root yalnız `canonical-runtime.ts` yüzeyine çözülür.
- Historical `index.ts`, `RESEARCH_ONLY_COMPATIBILITY_ENTRYPOINT` olarak etiketlidir.
- Package `exports` mapinde legacy veya research subpath yoktur.
- Canonical entrypoint mock orchestration, synthetic workspace veya legacy
  `reviewPatch` sembollerini dışa açmaz.
- Fixture source scan release-claim eligible olamaz.
- Yalnız gerçek repository source scan sonucu observed evidence sayılır.

## Kapanış kanıtı

```text
runtime-generation-boundary.ts
→ runtime-generation-boundary-smoke.cjs
→ packages/product-runtime/package.json
→ reports/release/RUNTIME_GENERATION_BOUNDARY.json
→ docs/release/ARCHITECTURE.md
```

## Doğru claim

```text
v0.1 package consumers receive one canonical product-runtime entrypoint;
historical research APIs remain repository-internal compatibility surfaces.
```

Bu kapanış historical araştırma kodunun silindiği veya npm packaging/publishing
zincirinin production-grade olduğu iddiasını yapmaz.

## Faz sahibi

`AF cleanup`.

---

# G14 — Tek canonical public coordinator API eksik

## Mevcut durum

Çok sayıda güçlü primitive ve script vardır. Ancak dış kullanıcının tek çağrıyla:

```text
task
→ bounded execution
→ validation
→ controlled branch
→ evidence-backed draft PR
```

akışını çalıştıracağı kararlı public API henüz tam değildir.

## Risk

Kullanıcı primitive'leri yanlış sırada birleştirebilir veya zorunlu gate'i atlayabilir.

## Kapanış kriteri

Örnek public yüzey:

```ts
const result = await runBoundedTask({
  repository,
  task,
  policy,
  provider,
  delivery: "draft_pr"
});
```

Coordinator:

- CSG,
- mutation validator,
- verifier,
- governance,
- registry,
- apply,
- validation,
- recovery,
- draft PR

adımlarını doğru sırada zorunlu çalıştırır.

Public API iç path import gerektirmez.

## Faz sahibi

`AB–AE`.

---

## 3. v0.1 hard blockers

Aşağıdakilerden biri doğruysa v0.1 ürün release'i tamamlanmış sayılmaz:

- Context yetersizken coder patch üretebiliyor.
- Coder gerçek source içeriği olmadan başarı kabul ediliyor.
- Hard token budget aşılmasına rağmen model çağrılıyor.
- Provider failure sonrasında approve oluşabiliyor.
- Tests passed sonucu acceptance criteria yerine kullanılıyor.
- Soft scope drift ölçülmiyor.
- Estimated token sonucu observed tasarruf gibi sunuluyor.
- Evidence referansları doğrulanmıyor.
- Legacy/mock flow public canonical flow gibi sunuluyor.
- Tek coordinator API ve `verify:release` yok.

---

## 4. Gap closure kanıt şablonu

Her kapatılan gap için release report şu alanları taşır:

```json
{
  "gapId": "G1",
  "status": "closed",
  "primitivePresent": true,
  "contractTestsPassed": true,
  "canonicalIntegrationPassed": true,
  "negativeFixturesPassed": true,
  "liveOrRealEvidencePassed": true,
  "artifactPaths": [],
  "knownLimitations": []
}
```

`status: closed` yalnızca bütün zorunlu alanlar doğruysa kullanılabilir.

---

## 5. Claim policy

Release, README, LinkedIn paylaşımı veya ürün sunumlarında:

- “Var” yerine kanıt seviyesi söylenir.
- Estimated ile observed metrik ayrılır.
- Deterministic verifier ile behavioral correctness ayrılır.
- Hard scope ile soft scope drift ayrılır.
- Local durability ile distributed durability ayrılır.
- Tamper-evident ile authenticated integrity ayrılır.
- Fixture success ile real-repo success ayrılır.

Ürün iddiası her zaman en zayıf açık halkaya göre sınırlandırılır.
