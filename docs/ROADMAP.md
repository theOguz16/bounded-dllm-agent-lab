# Ürün Yol Haritası: Bounded Agent Orchestration Runtime

Bu doküman, projenin bundan sonraki ana yönünü sabitlemek için yazıldı.
Önceki MVP'lerde özellikle PR review, policy engine ve verifier tarafı güçlendi.
Bu çalışmalar değerlidir; fakat ürünün ana fikri yalnızca bir PR güvenlik
eklentisi veya boundary checker değildir.

Asıl ürün vizyonu şudur:

```text
Kurumsal yazılım ekipleri için shared semantic workspace tabanlı,
dar contextli, scope-safe agent orchestration runtime.
```

Başka bir ifadeyle:

```text
Model orkestrasyonu değil; context, authority, workspace, bounded working
memory ve agent flow orkestrasyonu.
```

Bu ürünün amacı Cursor, Codex, Windsurf gibi araçların sadece üstüne güvenlik
eklentisi koymak değildir. Daha temel amaç, agentic coding akışında agent'ların
ne görebileceğini, neyi değiştirebileceğini, hangi ortak state üzerinden
çalışacağını, ne zaman duracağını, ne zaman verifier'a gideceğini ve ne zaman
lokal remask repair yapılabileceğini yöneten bağımsız bir runtime kurmaktır.

## Neden Bu Düzeltme Önemli?

Proje içinde şimdiye kadar yapılan product runtime işleri çoğunlukla şu parçayı
güçlendirdi:

```text
Policy Engine + Boundary Verifier + PR/Diff Validation + CI Gate
```

Bu katman gerekliydi çünkü güvenilir bir agent orchestration runtime için önce
şunları ölçebilmek gerekir:

- scope drift oluyor mu?
- forbidden path'e dokunuyor mu?
- eksik owner/authority var mı?
- paired file eksik mi?
- test sinyali eksik mi?
- sensitive boundary riski var mı?
- iyi PR'ları yanlış engelliyor mu?
- kötü/riskli PR benzeri diff'leri kaçırıyor mu?

Fakat bu katman ürünün tamamı değildir. Bu katman, ileride kurulacak agent
orkestrasyon runtime'ının doğrulama ve güvenlik sinir sistemidir.

Ürünün merkezi bundan sonra şu olmalıdır:

```text
Shared Semantic Workspace
Bounded Working Memory
Role-Specific Context Composer
Agent Orchestrator
Conflict-Aware Merge
Verifier/Remask Feedback Loop
Cost/Token Controller
```

## Ürün Felsefesi

Bu ürünün felsefesi birkaç temel iddia üstüne kuruludur.

### 1. Daha Büyük Context Değil, Daha Doğru Context

Agent'a tüm repo, tüm chat history veya çok uzun bir prompt vermek her zaman
daha iyi sonuç üretmez. Büyük context:

- maliyeti artırır,
- latency'yi artırır,
- gereksiz bilgiyle karar sinyalini seyreltir,
- scope drift riskini artırır,
- agent'ın kendi yetki alanını unutmasına neden olabilir.

Bu nedenle ürünün temel hedefi şudur:

```text
Her agent'a maksimum context değil, görevini yapmasına yetecek minimum doğru
context ver.
```

### 2. Ortak Hafıza Değil, Ortak Workspace

Ürün kalıcı, sınırsız, agent'ların rastgele yazdığı bir memory sistemi
olmamalıdır. Bunun yerine:

```text
Shared semantic workspace = görev süresince yaşayan, yapılandırılmış ortak state.
```

Bu workspace bir sohbet geçmişi değildir. İçinde şunlar bulunur:

- task intent,
- allowed scope,
- forbidden scope,
- repo facts,
- ownership,
- policy,
- karar notları,
- patch planı,
- agent claim'leri,
- verifier findings,
- remask request,
- test sinyalleri,
- final decision,
- trace.

Agent'lar bu workspace'i doğrudan ve sınırsız görmez. Her agent kendi rolüne
özel bounded view alır.

### 3. Hafıza Gibi Görünen Ama Hafıza Olmayan Working Memory

Her agent'a "hafızası varmış gibi" davranan bir context verilir; fakat bu
kalıcı kişisel memory değildir.

Doğru kavram:

```text
Bounded working memory
```

Özellikleri:

- task-bound,
- ephemeral,
- policy-bound,
- role-specific,
- traceable,
- silinebilir,
- yeniden üretilebilir.

Yani agent önceki her şeyi hatırlamak zorunda değildir. Runtime, workspace'teki
gerekli parçaları seçip o agent'a hafıza gibi görünen dar bir view üretir.

### 4. Agent Özgürlüğü Değil, Agent Yetki Yönetimi

Klasik agent yaklaşımı genellikle agent'a daha fazla tool, daha fazla context,
daha fazla özgürlük vermeye çalışır. Bu ürünün yaklaşımı farklıdır:

```text
Agent'ın gücünü artırmadan önce sınırını, yetkisini ve bağlamını yönet.
```

Kurumsal yazılım ekiplerinde bu özellikle önemlidir. Çünkü bir ekip yalnızca
billing modülünden, başka ekip auth modülünden, başka ekip mobile yüzeyden
sorumlu olabilir. Agent'ın bütün projeyi görmesi, bütün projeye dokunabileceği
anlamına gelmemelidir.

### 5. Remask Default Değil, Verifier-Triggered Olmalı

Remask her zaman ikinci pass olarak çalışmamalıdır. Aksi halde maliyet artar ve
gereksiz repair döngüleri oluşur.

Doğru davranış:

```text
Verifier bir failed region tespit ederse, sadece o lokal bölge için remask aç.
```

Bu sayede remask:

- maliyet kontrolü sağlar,
- scope drift'i azaltır,
- tüm patch'i baştan üretmez,
- sadece eksik veya riskli bölgeyi onarır.

## Ürünün Nihai Mimari Hedefi

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
  -> Conflict-Aware Merge
  -> Decision
      approve | refuse | reject | remask_required | human_review_required
  -> Final Patch + Trace + Cost/Token Report
```

Bu akışta agent'lar aynı raw prompt içinde kavga eden karakterler değildir.
Her agent:

- aynı semantic workspace'ten beslenir,
- farklı role-specific view alır,
- sadece belirli alanlara yazabilir,
- claim veya patch önerisini workspace'e yapılandırılmış olarak döker,
- verifier ve merge katmanı tarafından kontrol edilir.

## Ürün Ne Değildir?

Bu ürün şu değildir:

- sadece GitHub Action,
- sadece PR reviewer,
- sadece security checker,
- sadece model router,
- sadece "X model planlasın, Y model kodlasın" sistemi,
- Cursor/Codex/Windsurf yerine birebir IDE,
- tüm kararları LLM'e bırakan otomatik yazılım mühendisi.

PR review ve GitHub Action yüzeyi yalnızca ilk pratik kullanım alanlarından
biridir. Ürünün çekirdeği bundan daha geneldir:

```text
Bounded-context agent orchestration runtime.
```

## Ürün Şu An Ne Yapıyor?

Bugünkü durum, nihai ürünün tamamı değil; fakat sağlam bir temel oluşturuyor.

### Var Olan Çekirdekler

Şu an runtime:

- `task + diff + policy` input alabiliyor,
- shared workspace snapshot üretebiliyor,
- role-specific bounded view üretebiliyor,
- deterministic verifier çalıştırabiliyor,
- `approve`, `refuse`, `reject`, `remask_required`, `human_review_required`
  kararları verebiliyor,
- JSON ve Markdown rapor üretebiliyor,
- GitHub Action artifact ve PR comment yüzeyi üretebiliyor.

### Var Olan Policy Engine Özellikleri

Policy engine şu sinyalleri destekliyor:

- allowed paths,
- forbidden paths,
- ownership rules,
- owner aliases,
- paired files,
- required test mappings,
- module boundaries,
- sensitive patterns,
- changed_when_contains koşulları.

### Var Olan Validation Katmanı

Şu ana kadar kurulan validation altyapısı:

- synthetic product pilot suites,
- NanoID real PR positive set,
- p-limit real PR positive set,
- reviewed label overrides,
- cross-repo external validation,
- mixed positive/negative external validation,
- CI gate.

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

Bu sonuç ürünün son hali anlamına gelmez. Ancak verifier/policy katmanının
ölçülebilir ve regresyon korumalı hale geldiğini gösterir.

## Şimdiye Kadarki Sapma ve Yeni Konumlandırma

MVP-5 ile MVP-10 arasında ürün, pratik doğrulama ihtiyacı nedeniyle PR reviewer
yönüne kaydı. Bu tamamen yanlış değildi; çünkü bir orchestration runtime'ın
güvenilir olması için verifier ve policy engine gerekir.

Fakat bundan sonra şu ayrımı net tutmalıyız:

| Katman | Konum |
| --- | --- |
| PR reviewer / GitHub Action | İlk entegrasyon yüzeyi |
| Policy engine | Boundary ve authority kontrol katmanı |
| Verifier | Güvenlik/doğrulama sinir sistemi |
| Mixed validation | Ürünün ölçüm laboratuvarı |
| Shared workspace | Ana ürün omurgası |
| Bounded working memory | Agent context ekonomisi |
| Agent orchestrator | Ürünün merkezi runtime katmanı |

Yani mevcut çalışmalar korunacak, fakat ürünün merkezi PR review değil,
workspace tabanlı agent orchestration olacak.

## Hedef Ürün Modülleri

### 1. Workspace Builder

Görevi:

- task'ı okumak,
- repo facts çıkarmak,
- policy'yi bağlamak,
- diff veya patch intent'i workspace'e yerleştirmek,
- initial semantic workspace üretmek.

İleride Workspace Builder şunları da yapmalıdır:

- repo graph çıkarmak,
- package/test/config dosyalarını ayırmak,
- likely ownership tahmini yapmak,
- paired file ilişkilerini önermek,
- generated output ve build artifact tahmini yapmak.

### 2. Shared Semantic Workspace

Ürünün ortak state katmanıdır.

İçermesi gereken temel alanlar:

- task,
- scope,
- authority,
- policy,
- repo facts,
- role claims,
- patch plan,
- patch draft,
- verifier result,
- test result,
- remask request,
- merge decision,
- final result,
- trace.

Bu workspace, agent'ların birbirine mesaj attığı bir chat transcript değildir.
Agent'ların üzerinde çalıştığı yapılandırılmış ortak gerçekliktir.

### 3. Bounded Working Memory

Her agent'a role-specific ve task-bound context sağlar.

Örnek:

Planner view:

- task intent,
- business goal,
- constraints,
- risk notes,
- allowed/forbidden scope özeti.

Coder view:

- patch contract,
- ilgili dosya parçaları,
- allowed edit regions,
- forbidden edit regions,
- gerekli test sinyalleri.

Verifier view:

- proposed patch,
- policy,
- ownership,
- module boundary,
- sensitive boundary,
- missing authority rules.

Remask view:

- verifier failure,
- failed region,
- allowed repair files,
- minimal repair instruction,
- previous patch summary.

### 4. Context Composer

Agent'a verilecek context'i seçen katmandır.

Hedef:

```text
Minimum yeterli context.
```

Ölçmesi gerekenler:

- context token estimate,
- role view size,
- included facts,
- excluded facts,
- budget utilization,
- context sufficiency risk.

Bu katman ürünün maliyet avantajı için kritik olacaktır. Çünkü ürünün ana
vaadi yalnızca scope güvenliği değil, aynı zamanda daha düşük context/token
maliyetiyle daha kontrollü agent akışı kurmaktır.

### 5. Agent Orchestrator

Agent rollerini sıraya koyan ve workspace üstündeki yazma/okuma haklarını
yöneten katmandır.

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

İleride desteklenmesi gereken flow'lar:

- verifier-only,
- coder + verifier,
- coder + verifier + remask,
- planner + coder + verifier,
- parallel bounded agents,
- conflict-aware merge.

### 6. Conflict-Aware Merge

Birden fazla agent workspace'e claim veya patch proposal yazdığında merge
katmanı şunları kontrol etmelidir:

- aynı field'a çelişkili claim var mı?
- aynı dosya bölgesine farklı agent müdahalesi var mı?
- verifier claim'i coder claim'iyle çelişiyor mu?
- stale fact kullanılmış mı?
- patch authority dışına taşmış mı?

Bu modül, "aynı context penceresinde birbirini ezmeden çalışan agent'lar"
vizyonunun ürün karşılığıdır.

### 7. Verifier ve Policy Engine

Mevcut verifier/policy engine korunacak ama yeni mimaride konumu netleşecek.

Verifier'ın görevi:

- agent'ın scope dışına çıkıp çıkmadığını kontrol etmek,
- authority eksikse durdurmak,
- sensitive risk varsa reject etmek,
- lokal eksik varsa remask request üretmek,
- human review gereken alanları işaretlemek.

Bu modül ürünün tamamı değil, agent orchestration runtime'ın kontrol katmanıdır.

### 8. Remask Engine

Remask Engine'in görevi patch'i baştan üretmek değildir.

Görevi:

- verifier'ın işaretlediği failed region'ı almak,
- yalnızca allowed repair region üretmek,
- ilgili agent'a dar repair context vermek,
- repair sonucunu workspace'e merge etmek.

Başarı metrikleri:

- remask success rate,
- no broadening rate,
- invalid contract rate,
- extra file touch rate,
- cost delta.

### 9. Cost ve Token Controller

Ürün vizyonunun önemli iddialarından biri daha düşük context maliyetidir.
Bu nedenle runtime her agent çağrısı için şunları ölçmelidir:

- estimated input tokens,
- estimated output tokens,
- role view token budget,
- budget utilization,
- remask extra cost,
- total flow cost,
- direct baseline ile karşılaştırma.

Bu olmadan "dar context daha ucuz ve kontrollü" iddiası ölçülemez.

### 10. Benchmark ve Eval Layer

Bu katman zaten başladı; fakat artık agent orchestration hedefiyle yeniden
konumlanmalıdır.

Karşılaştırılacak akışlar:

| Flow | Anlam |
| --- | --- |
| Direct agent | Tek model, tek pass, geniş veya düz context |
| Bounded workspace agent | Agent role-specific bounded view ile çalışır |
| Workspace + verifier | Patch workspace'e yazılır, verifier kontrol eder |
| Workspace + verifier + remask | Failed region lokal repair edilir |
| Multi-agent workspace | Birden fazla role workspace üstünde çalışır |
| Parallel bounded agents | Agent'lar ayrı bounded view ile eş zamanlı çalışır |

Ölçülecek metrikler:

- task success,
- patch pass,
- scope drift,
- boundary guess,
- refusal accuracy,
- missed blocker,
- false blocker,
- expected finding coverage,
- trace completeness,
- context token budget,
- cost estimate,
- remask success,
- conflict rate,
- merge safety.

## Hedef Kullanıcılar

Birincil hedef bireysel developer değildir. İlk hedef:

```text
AI coding kullanan ama scope drift, ownership, compliance, PR review yükü ve
kurumsal modül sınırlarından endişe eden engineering/platform ekipleri.
```

Personalar:

| Persona | İhtiyaç |
| --- | --- |
| Developer | Agent'ın neden durduğunu, neyi onarması gerektiğini hızlıca görür. |
| Tech Lead | Module boundary, ownership ve eksik test risklerini görür. |
| Engineering Manager | AI coding kullanımının kalite/risk etkisini ölçer. |
| Platform / DevEx Team | Kurum içi agent workflow standardı kurar. |
| Security / Compliance | Sensitive boundary ve forbidden scope kontrollerini izler. |
| Agent Tool Builder | Kendi coding agent'ına workspace/verifier/remask runtime bağlar. |

## Ürün Yüzeyleri

Çekirdek ürün bağımsız runtime olmalıdır. Farklı yüzeyler bu runtime'a bağlanır.

| Yüzey | Konum |
| --- | --- |
| CLI | Araştırma, lokal debug, CI entegrasyonu |
| GitHub Action | İlk pratik entegrasyon ve PR artifact yüzeyi |
| GitHub App | Daha iyi PR yorumları ve repo/team entegrasyonu |
| Dashboard | Team-level risk, cost, remask ve agent flow metrikleri |
| Policy Console | Ownership, allowed paths, paired files ve risk policy yönetimi |
| SDK/API | Cursor/Codex/Windsurf veya kurum içi agentlara runtime bağlamak |
| IDE Adapter | Uzun vadeli developer-facing canlı feedback |

Öncelik:

```text
Core Runtime -> CLI -> GitHub Action -> SDK/API -> Dashboard -> IDE Adapter
```

## Araştırma Bulgularının Ürün Yoluna Etkisi

Araştırmada gördüğümüz önemli ayrım şudur:

- autoregressive coder modeller implementation tarafında güçlü,
- verifier/boundary/refusal tarafında hata yapabiliyor,
- dLLM direct patch contract'ında zayıf kalabiliyor,
- fakat dLLM-style infill/refinement fikri verifier/remask rollerinde değerli
  olabilir,
- workspace/verifier/remask flow boundary guess'i azaltabiliyor,
- remask yalnızca doğru case'lerde açılırsa kalite belirleyici faktör olabilir,
- gereksiz remask maliyet yaratır.

Bu nedenle ürünün ilk stratejisi:

```text
LLM coder + deterministic verifier + bounded workspace + verifier-triggered
remask.
```

dLLM ilk sürüm için zorunlu dependency olmamalıdır. dLLM/dLLM-style modeller
ileri fazda verifier, remask planner veya masked repair adapter olarak
araştırılmalıdır.

## Yakın Dönem Yol Haritası

### Faz A: Vizyon Düzeltme ve Kanonik Dokümantasyon

Amaç:

Ürünün PR reviewer olarak yanlış daralmasını önlemek ve shared workspace
orchestration runtime vizyonunu kanonik hale getirmek.

Yapılacaklar:

- roadmap dokümanını güncelle,
- README'deki ürün cümlesini gerekirse güçlendir,
- `ORCHESTRATION_RUNTIME.md` içindeki "current scope" kısmını yeni vizyonla
  uyumlu hale getir,
- `HYBRID_AGENT_ARCHITECTURE.md` içindeki "AI patch boundary reviewer" ifadesini
  alt kullanım alanı olarak yeniden konumlandır,
- gelecek issue'ları PR reviewer değil orchestration runtime ekseninde aç.

Başarı kriteri:

```text
Projeye yeni bakan biri ürünün asıl hedefinin PR reviewer değil, bounded-context
agent orchestration runtime olduğunu anlar.
```

### Faz B: Shared Workspace Core v1

Amaç:

Workspace'i yalnızca review output içinde üretilen snapshot olmaktan çıkarıp
ürünün ana state modeli haline getirmek.

Yapılacaklar:

- `SharedWorkspace` schema'sını genişlet,
- task, policy, repo facts, claims, patch plan, verifier result, remask request
  alanlarını ayır,
- workspace mutation/event modelini tanımla,
- agent claim formatı ekle,
- conflict record formatı ekle,
- workspace serialization/deserialization ekle.

Başarı kriteri:

```text
Bir task için workspace oluşturulabilir, agent claim'i eklenebilir, verifier
sonucu yazılabilir ve final trace alınabilir.
```

### Faz C: Bounded Working Memory v1

Amaç:

Her agent rolü için task-bound, ephemeral, policy-bound context view üretmek.

Yapılacaklar:

- planner view contract,
- coder view contract,
- verifier view contract,
- tester view contract,
- remask view contract,
- view token estimate,
- included/excluded facts listesi,
- view provenance.

Başarı kriteri:

```text
Aynı workspace'ten farklı agent rolleri için farklı bounded working memory
view'leri deterministik üretilebilir.
```

### Faz D: Context Composer v1

Amaç:

Dar context üretimini ürünün merkezi yeteneği haline getirmek.

Yapılacaklar:

- context budget input,
- role-specific field selection,
- policy-aware filtering,
- sensitive field exclusion,
- stale fact exclusion,
- minimal sufficient context report,
- budget utilization metric.

Başarı kriteri:

```text
Bir role view için hangi bilgilerin seçildiği, hangilerinin dışarıda bırakıldığı
ve bunun token maliyeti raporlanabilir.
```

### Faz E: Agent Orchestrator v1

Amaç:

Tek seferlik review runtime'dan, çok adımlı agent flow runtime'a geçmek.

İlk flow:

```text
workspace:create
  -> planner:claim
  -> coder:patch_plan
  -> verifier:decision
  -> remask:optional
  -> merge:final
```

Yapılacaklar:

- flow definition formatı,
- role execution contract,
- workspace read/write permissions,
- step result schema,
- failure handling,
- deterministic mock agentlar,
- trace report.

Başarı kriteri:

```text
Mock agentlarla uçtan uca bounded workspace orchestration flow çalışır ve
trace üretir.
```

### Faz F: Conflict-Aware Merge v1

Amaç:

Birden fazla agent claim veya patch proposal yazdığında conflict yakalamak.

Yapılacaklar:

- claim ownership,
- writable region tracking,
- conflicting claim detection,
- stale claim detection,
- unsafe overwrite detection,
- merge decision report.

Başarı kriteri:

```text
İki agent aynı workspace bölgesinde çelişkili karar üretirse runtime bunu
yakalar ve final merge'e sessizce sokmaz.
```

### Faz G: Cost/Token Benchmark v1

Amaç:

Ürün iddiasının maliyet tarafını ölçmek.

Karşılaştırılacaklar:

- direct large-context agent,
- bounded workspace agent,
- workspace + verifier,
- workspace + verifier + remask.

Ölçümler:

- estimated input tokens,
- estimated output tokens,
- role view size,
- total flow cost,
- remask extra cost,
- task success,
- scope drift,
- missed blocker,
- false blocker.

Başarı kriteri:

```text
Bounded workspace flow'un hangi senaryoda daha düşük context maliyetiyle
benzer veya daha güvenli sonuç verdiği raporlanabilir.
```

### Faz H: Repo Intelligence v1

Amaç:

Policy'nin tamamını elle yazmak zorunda kalmadan repo hakkında ilk otomatik
sinyalleri üretmek.

Yapılacaklar:

- package manager detection,
- source/test/docs/config file classification,
- generated/build output tahmini,
- likely paired files,
- likely public API files,
- likely test mappings,
- suggested policy draft.

Başarı kriteri:

```text
Yeni bir repo için starter policy ve workspace facts otomatik önerilebilir.
```

### Faz I: Model Adapter Layer

Amaç:

Runtime'ı modelden bağımsız tutarak LLM/dLLM/dLLM-style adapterları bağlamak.

İlk roller:

- coder adapter,
- verifier adapter,
- remask adapter.

İlk prensip:

```text
Model karar motorunun yerine geçmez; workspace'e claim/proposal yazar.
Runtime merge ve verifier kararını korur.
```

Başarı kriteri:

```text
Mock model, local model veya OpenAI-compatible model aynı role contract üstünden
çalışabilir.
```

### Faz J: dLLM-Style Verifier/Remask Araştırması

Amaç:

dLLM veya masked refinement fikrini ürün flow'una doğru rolde bağlamak.

Araştırma soruları:

- dLLM direct patch yazmada mı güçlü?
- verifier kararlarında mı daha değerli?
- remask failed region repair'de mi avantajlı?
- narrow context + synthetic workspace packet ile daha az scope drift üretir mi?

Başarı kriteri:

```text
dLLM/dLLM-style adapter'ın hangi role gerçekten katkı sağladığı benchmark ile
gösterilir.
```

### Faz K: Developer Experience ve Entegrasyonlar

Amaç:

Runtime'ı gerçek ekiplerin deneyebileceği hale getirmek.

Yapılacaklar:

- CLI komutlarını sadeleştir,
- starter config üret,
- GitHub Action rehberini sadeleştir,
- PR comment çıktısını developer-friendly hale getir,
- JSON artifact schema'sını stabil hale getir,
- SDK/API taslağı çıkar.

Başarı kriteri:

```text
Bir ekip 10-15 dakika içinde runtime'ı kendi repo'sunda artifact-only modda
çalıştırabilir.
```

### Faz L: Dashboard ve Team Metrics

Amaç:

Tek PR yerine takım seviyesinde agentic coding risklerini görünür yapmak.

Metrikler:

- AI patch count,
- boundary guess count,
- false blocker,
- missed blocker,
- remask required,
- remask success,
- token budget,
- role view size,
- scope drift,
- ownership misses,
- module boundary findings.

Başarı kriteri:

```text
Team lead veya platform ekibi AI coding akışının risk ve maliyet trendini
görebilir.
```

## Teknik Öncelik Sırası

Bundan sonraki issue'lar şu sırayla açılmalı:

1. Roadmap ve ürün vizyon dokümanlarının düzeltilmesi.
2. Shared Workspace Core v1.
3. Bounded Working Memory role view contractları.
4. Context Composer v1.
5. Agent Orchestrator mock flow.
6. Conflict-aware merge.
7. Cost/token benchmark.
8. Repo Intelligence v1.
9. Model adapter contracts.
10. dLLM-style verifier/remask adapter araştırması.
11. Developer experience ve consumer setup polish.
12. Dashboard/reporting.

Bu sırada PR review/GitHub Action işleri tamamen bırakılmayacak; fakat artık ana
ürün yönü olarak değil, runtime'ın ilk entegrasyon yüzeyi olarak ele alınacak.

## Başarıyı Nasıl Ölçeceğiz?

Ürün hedefinin doğru ilerleyip ilerlemediğini şu sorularla ölçeceğiz:

### Context ve Maliyet

- Agent başına context token budget düşüyor mu?
- Role-specific view gereksiz bilgiyi dışarıda bırakabiliyor mu?
- Remask sadece gerekli durumda açılıyor mu?
- Direct large-context flow'a göre maliyet avantajı var mı?

### Güvenilirlik

- Scope drift azalıyor mu?
- Boundary guess azalıyor mu?
- Missed blocker azalıyor mu?
- False blocker kabul edilebilir seviyede mi?
- Sensitive boundary ihlalleri yakalanıyor mu?

### Orkestrasyon Kalitesi

- Agent'lar aynı workspace üstünde birbirini ezmeden çalışabiliyor mu?
- Çelişkili claim'ler yakalanıyor mu?
- Verifier feedback workspace'e doğru yazılıyor mu?
- Remask lokal failed region ile sınırlı kalıyor mu?

### Ürün Kullanılabilirliği

- Bir ekip repo policy'sini kolayca başlatabiliyor mu?
- Raporlar actionable mı?
- PR/CI entegrasyonu düşük sürtünmeli mi?
- Runtime modelden bağımsız kullanılabiliyor mu?

## Savunulabilir Ürün Tezi

Şu an savunulabilir ürün tezi şudur:

```text
Agentic coding'de kalite problemi yalnızca model seçimi problemi değildir.
Asıl problem, agent'ın hangi bağlamı gördüğü, hangi yetkiye sahip olduğu,
hangi ortak workspace'e yazdığı, ne zaman durduğu ve nasıl doğrulandığıdır.

Bounded Agent Orchestration Runtime, agent'lara sınırsız context veya kalıcı
hafıza vermek yerine, shared semantic workspace ve role-specific bounded
working memory üzerinden daha kontrollü, daha ölçülebilir ve daha düşük
maliyetli agent akışları kurmayı hedefler.
```

Bu tez iddialı ama ölçülebilir kalmalıdır. Şimdilik "her kurumda kesin çalışır"
demiyoruz. Şunu diyoruz:

```text
İlk validation katmanında, iki OSS repo üstünde pozitif ve negatif PR-shaped
fixture'larla verifier/policy runtime'ın false blocker ve missed blocker
üretmeden çalıştığını gösterdik. Bundan sonraki hedef, bu doğrulama katmanını
asıl shared-workspace agent orchestration runtime'a bağlamaktır.
```

## Kısa Özet

Proje bundan sonra şu cümleye sadık kalmalıdır:

```text
Bu ürün bir PR reviewer değildir.
Bu ürün, PR reviewer yüzeyi de olan bounded-context shared-workspace agent
orchestration runtime'dır.
```

En önemli teknik hedef:

```text
Agent'lara tüm hafızayı ve tüm repo context'ini vermeden, role-specific bounded
working memory ile ortak semantic workspace üstünde daha güvenli, daha ucuz ve
daha izlenebilir agentic coding akışları kurmak.
```
