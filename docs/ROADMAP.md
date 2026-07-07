# Ürün Yol Haritası: Bounded Agent Orchestration Runtime

Bu doküman, Bounded dLLM Agent Lab projesinin ürün, araştırma ve mühendislik yönünü güncel tutmak için yazılmıştır.

Projenin ana yönü şudur:

```text
Kurumsal yazılım ekipleri için shared semantic workspace tabanlı,
dar contextli, scope-safe agent orchestration runtime.
```

Başka bir ifadeyle:

```text
Model orkestrasyonu değil;
context, authority, workspace, bounded working memory ve agent flow orkestrasyonu.
```

Bu ürünün amacı Cursor, Codex, Windsurf veya benzeri agentic coding araçlarının sadece üstüne güvenlik eklentisi koymak değildir. Daha temel amaç, agentic coding akışında agent’ların:

* ne görebileceğini,
* neyi değiştirebileceğini,
* hangi ortak state üzerinden çalışacağını,
* ne zaman duracağını,
* ne zaman verifier’a gideceğini,
* ne zaman lokal remask repair yapılabileceğini,
* hangi kararın neden verildiğini,

yöneten bağımsız ve ölçülebilir bir runtime kurmaktır.

PR review, GitHub Action ve policy checker yüzeyleri bu runtime’ın ilk pratik kullanım alanlarıdır. Ürünün çekirdeği bundan daha geneldir:

```text
Bounded-context shared-workspace agent orchestration runtime.
```

---

## Güncel Durum Snapshot

Proje artık yalnızca policy/verifier veya PR review katmanından ibaret değildir. Şu noktaya gelmiştir:

```text
Deterministic bounded runtime çekirdeği doğrulandı.
Shared semantic workspace, bounded role context, orchestrator, remask ve safety flow çalışıyor.
Model-worker proxy ve live acceptance hattı eklendi.
Qwen + Dream RunPod live acceptance çalıştı.
12-case live benchmark runner hazırlandı.
Phase N ile reproducibility ve dokümantasyon tamamlandı.
Phase O ile live evidence güçlendirildi.
Qwen ve Dream davranışı 12-case JSON, compact payload ve decision-token modlarında test edildi.
```

Şu an savunulabilir güncel durum:

```text
Mock/deterministic bounded runtime çekirdeği doğrulandı.
Live model-worker benchmark yüzeyi doğrulandı.
Qwen + Dream canlı acceptance çalıştı.
12-case live benchmark runner kullanıldı.
Phase O.5-O.9 ile Qwen/Dream karşılaştırmalı evidence üretildi.
Qwen2.5-Coder 7B, bounded verifier-style benchmarklarda stabil ana worker adayı olarak öne çıktı.
Dream-Coder v0 Instruct 7B, mevcut wrapper ve prompt rejiminde güvenilir verifier/decision worker olarak kullanılamadı.
```

Bu, “Qwen her alanda üstündür” veya “dLLM yaklaşımı değersizdir” anlamına gelmez. Güvenli yorum şudur:

```text
Bu görev ailesinde ve mevcut wrapper/prompt rejiminde Qwen2.5-Coder 7B,
format uyumu, karar token üretimi ve latency açısından pratik worker adayıdır.

Dream-Coder v0 Instruct 7B ise mevcut haliyle bounded verifier veya decision-token worker olarak güvenilir davranmamıştır.
dLLM-style modeller ileride masked repair, local refinement veya remask planner rollerinde tekrar araştırılabilir;
ancak ilk ürün dependency’si olmamalıdır.
```

---

## Neden Bu Ürün Gerekli?

Current agentic coding tools are useful, but many of them still behave like a switchboard:

```text
one model plans
another model writes code
another model reviews
an orchestrator passes text between them
```

Bu akış yararlı olabilir, fakat bu hâlâ agent’ların aynı yapılandırılmış workspace üzerinde güvenli şekilde çalıştığı anlamına gelmez.

Daha derindeki problem yalnızca model kalitesi değildir. Asıl problem şudur:

```text
Context nasıl temsil ediliyor?
Agent hangi yetkiye sahip?
Agent neyi görebilir?
Neye dokunamaz?
Hangi bilgi stale?
Hangi karar güncel?
Ne zaman insan review gerekir?
Ne zaman lokal repair yeterlidir?
Model output’u workspace’e ne şekilde yazılabilir?
Geçersiz model output’u runtime’ı kırmadan nasıl engellenir?
```

Kurumsal yazılım ekiplerinde bu problem daha da büyür. Bir ekip billing modülünden, başka ekip auth modülünden, başka ekip mobile yüzeyden sorumlu olabilir. Coding agent’ın bütün projeyi görmesi, bütün projeye dokunabileceği anlamına gelmemelidir.

Bu lab ve ürün yönü bu problemi araştırır.

---

## Ürün Felsefesi

### 1. Daha Büyük Context Değil, Daha Doğru Context

Agent’a tüm repo, tüm chat history veya çok uzun bir prompt vermek her zaman daha iyi sonuç üretmez. Büyük context:

* maliyeti artırır,
* latency’yi artırır,
* gereksiz bilgiyle karar sinyalini seyreltir,
* scope drift riskini artırır,
* agent’ın kendi yetki alanını unutmasına neden olabilir.

Bu ürünün temel hedefi şudur:

```text
Her agent’a maksimum context değil,
görevini yapmasına yetecek minimum doğru context ver.
```

Bu nedenle ürün yalnızca daha büyük context window kullanan bir coding agent değildir. Ürün, context seçimini ve agent yetkisini runtime seviyesinde yöneten bir katmandır.

---

### 2. Ortak Hafıza Değil, Ortak Workspace

Ürün kalıcı, sınırsız, agent’ların rastgele yazdığı bir memory sistemi olmamalıdır.

Doğru kavram:

```text
Shared semantic workspace
```

Bu workspace görev süresince yaşayan, yapılandırılmış ortak state’tir. Bir sohbet geçmişi değildir. İçinde şunlar bulunabilir:

* task intent,
* allowed scope,
* forbidden scope,
* repo facts,
* ownership,
* policy,
* role claims,
* patch plan,
* patch draft,
* verifier findings,
* remask request,
* test signals,
* merge decision,
* final decision,
* trace.

Agent’lar bu workspace’i doğrudan ve sınırsız görmez. Her agent kendi rolüne özel bounded view alır.

---

### 3. Hafıza Gibi Görünen Ama Hafıza Olmayan Working Memory

Her agent’a “hafızası varmış gibi” davranan bir context verilir. Fakat bu kalıcı kişisel memory değildir.

Doğru kavram:

```text
Bounded working memory
```

Özellikleri:

* task-bound,
* ephemeral,
* policy-bound,
* role-specific,
* traceable,
* silinebilir,
* yeniden üretilebilir.

Yani agent önceki her şeyi hatırlamak zorunda değildir. Runtime, workspace’teki gerekli parçaları seçip o agent’a hafıza gibi görünen dar bir view üretir.

---

### 4. Agent Özgürlüğü Değil, Agent Yetki Yönetimi

Klasik agent yaklaşımı çoğu zaman agent’a daha fazla tool, daha fazla context ve daha fazla özgürlük vermeye çalışır.

Bu ürünün yaklaşımı farklıdır:

```text
Agent’ın gücünü artırmadan önce sınırını, yetkisini ve bağlamını yönet.
```

Kurumsal yazılım ekiplerinde bu özellikle önemlidir. Çünkü agent’ın bütün projeyi görmesi, bütün projeyi değiştirme yetkisi olduğu anlamına gelmemelidir.

---

### 5. Model Output’u Direkt Gerçeklik Değildir

Phase P ile birlikte yeni kritik prensip şudur:

```text
Model output’u doğrudan runtime state değildir.
Model output’u önce doğrulanmış workspace mutation’a çevrilmelidir.
```

Yani modelin cevabı doğrudan:

```text
final decision
patch
merge approval
policy override
```

haline gelmemelidir.

Önce şu katmandan geçmelidir:

```text
model response
  -> parse
  -> schema validation
  -> role write boundary validation
  -> scope validation
  -> workspace mutation
  -> verifier/remask/merge flow
```

Bu sayede model hatası runtime hatasına dönüşmez.

---

### 6. Remask Default Değil, Verifier-Triggered Olmalı

Remask her zaman ikinci pass olarak çalışmamalıdır. Aksi halde maliyet artar ve gereksiz repair döngüleri oluşur.

Doğru davranış:

```text
Verifier bir failed region tespit ederse,
sadece o lokal bölge için remask aç.
```

Bu sayede remask:

* maliyet kontrolü sağlar,
* scope drift’i azaltır,
* tüm patch’i baştan üretmez,
* yalnızca eksik veya riskli bölgeyi onarır.

---

## Nihai Mimari Hedef

Nihai mimari şu akışa yaklaşmalıdır:

```text
User Task / Ticket / PR / Issue
  -> Workspace Builder
  -> Repo Graph + Ownership + Policy + Task Facts
  -> Shared Semantic Workspace
  -> Bounded Context Composer
  -> Role-Specific Agent Views
      -> Planner Agent
      -> Coder Agent
      -> Boundary Verifier Agent
      -> Tester Agent
      -> Remask Repair Agent
  -> Model Output Parser
  -> Workspace Mutation Validator
  -> Conflict-Aware Merge
  -> Decision
      approve | refuse | reject | remask_required | human_review_required
  -> Final Patch + Trace + Cost/Token Report
```

Bu akışta agent’lar aynı raw prompt içinde kavga eden karakterler değildir. Her agent:

* aynı semantic workspace’ten beslenir,
* farklı role-specific view alır,
* sadece belirli alanlara yazabilir,
* claim veya patch önerisini workspace’e yapılandırılmış olarak döker,
* verifier ve merge katmanı tarafından kontrol edilir.

---

## Ürün Ne Değildir?

Bu ürün şu değildir:

* sadece GitHub Action,
* sadece PR reviewer,
* sadece security checker,
* sadece model router,
* sadece “X model planlasın, Y model kodlasın” sistemi,
* Cursor/Codex/Windsurf yerine birebir IDE,
* tüm kararları LLM’e bırakan otomatik yazılım mühendisi,
* sınırsız memory veya sınırsız context sistemi,
* “dLLM daha güvenlidir” iddiasını ispatlamış bir sistem.

PR review ve GitHub Action yüzeyi yalnızca ilk pratik kullanım alanlarından biridir. Ürünün çekirdeği bundan daha geneldir:

```text
Bounded-context agent orchestration runtime.
```

---

## Ürün Şu An Ne Yapıyor?

Bugünkü durum, nihai ürünün tamamı değildir. Fakat sağlam bir temel oluşturur.

### Var Olan Runtime Çekirdeği

Şu an runtime:

* `task + diff + policy` input alabiliyor,
* shared workspace snapshot üretebiliyor,
* role-specific bounded view üretebiliyor,
* deterministic verifier çalıştırabiliyor,
* conflict-aware merge kararları üretebiliyor,
* remask repair simulation çalıştırabiliyor,
* safety layer ile riskli repair durumlarını bloklayabiliyor,
* `approve`, `refuse`, `reject`, `remask_required`, `human_review_required` kararları verebiliyor,
* JSON ve Markdown rapor üretebiliyor,
* GitHub Action artifact ve PR comment yüzeyi üretebiliyor.

### Var Olan Policy Engine Özellikleri

Policy engine şu sinyalleri destekliyor:

* allowed paths,
* forbidden paths,
* ownership rules,
* owner aliases,
* paired files,
* required test mappings,
* module boundaries,
* sensitive patterns,
* changed_when_contains koşulları.

### Var Olan Validation Katmanı

Şu ana kadar kurulan validation altyapısı:

* synthetic product pilot suites,
* NanoID real PR positive set,
* p-limit real PR positive set,
* reviewed label overrides,
* cross-repo external validation,
* mixed positive/negative external validation,
* CI gate.

MVP-10 sonucu:

```text
Positive reviewed PR: 24
Negative control: 12
Total case: 36
Decision accuracy: 100%
Positive pass rate: 100%
Blocker detection rate: 100%
False blocker: 0
Missed blocker: 0
Expected finding coverage: 100%
```

Bu sonuç ürünün son hali anlamına gelmez. Ancak verifier/policy katmanının ölçülebilir ve regresyon korumalı hale geldiğini gösterir.

---

## Live Model Worker ve Phase N/O Durumu

Phase M ve Phase N sonrasında proje, yalnızca deterministic mock runtime ile sınırlı değildir. Live model-worker yüzeyi de kurulmuştur.

Tamamlanan live model işleri:

* model-worker HTTP smoke,
* RunPod model-worker proxy adapter,
* RunPod live smoke runner,
* Qwen2.5-Coder-7B GGUF live endpoint acceptance,
* Dream-Coder-v0-Instruct-7B OpenAI-compatible server,
* Qwen + Dream live acceptance,
* 3-case live mini benchmark,
* `scripts/live-mini-benchmark.cjs` repo scripti,
* 12-case live benchmark runner,
* expected-vs-actual scoring,
* JSON compliance metriği,
* latency/token summary,
* endpoint yokken skipped report,
* required mode ile endpoint yokken fail davranışı,
* `.env.example`,
* RunPod Qwen + Dream live benchmark runbook,
* Phase N live benchmark sonuç dokümanı,
* Phase N final raporu,
* README Phase N navigasyon linkleri.

Live benchmark yüzeyi şu iki slotu destekler:

```text
LLM slot  -> Qwen2.5-Coder-7B
dLLM slot -> Dream-Coder-v0-Instruct-7B
```

Phase O ile bu yüzey daha güçlü evidence üretmek için kullanılmıştır.

---

## Phase O Final Sonuçları

Phase O’nun amacı yeni altyapı kurmak değil, Phase N’de kurulan 12-case live benchmark yüzeyinden daha güçlü kanıt üretmekti.

### Phase O.5 — Live 12-Case Benchmark Baseline

```text
Qwen:
- Expected match: 12/12
- JSON compliance: 12/12

Dream:
- Expected match: 1/12
- JSON compliance: 1/12
- Unknown: 11/12
```

Yorum:

```text
Qwen live verifier benchmark’ta hızlı, stabil ve format uyumlu davrandı.
Dream wrapper çalıştı fakat çıktı formatı ve karar üretimi büyük ölçüde başarısız kaldı.
```

---

### Phase O.7 — Strict Output Contract

Prompt daha sıkı JSON contract ile güncellendi.

```text
Qwen:
- Expected match: 12/12
- JSON compliance: 12/12

Dream:
- Expected match: 3/12
- JSON compliance: 3/12
- Unknown: 9/12
```

Yorum:

```text
Strict contract Dream tarafında kısmi iyileşme sağladı.
Ancak Dream hâlâ güvenilir verifier davranışı göstermedi.
```

---

### Phase O.8 — Compact Payload Clean Rerun

User payload büyük JSON yerine compact text formatına çekildi.

Temiz koşu sonucu:

```text
Qwen:
- Expected match: 12/12
- JSON compliance: 12/12

Dream:
- Expected match: 2/12
- JSON compliance: 2/12
- Unknown: 10/12
```

Yorum:

```text
Compact payload güvenilir bir iyileştirme sağlamadı.
Dream’in problemi sadece input JSON kopyalama davranışı değil;
model hâlâ çoğu case’te prose üretmeye devam etti.
```

---

### Phase O.9 — Decision Token Diagnostic Benchmark

Bu deneyde modellerden JSON istenmedi. Sadece tek karar token’ı istendi:

```text
approve
needs_review
reject
```

Sonuç:

```text
Qwen:
- Parsed decision: 12/12
- Expected match: 12/12
- Token compliance: 12/12
- Avg latency: ~71 ms

Dream:
- Parsed decision: 0/12
- Expected match: 0/12
- Token compliance: 0/12
- Unknown: 12/12
- Avg latency: ~12.74 s
```

Yorum:

```text
O.9, Dream tarafındaki problemin yalnızca JSON output contract olmadığını gösterdi.
Format yükü minimuma indirildiğinde bile Dream tek karar token’ı üretemedi.
Qwen ise aynı koşulda 12/12 stabil kaldı.
```

---

## Phase O’dan Çıkan Ürün Kararı

Phase O sonrası kısa vadeli ürün stratejisi şudur:

```text
Default live model worker:
Qwen2.5-Coder 7B

Verifier/safety:
deterministic verifier + policy engine

Remask:
verifier-triggered, lokal ve kontrollü

Dream:
research-only baseline;
ilk ürün dependency’si değil
```

Bu nedenle kısa vadeli mimari:

```text
Qwen-backed planner/coder
  + deterministic verifier
  + bounded workspace
  + verifier-triggered remask
  + workspace mutation validation
```

dLLM/dLLM-style modeller tamamen bırakılmamıştır. Fakat ilk ürün akışında ana bağımlılık değildir. İleride şu roller için tekrar araştırılabilir:

* masked local repair,
* remask planner,
* failed-region refinement,
* verifier signal augmentation.

---

## Şimdiye Kadarki Sapma ve Güncel Konumlandırma

MVP-5 ile MVP-10 arasında ürün, pratik doğrulama ihtiyacı nedeniyle PR reviewer yönüne kaydı. Bu tamamen yanlış değildi; çünkü güvenilir bir agent orchestration runtime için verifier ve policy engine gerekir.

Fakat bundan sonra şu ayrım net tutulmalıdır:

| Katman                       | Konum                                       |
| ---------------------------- | ------------------------------------------- |
| PR reviewer / GitHub Action  | İlk entegrasyon yüzeyi                      |
| Policy engine                | Boundary ve authority kontrol katmanı       |
| Verifier                     | Güvenlik/doğrulama sinir sistemi            |
| Mixed validation             | Ürünün ölçüm laboratuvarı                   |
| Shared workspace             | Ana ürün omurgası                           |
| Bounded working memory       | Agent context ekonomisi                     |
| Agent orchestrator           | Ürünün merkezi runtime katmanı              |
| Live model-worker benchmark  | Gerçek model davranışını ölçen deney yüzeyi |
| Workspace mutation validator | Model-backed flow güvenlik kapısı           |

Yani mevcut PR review çalışmaları korunacak, fakat ürünün merkezi PR review değil, workspace tabanlı agent orchestration olacak.

---

## Hedef Ürün Modülleri

### 1. Workspace Builder

Görevi:

* task’ı okumak,
* repo facts çıkarmak,
* policy’yi bağlamak,
* diff veya patch intent’i workspace’e yerleştirmek,
* initial semantic workspace üretmek.

İleride Workspace Builder şunları da yapmalıdır:

* repo graph çıkarmak,
* package/test/config dosyalarını ayırmak,
* likely ownership tahmini yapmak,
* paired file ilişkilerini önermek,
* generated output ve build artifact tahmini yapmak.

---

### 2. Shared Semantic Workspace

Ürünün ortak state katmanıdır.

İçermesi gereken temel alanlar:

* task,
* scope,
* authority,
* policy,
* repo facts,
* role claims,
* patch plan,
* patch draft,
* verifier result,
* test result,
* remask request,
* merge decision,
* final result,
* trace.

Bu workspace, agent’ların birbirine mesaj attığı bir chat transcript değildir. Agent’ların üzerinde çalıştığı yapılandırılmış ortak gerçekliktir.

---

### 3. Bounded Working Memory

Her agent’a role-specific ve task-bound context sağlar.

Örnek role view’lar:

Planner view:

* task intent,
* business goal,
* constraints,
* risk notes,
* allowed/forbidden scope özeti.

Coder view:

* patch contract,
* ilgili dosya parçaları,
* allowed edit regions,
* forbidden edit regions,
* gerekli test sinyalleri.

Verifier view:

* proposed patch,
* policy,
* ownership,
* module boundary,
* sensitive boundary,
* missing authority rules.

Remask view:

* verifier failure,
* failed region,
* allowed repair files,
* minimal repair instruction,
* previous patch summary.

---

### 4. Context Composer

Agent’a verilecek context’i seçen katmandır.

Hedef:

```text
Minimum yeterli context.
```

Ölçmesi gerekenler:

* context token estimate,
* role view size,
* included facts,
* excluded facts,
* budget utilization,
* context sufficiency risk.

Bu katman ürünün maliyet avantajı için kritiktir. Çünkü ürünün ana vaadi yalnızca scope güvenliği değil, aynı zamanda daha düşük context/token maliyetiyle daha kontrollü agent akışı kurmaktır.

---

### 5. Agent Orchestrator

Agent rollerini sıraya koyan ve workspace üstündeki yazma/okuma haklarını yöneten katmandır.

İlk hedef flow:

```text
plan
  -> implement
  -> verify
  -> test-signal
  -> remask-if-needed
  -> merge
  -> final trace
```

İleride desteklenmesi gereken flow’lar:

* verifier-only,
* coder + verifier,
* coder + verifier + remask,
* planner + coder + verifier,
* parallel bounded agents,
* conflict-aware merge,
* model-backed workspace mutation flow.

---

### 6. Model Worker Adapter

Phase P ile aktif hale gelecek yeni modül budur.

Görevi:

* OpenAI-compatible worker endpoint’e istek atmak,
* role-specific prompt/context göndermek,
* model output’unu almak,
* latency/token/error bilgisini trace’e eklemek,
* raw model output’u doğrudan workspace’e yazmamak,
* output’u mutation validator’a göndermek.

İlk desteklenecek model:

```text
Qwen2.5-Coder 7B
```

Dream-Coder bu fazda default worker değildir.

---

### 7. Workspace Mutation Validator

Model-backed orchestration için güvenlik kapısıdır.

Model response şu formatta normalize edilmelidir:

```ts
type ModelRole = "planner" | "coder" | "verifier" | "remask";

type WorkspaceMutation = {
  role: ModelRole;
  target: "plan" | "patchDraft" | "verifierFinding" | "remaskRequest" | "repairDraft";
  summary: string;
  claims: unknown[];
  touchedFiles: string[];
  confidence?: number;
};
```

Validation kuralları:

* invalid JSON bloklanır,
* eksik required field bloklanır,
* role dışı write target bloklanır,
* allowed scope dışı touched file bloklanır,
* forbidden file varsa mutation bloklanır,
* unsafe content varsa safety finding üretilir,
* timeout/model error trace’e güvenli failure olarak yazılır.

Prensip:

```text
Model output geçersizse runtime çökmez.
Workspace’e güvenli failed mutation attempt olarak yazılır.
```

---

### 8. Conflict-Aware Merge

Birden fazla agent workspace’e claim veya patch proposal yazdığında merge katmanı şunları kontrol etmelidir:

* aynı field’a çelişkili claim var mı?
* aynı dosya bölgesine farklı agent müdahalesi var mı?
* verifier claim’i coder claim’iyle çelişiyor mu?
* stale fact kullanılmış mı?
* patch authority dışına taşmış mı?
* repair sadece failed region ile sınırlı mı?

Bu modül, “aynı workspace üstünde birbirini ezmeden çalışan agent’lar” vizyonunun ürün karşılığıdır.

---

### 9. Verifier ve Policy Engine

Mevcut verifier/policy engine korunacak ama yeni mimaride konumu netleşecek.

Verifier’ın görevi:

* agent’ın scope dışına çıkıp çıkmadığını kontrol etmek,
* authority eksikse durdurmak,
* sensitive risk varsa reject etmek,
* lokal eksik varsa remask request üretmek,
* human review gereken alanları işaretlemek.

Bu modül ürünün tamamı değil, agent orchestration runtime’ın kontrol katmanıdır.

---

### 10. Remask Engine

Remask Engine’in görevi patch’i baştan üretmek değildir.

Görevi:

* verifier’ın işaretlediği failed region’ı almak,
* yalnızca allowed repair region üretmek,
* ilgili agent’a dar repair context vermek,
* repair sonucunu workspace’e merge etmek.

Başarı metrikleri:

* remask success rate,
* no broadening rate,
* invalid contract rate,
* extra file touch rate,
* cost delta.

Phase P’nin ilk MVP’sinde remask model-backed olmak zorunda değildir. Önce deterministic remask simulation korunacak; model-backed remask daha sonra açılacaktır.

---

### 11. Cost ve Token Controller

Ürün vizyonunun önemli iddialarından biri daha düşük context maliyetidir. Bu nedenle runtime her agent çağrısı için şunları ölçmelidir:

* estimated input tokens,
* estimated output tokens,
* role view token budget,
* budget utilization,
* remask extra cost,
* total flow cost,
* direct baseline ile karşılaştırma,
* model-backed flow latency,
* model-backed flow token usage.

Bu olmadan “dar context daha ucuz ve kontrollü” iddiası ölçülemez.

---

### 12. Benchmark ve Eval Layer

Bu katman zaten başladı; fakat artık agent orchestration hedefiyle yeniden konumlanmalıdır.

Karşılaştırılacak akışlar:

| Flow                          | Anlam                                                      |
| ----------------------------- | ---------------------------------------------------------- |
| Direct agent                  | Tek model, tek pass, geniş veya düz context                |
| Bounded workspace agent       | Agent role-specific bounded view ile çalışır               |
| Workspace + verifier          | Patch workspace’e yazılır, verifier kontrol eder           |
| Workspace + verifier + remask | Failed region lokal repair edilir                          |
| Multi-agent workspace         | Birden fazla role workspace üstünde çalışır                |
| Parallel bounded agents       | Agent’lar ayrı bounded view ile eş zamanlı çalışır         |
| Model-backed orchestrator     | Gerçek model worker output’u workspace mutation’a çevrilir |

Ölçülecek metrikler:

* task success,
* patch pass,
* scope drift,
* boundary guess,
* refusal accuracy,
* missed blocker,
* false blocker,
* expected finding coverage,
* trace completeness,
* context token budget,
* cost estimate,
* remask success,
* conflict rate,
* merge safety,
* JSON compliance,
* latency,
* token usage,
* strictness behavior,
* mutation validation pass rate,
* blocked unsafe mutation count.

---

## Hedef Kullanıcılar

Birincil hedef bireysel developer değildir. İlk hedef:

```text
AI coding kullanan ama scope drift, ownership, compliance, PR review yükü ve
kurumsal modül sınırlarından endişe eden engineering/platform ekipleri.
```

Personalar:

| Persona               | İhtiyaç                                                            |
| --------------------- | ------------------------------------------------------------------ |
| Developer             | Agent’ın neden durduğunu, neyi onarması gerektiğini hızlıca görür. |
| Tech Lead             | Module boundary, ownership ve eksik test risklerini görür.         |
| Engineering Manager   | AI coding kullanımının kalite/risk etkisini ölçer.                 |
| Platform / DevEx Team | Kurum içi agent workflow standardı kurar.                          |
| Security / Compliance | Sensitive boundary ve forbidden scope kontrollerini izler.         |
| Agent Tool Builder    | Kendi coding agent’ına workspace/verifier/remask runtime bağlar.   |

---

## Ürün Yüzeyleri

Çekirdek ürün bağımsız runtime olmalıdır. Farklı yüzeyler bu runtime’a bağlanır.

| Yüzey          | Konum                                                           |
| -------------- | --------------------------------------------------------------- |
| CLI            | Araştırma, lokal debug, CI entegrasyonu                         |
| GitHub Action  | İlk pratik entegrasyon ve PR artifact yüzeyi                    |
| GitHub App     | Daha iyi PR yorumları ve repo/team entegrasyonu                 |
| Dashboard      | Team-level risk, cost, remask ve agent flow metrikleri          |
| Policy Console | Ownership, allowed paths, paired files ve risk policy yönetimi  |
| SDK/API        | Cursor/Codex/Windsurf veya kurum içi agentlara runtime bağlamak |
| IDE Adapter    | Uzun vadeli developer-facing canlı feedback                     |

Öncelik:

```text
Core Runtime -> CLI -> GitHub Action -> SDK/API -> Dashboard -> IDE Adapter
```

---

## Araştırma Bulgularının Ürün Yoluna Etkisi

Araştırmada görülen önemli ayrım şudur:

* autoregressive coder modeller implementation tarafında güçlü olabilir,
* verifier/boundary/refusal tarafında yine hata yapabilir,
* deterministic verifier/policy engine ürünün güvenlik omurgası olmalıdır,
* dLLM direct patch/verifier contract’ında zayıf kalabilir,
* dLLM-style infill/refinement fikri yine de masked repair rollerinde değerli olabilir,
* workspace/verifier/remask flow boundary guess’i azaltabilir,
* remask yalnızca doğru case’lerde açılırsa kalite belirleyici faktör olabilir,
* gereksiz remask maliyet yaratır.

Phase O sonrası güncel ürün yorumu:

```text
Qwen2.5-Coder 7B, live benchmarklarda hızlı, format uyumlu ve stabil davranmıştır.
Dream-Coder v0 Instruct 7B, mevcut wrapper/prompt rejiminde hem JSON contract hem decision-token görevinde zayıf kalmıştır.
Bu nedenle ilk model-backed orchestrator flow Qwen default worker ile kurulmalıdır.
Verifier/safety kararı ise deterministic policy/verifier katmanından geçmelidir.
```

Bu nedenle ürünün kısa vadeli stratejisi:

```text
Qwen-backed planner/coder
  + deterministic verifier
  + bounded workspace
  + verifier-triggered remask
  + workspace mutation validation.
```

dLLM ilk sürüm için zorunlu dependency olmamalıdır. dLLM/dLLM-style modeller ileri fazda verifier augmentation, remask planner veya masked repair adapter olarak araştırılmalıdır.

---

# Yakın Dönem Yol Haritası — Güncel Durum

Bu roadmap ilk yazıldığında ürünün merkezi hedefi shared semantic workspace tabanlı bounded agent orchestration runtime olarak belirlenmişti. O noktadan sonra çekirdek runtime ve live benchmark tarafında önemli ilerleme kaydedildi.

Artık proje yalnızca policy/verifier veya PR review katmanından ibaret değildir. Aşağıdaki runtime zinciri tek komutla doğrulanabilir hale gelmiştir:

```text
changed files
  -> scoped repo intelligence
  -> shared semantic workspace
  -> bounded role context
  -> orchestrator flow
  -> conflict-aware merge
  -> remask repair loop
  -> second-pass approval
  -> safety blocking
```

Bu zincir şu komutla doğrulanır:

```bash
npm run runtime:verify
```

---

## Tamamlanan Çekirdek Fazlar

| Faz                                     | Durum      | Not                                                                                                                             |
| --------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Faz A: Vizyon Düzeltme                  | Tamamlandı | Ürün PR reviewer değil, bounded-context shared-workspace orchestration runtime olarak konumlandı.                               |
| Faz B: Shared Workspace Core v1         | Tamamlandı | Canonical `SharedSemanticWorkspace` runtime state modeli kuruldu.                                                               |
| Faz C: Bounded Working Memory v1        | Tamamlandı | Role-specific bounded view üretimi eklendi.                                                                                     |
| Faz D: Context Composer v1              | Tamamlandı | Token estimate, included/excluded facts, sufficiency ve budget utilization raporlanıyor.                                        |
| Faz E: Agent Orchestrator v1            | Tamamlandı | Planner, coder, verifier, remask, merge adımlarından oluşan mock orchestration flow çalışıyor.                                  |
| Faz F: Conflict-Aware Merge v1          | Tamamlandı | Conflict, stale authority, remask unresolved ve unsafe merge sinyalleri yakalanıyor.                                            |
| Faz G: Cost/Token Benchmark v1          | Tamamlandı | Bounded context ile full workspace baseline kıyaslanabiliyor.                                                                   |
| Faz H: Repo Intelligence v1             | Tamamlandı | Repo scan, ownership, module boundary, sensitive/stale fact çıkarımı var.                                                       |
| Faz H.2-H.6: Runtime Verification Suite | Tamamlandı | Changed-files scoped repo intelligence, repo-aware orchestrator, remask repair, safety layer ve runtime verify zinciri eklendi. |
| Faz L: dLLM-Style Verifier Core         | Tamamlandı | dLLM-style verifier kararları, signals ve approve/remask/reject mantığı eklendi.                                                |
| Faz M: Live Model Worker Integration    | Tamamlandı | RunPod proxy, Qwen endpoint, Dream endpoint ve Qwen + Dream live acceptance çalıştı.                                            |
| Faz N: Live Benchmark Reproducibility   | Tamamlandı | 12-case runner, `.env.example`, runbook, results ve final report eklendi.                                                       |
| Faz O: Evidence Strengthening           | Tamamlandı | Qwen/Dream 12-case, strict contract, compact payload ve decision-token diagnostic benchmarkları tamamlandı.                     |

---

## Güncel Runtime Verification

Şu an runtime doğrulama paketi aşağıdaki scriptleri kapsar:

```text
repo:changed-files-smoke
repo:changed-context-report
repo:orchestrator-smoke
repo:orchestrator-report
remask:repair-smoke
remask:repair-report
remask:repair-safety-smoke
remask:repair-safety-report
```

Bu suite şu iddiayı doğrular:

```text
Repairable conflict varsa sistem lokal repair ile approve’a gidebilir.
Unrepairable/safety conflict varsa sistem merge’i açmaz.
```

Model-free doğrulama CI/local ortamda çalışmalıdır. Live model doğrulamaları ise endpoint varsa çalışır; endpoint yoksa default olarak skipped report üretmelidir.

---

## Güncel Ürün Çekirdeği

Şu an savunulabilir teknik çekirdek şudur:

```text
PR changed files
  -> scoped repo intelligence
  -> shared semantic workspace
  -> bounded role context
  -> orchestrator
  -> verifier/remask decision
  -> conflict-aware merge
  -> deterministic repair loop
  -> safety gate
  -> JSON/Markdown artifact
```

Live model tarafında savunulabilir teknik yüzey şudur:

```text
OpenAI-compatible LLM endpoint
  + OpenAI-compatible dLLM/verifier endpoint
  -> model-worker proxy
  -> live acceptance
  -> live mini benchmark
  -> JSON/Markdown report
```

Phase P’nin amacı bu iki hattı birleştirmektir:

```text
Model output
  -> structured workspace mutation
  -> verifier/remask/merge flow
```

---

# Sıradaki Ana Faz: Phase P

## Phase P: Model-Backed Orchestrator Flow

### Amaç

Şu ana kadar ayrı çalışan live model worker hattını shared workspace orchestrator flow’a bağlamak.

Bugünkü durumda iki akış var:

```text
Deterministic workspace/orchestrator runtime
Live model-worker acceptance/benchmark
```

Phase P’nin amacı bu iki hattı birleştirmektir:

```text
Model output
  -> structured workspace mutation
  -> verifier/remask/merge flow
```

İlk model-backed flow için default worker:

```text
Qwen2.5-Coder 7B
```

Dream-Coder bu fazda default worker değildir. Research-only baseline olarak tutulur.

---

## Phase P Başarı Kriteri

Phase P bitti diyebilmek için şu komut olmalıdır:

```bash
npm run worker:orchestrator-smoke
```

Ve çıktı şu tipte olmalıdır:

```json
{
  "ok": true,
  "suiteName": "phase-p-worker-backed-orchestrator",
  "modelId": "qwen2.5-coder-7b",
  "finalDecision": "approve",
  "mutationValidationPassed": true,
  "verifierPassed": true,
  "mergeDecision": "approved",
  "jsonPath": "...",
  "markdownPath": "..."
}
```

---

## Phase P Teknik Zincir

Beklenen ilk zincir:

```text
changed files
  -> scoped repo intelligence
  -> shared semantic workspace
  -> planner bounded view
  -> Qwen planner worker response
  -> planner workspace mutation
  -> mutation validation
  -> coder bounded view
  -> Qwen coder worker response
  -> patchDraft workspace mutation
  -> mutation validation
  -> deterministic verifier
  -> conflict-aware merge
  -> final decision
  -> JSON/Markdown trace
```

İlk MVP’de model-backed remask zorunlu değildir. Remask başlangıçta deterministic simulation olarak kalabilir.

---

## Phase P Issue Sırası

### P.0 — Roadmap ve Phase O Status Update

Amaç:

```text
Phase O’nun tamamlandığını dokümana işlemek
ve Phase P’yi aktif faz olarak netleştirmek.
```

Yapılacaklar:

* Phase O’yu completed olarak işaretle.
* O.5/O.7/O.8/O.9 sonuçlarını kısa tabloyla ekle.
* Qwen default worker kararını yaz.
* Dream’i research-only baseline olarak konumlandır.
* “Dream bazı verifier-style case’lerde temkinli olabilir” eski ifadesini Phase O sonuçlarına göre güncelle.
* Phase P’nin ilk hedefini `model output -> workspace mutation -> verifier/remask/merge` olarak netleştir.

Başarı kriteri:

```text
Roadmap dokümanı güncel gerçekliği doğru yansıtacak.
```

Commit önerisi:

```text
docs: update roadmap for phase p
```

---

### P.1 — Workspace Mutation Contract for Model Roles

Amaç:

```text
Model cevabını doğrudan runtime kararı yapmak yerine,
structured workspace mutation contract’ına çevirmek.
```

Önerilen contract:

```ts
export type ModelRole = "planner" | "coder" | "verifier" | "remask";

export type WorkspaceMutationTarget =
  | "plan"
  | "patchDraft"
  | "verifierFinding"
  | "remaskRequest"
  | "repairDraft";

export type WorkspaceMutation = {
  role: ModelRole;
  target: WorkspaceMutationTarget;
  summary: string;
  claims: unknown[];
  touchedFiles: string[];
  confidence?: number;
};
```

Role write boundary:

| Role     | Allowed target                 |
| -------- | ------------------------------ |
| planner  | plan                           |
| coder    | patchDraft                     |
| verifier | verifierFinding, remaskRequest |
| remask   | repairDraft                    |

Başarı kriteri:

```text
WorkspaceMutation type ve role write boundary kuralları test edilebilir hale gelecek.
```

Komut hedefi:

```bash
npm run test:workspace-mutation-contract
```

Commit önerisi:

```text
feat: add workspace mutation contract
```

---

### P.2 — Model Output Mutation Validator

Amaç:

```text
Model output’unu workspace’e yazmadan önce güvenli şekilde doğrulamak.
```

Validation durumları:

| Durum                           | Beklenen davranış             |
| ------------------------------- | ----------------------------- |
| Invalid JSON                    | blocked mutation              |
| Missing required field          | invalid mutation              |
| Role dışı target                | blocked mutation              |
| touchedFiles allowed scope dışı | scope violation               |
| forbidden file touch            | blocked mutation              |
| timeout/model error             | failed model mutation attempt |
| unsafe content                  | safety finding                |

Başarı kriteri:

```text
Bozuk veya unsafe model output’u runtime’ı kırmadan güvenli şekilde bloklanacak.
```

Komut hedefi:

```bash
npm run test:model-mutation-validator
```

Commit önerisi:

```text
feat: validate model workspace mutations
```

---

### P.3 — Worker-Backed Planner Smoke

Amaç:

```text
Qwen model worker ile ilk role-specific planner mutation üretmek.
```

Akış:

```text
fixture task
  -> workspace builder
  -> bounded planner view
  -> Qwen planner call
  -> WorkspaceMutation(plan)
  -> mutation validation
  -> workspace trace
```

Planner patch yazmaz; yalnızca plan claim üretir. Bu yüzden ilk model-backed role olarak en güvenli başlangıç noktasıdır.

Başarı kriteri:

```text
Qwen planner, en az 1 fixture üzerinde valid plan mutation üretecek.
```

Komut hedefi:

```bash
npm run worker:planner-smoke
```

Commit önerisi:

```text
feat: add worker-backed planner smoke
```

---

### P.4 — Worker-Backed Coder Smoke

Amaç:

```text
Qwen model worker ile bounded coder view üzerinden patchDraft mutation üretmek.
```

Akış:

```text
workspace + planner claim
  -> bounded coder view
  -> Qwen coder call
  -> WorkspaceMutation(patchDraft)
  -> mutation validation
  -> deterministic verifier
```

Coder doğrudan repo dosyasını değiştirmez. Önce workspace’e patchDraft claim yazar.

Başarı kriteri:

```text
Qwen coder patchDraft mutation üretir,
mutation validator bunu doğrular,
deterministic verifier patchDraft üzerinde karar üretir.
```

Komut hedefi:

```bash
npm run worker:coder-smoke
```

Commit önerisi:

```text
feat: add worker-backed coder smoke
```

---

### P.5 — Worker-Backed Orchestrator Smoke

Amaç:

```text
Planner + coder model-backed,
verifier + merge deterministic olacak şekilde ilk uçtan uca flow’u çalıştırmak.
```

İlk MVP flow:

```text
changed files
  -> repo intelligence
  -> shared workspace
  -> planner view
  -> Qwen planner mutation
  -> coder view
  -> Qwen coder mutation
  -> deterministic verifier
  -> conflict-aware merge
  -> final decision
```

Başarı kriteri:

```text
En az 1 fixture üzerinde gerçek Qwen worker kullanılarak final merge decision üretilecek.
```

Komut hedefi:

```bash
npm run worker:orchestrator-smoke
```

Commit önerisi:

```text
feat: add worker-backed orchestrator smoke
```

---

### P.6 — Mock Flow vs Worker-Backed Flow Comparison

Amaç:

```text
Aynı fixture üzerinde deterministic/mock flow ile Qwen worker-backed flow’u karşılaştırmak.
```

Karşılaştırılacak metrikler:

* final decision aynı mı?
* touchedFiles allowed scope içinde mi?
* verifier finding aynı mı?
* mutation validation pass/fail nedir?
* token usage nedir?
* latency nedir?
* trace complete mi?
* model-backed flow ek risk üretiyor mu?

Komut hedefi:

```bash
npm run report:worker-orchestrator-comparison
```

Başarı kriteri:

```text
Mock ve worker-backed flow aynı fixture üzerinde karşılaştırmalı JSON/Markdown report üretir.
```

Commit önerisi:

```text
feat: compare worker-backed orchestrator flow
```

---

### P.7 — Phase P Initial Results Documentation

Amaç:

```text
Phase P’nin ilk model-backed orchestrator sonucunu dokümante etmek.
```

Yazılacaklar:

* hangi fixture kullanıldı,
* hangi model kullanıldı,
* planner mutation valid miydi,
* coder mutation valid miydi,
* verifier ne dedi,
* merge decision ne oldu,
* token/latency neydi,
* mock flow ile fark neydi,
* hangi sınırlılıklar var.

Başarı kriteri:

```text
Phase P ilk sonuçları docs/results altında JSON/Markdown artifact özetiyle yer alır.
```

Commit önerisi:

```text
docs: add phase p initial results
```

---

## Phase Q: Real Repo / PR Evaluation

### Amaç

Fixture dışına çıkıp gerçek repo diff senaryolarında bounded runtime davranışını ölçmek.

### Yapılacaklar

* Git diff adapter.
* PR changed files adapter.
* Real repo positive/negative control set.
* Bounded workspace flow vs direct model baseline.
* Scope drift, missed blocker, false blocker ve token/cost kıyası.
* Daha geniş product-runtime validation seti.
* Real repo diff’lerinde required test mapping, ownership ve module boundary coverage ölçümü.
* Model-backed flow ile deterministic verifier flow’un davranış farklarını raporlama.

### Başarı Kriteri

```text
Gerçek diff üzerinde bounded runtime,
direct geniş-context baseline’a göre daha kontrollü ve ölçülebilir sonuç üretecek.
```

---

## Phase R: Developer Experience / SDK / Public Pilot

### Amaç

Araştırma prototipini dışarıdan kurulabilir ve denenebilir hale getirmek.

### Yapılacaklar

* CLI komutlarını sadeleştir.
* Starter config üret.
* Policy bootstrap komutu.
* GitHub Action artifact-only mode dokümantasyonu.
* SDK/API contract draft.
* Consumer smoke kit.
* Public pilot checklist.
* README quickstart akışını daha kısa ve dış kullanıcı odaklı hale getir.
* “Local deterministic mode” ve “Live model mode” ayrımını netleştir.

### Başarı Kriteri

```text
Yeni bir kullanıcı veya ekip repoyu klonlayıp
10-15 dakika içinde artifact-only modda bounded review/benchmark çıktısı alabilecek.
```

---

## Phase S: Dashboard and Team Metrics

### Amaç

Tek PR veya tek benchmark yerine takım seviyesinde risk, kalite ve maliyet trendlerini görünür yapmak.

### Yapılacaklar

* AI patch count.
* Remask required count.
* Remask success count.
* Final merge safe count.
* Blocked safety scenario count.
* Token budget.
* Role view size.
* Scope drift.
* Ownership miss.
* Module boundary finding.
* False blocker.
* Missed blocker.
* Team-level trend report.
* Dashboard veya static report prototype.

### Başarı Kriteri

```text
Team lead veya platform ekibi AI coding runtime’ın
risk, maliyet ve kalite trendini rapor olarak görebilecek.
```

---

## Güncel Teknik Öncelik Sırası

Bundan sonraki teknik öncelik sırası şudur:

1. Phase O status ve roadmap güncellemesini commit et.
2. Workspace mutation contract oluştur.
3. Model output mutation validator ekle.
4. Worker-backed planner smoke oluştur.
5. Worker-backed coder smoke oluştur.
6. Worker-backed orchestrator smoke oluştur.
7. Mock flow vs worker-backed flow comparison raporu üret.
8. Phase P initial results dokümantasyonu ekle.
9. Real repo / PR diff evaluation adapter ekle.
10. Bounded workspace flow vs direct baseline benchmark oluştur.
11. Model-backed remask repair v2 tasarla.
12. dLLM-style verifier/remask role comparison’ı ileri araştırma olarak çalıştır.
13. CLI/SDK/API polish.
14. GitHub Action public pilot polish.
15. Dashboard and team metrics static report prototype.

Bu sırada README veya ürün anlatısı genişletilebilir; fakat kısa vadede ana öncelik dokümantasyon polish değildir:

```text
model-backed workspace orchestration
+
workspace mutation validation
+
real repo/diff evaluation
```

olmalıdır.

---

## Güncel Kısa Özet

Proje şu aşamaya gelmiştir:

```text
Deterministic bounded runtime çekirdeği ve live model-worker benchmark yüzeyi doğrulandı.
Phase O ile Qwen/Dream evidence üretildi.
Qwen ana live worker adayı olarak öne çıktı.
Dream mevcut haliyle güvenilir verifier/decision worker olarak kullanılamadı.
Şimdi hedef, gerçek model worker çıktısını shared workspace orchestrator flow’a güvenli mutation olarak bağlamaktır.
```

Kısa vadede odak:

```text
Dokümantasyon polish değil,
model-backed workspace orchestration + mutation validation + real repo evaluation.
```

---

## Başarıyı Nasıl Ölçeceğiz?

Ürün hedefinin doğru ilerleyip ilerlemediğini şu sorularla ölçeceğiz.

### Context ve Maliyet

* Agent başına context token budget düşüyor mu?
* Role-specific view gereksiz bilgiyi dışarıda bırakabiliyor mu?
* Remask sadece gerekli durumda açılıyor mu?
* Direct large-context flow’a göre maliyet avantajı var mı?
* Model-backed flow’da input/output token kullanımı raporlanıyor mu?

### Güvenilirlik

* Scope drift azalıyor mu?
* Boundary guess azalıyor mu?
* Missed blocker azalıyor mu?
* False blocker kabul edilebilir seviyede mi?
* Sensitive boundary ihlalleri yakalanıyor mu?
* Unsafe workspace mutation engelleniyor mu?

### Orkestrasyon Kalitesi

* Agent’lar aynı workspace üstünde birbirini ezmeden çalışabiliyor mu?
* Çelişkili claim’ler yakalanıyor mu?
* Verifier feedback workspace’e doğru yazılıyor mu?
* Remask lokal failed region ile sınırlı kalıyor mu?
* Model output’u role write boundary dışına taşarsa yakalanıyor mu?

### Live Model Kalitesi

* Expected-vs-actual match rate nedir?
* JSON compliance oranı nedir?
* Latency modeli kullanılabilir kılıyor mu?
* Token maliyeti bounded flow’da kontrol altında mı?
* Safe/review/reject case ailelerinde karar dağılımı tutarlı mı?
* Repeated runs arasında varyans kabul edilebilir mi?
* Model output mutation validation pass rate nedir?

### Ürün Kullanılabilirliği

* Bir ekip repo policy’sini kolayca başlatabiliyor mu?
* Raporlar actionable mı?
* PR/CI entegrasyonu düşük sürtünmeli mi?
* Runtime modelden bağımsız kullanılabiliyor mu?
* Live endpoint yokken local development kırılmadan devam edebiliyor mu?

---

## Savunulabilir Ürün Tezi

Şu an savunulabilir ürün tezi şudur:

```text
Agentic coding’de kalite problemi yalnızca model seçimi problemi değildir.
Asıl problem, agent’ın hangi bağlamı gördüğü, hangi yetkiye sahip olduğu,
hangi ortak workspace’e yazdığı, ne zaman durduğu ve nasıl doğrulandığıdır.

Bounded Agent Orchestration Runtime, agent’lara sınırsız context veya kalıcı
hafıza vermek yerine, shared semantic workspace ve role-specific bounded
working memory üzerinden daha kontrollü, daha ölçülebilir ve daha düşük
maliyetli agent akışları kurmayı hedefler.
```

Bu tez iddialı ama ölçülebilir kalmalıdır. Şimdilik “her kurumda kesin çalışır” denmemelidir.

Doğru iddia:

```text
İlk validation katmanında, verifier/policy runtime’ın pozitif ve negatif
PR-shaped fixture’larda ölçülebilir şekilde çalıştığı gösterildi.
Phase M/N ile canlı model-worker acceptance ve live benchmark yüzeyi eklendi.
Phase O ile Qwen/Dream karşılaştırmalı evidence üretildi.
Bundan sonraki hedef, bu doğrulama katmanını model-backed shared-workspace
agent orchestration runtime’a bağlamak ve daha geniş gerçek repo/diff
senaryolarında test etmektir.
```

Yanlış iddia:

```text
dLLM daha güvenlidir.
Dream Qwen’den üstündür.
Bu sistem tüm agentic coding risklerini çözer.
Qwen her görevde kesin en iyi modeldir.
```

Güvenli araştırma yorumu:

```text
Bu çalışmada Qwen2.5-Coder 7B, bounded verifier-style benchmarklarda ve decision-token diagnostic modunda stabil ve format uyumlu davranmıştır.
Dream-Coder v0 Instruct 7B ise mevcut wrapper/prompt rejiminde JSON contract ve decision-token modlarında güvenilir sonuç üretmemiştir.
Bu bulgu, ilk ürün akışında Qwen-backed planner/coder + deterministic verifier stratejisini desteklemektedir.
```

---

## Kısa Özet

Proje bundan sonra şu cümleye sadık kalmalıdır:

```text
Bu ürün bir PR reviewer değildir.
Bu ürün, PR reviewer yüzeyi de olan bounded-context shared-workspace agent
orchestration runtime’dır.
```

En önemli teknik hedef:

```text
Agent’lara tüm hafızayı ve tüm repo context’ini vermeden,
role-specific bounded working memory ile ortak semantic workspace üstünde
daha güvenli, daha ucuz ve daha izlenebilir agentic coding akışları kurmak.
```

Phase O sonrası en yakın hedef:

```text
Model-backed orchestrator flow kurmak,
model output’unu güvenli workspace mutation’a çevirmek,
deterministic verifier/remask/merge flow ile birleştirmek,
sonra gerçek repo/diff değerlendirmesine geçmek.
```

---

## Sonraki Çalışma İçin Önerilen Issue Sırası

Bundan sonraki issue’lar şu sırayla açılmalıdır:

1. Roadmap’i Phase O completed + Phase P active olarak güncelle.
2. Workspace mutation contract oluştur.
3. Model output mutation validator ekle.
4. Worker-backed planner smoke komutu ekle.
5. Worker-backed coder smoke komutu ekle.
6. Worker-backed orchestrator smoke komutu ekle.
7. Mock flow vs worker-backed flow comparison raporu oluştur.
8. Phase P initial results dokümantasyonunu ekle.
9. Real repo / PR diff evaluation adapter ekle.
10. Bounded workspace flow vs direct baseline benchmark oluştur.
11. Real remask repair v2 contract tasarla.
12. dLLM-style verifier/remask role comparison’ı ileri araştırma olarak çalıştır.
13. CLI quickstart ve consumer smoke kit’i sadeleştir.
14. GitHub Action public pilot polish yap.
15. Dashboard/team metrics static report prototype oluştur.

---

## Final Durum

Bugünkü final durum:

```text
Phase N tamamlandı.
Phase O tamamlandı.
Runtime çekirdeği doğrulandı.
Live model-worker benchmark yüzeyi kuruldu.
Qwen + Dream live acceptance çalıştı.
12-case benchmark runner kullanıldı.
Qwen ana live worker adayı olarak belirlendi.
Dream mevcut haliyle güvenilir verifier/decision worker olarak elendi.
Sıradaki hedef model-backed orchestration.
```

Phase P’nin tek cümlelik hedefi:

```text
Gerçek model worker çıktısını shared semantic workspace’e güvenli, doğrulanmış
workspace mutation olarak bağlamak.
```
