# Bounded Agent Orchestration Runtime

Bu doküman, araştırma labından ürün çekirdeğine geçişteki ilk runtime
sözleşmesini tanımlar. Amaç bir IDE veya model router yazmak değildir. Amaç,
kurumsal agentic coding akışında context, authority, workspace, verifier ve
remask kararlarını modelden bağımsız şekilde yönetmektir.

## Product Definition

```text
Bounded-context agent orchestration runtime for enterprise software teams.
```

Bu ürün bir PR reviewer değildir. PR review ve GitHub Action yüzeyi, runtime'ın
ilk pratik entegrasyon yüzeyidir. Çekirdek ürün; context, authority, shared
workspace, bounded working memory, verifier/remask feedback loop, merge decision
ve trace orchestration katmanıdır.

Runtime şu sorulara cevap verir:

- Agent hangi role-specific bounded working memory view'ini almalı?
- Agent hangi dosyaları görebilir?
- Agent hangi dosyalara dokunabilir?
- Eksik ürün/platform/compliance kararı varsa durmalı mı?
- Patch forbidden scope veya sensitive boundary ihlali yapıyor mu?
- Patch güvenli ama eksikse hangi lokal bölge remask edilmeli?
- Verifier sonucu, remask request'i ve final merge kararı workspace'e nasıl yazılmalı?
- Son karar nasıl trace edilecek?

## First Runtime Loop

```text
task + diff + policy
  -> SharedWorkspace v1
  -> role-specific bounded views
  -> verifier findings
  -> verifier/remask/merge workspace events
  -> approve | refuse | reject | remask_required | human_review_required
  -> JSON + Markdown report
```

Bu ilk loop model çağırmaz. Bilerek deterministic tutulur. Böylece ürün
çekirdeği, model kalitesiyle karışmadan test edilebilir.

## Decisions

| Decision | Anlamı |
| --- | --- |
| `approve` | Patch policy ve scope açısından geçebilir. |
| `refuse` | Eksik authority/karar var; model tahmin yürütmemeli. |
| `reject` | Forbidden path, unsafe scope veya sensitive risk var. |
| `remask_required` | Patch scope içinde ama lokal/paired-file repair gerekiyor. |
| `human_review_required` | Runtime otomatik karar için yeterli sinyal bulamadı. |

Karar önceliği:

```text
reject > refuse > remask_required > human_review_required > approve
```

## Policy Contract

İlk sürüm policy alanları:

```yaml
allowed_paths:
  - package.json
  - jsr.json
forbidden_paths:
  - index.js
paired_files:
  - source: package.json
    requires: jsr.json
    reason: release metadata must stay consistent
    changed_when_contains: version
sensitive_patterns:
  - API_KEY
  - SECRET
required_tests:
  - test/check-versions.js
missing_authority_rules:
  - approved product default
```

`changed_when_contains` opsiyoneldir. Verilmezse kural eski geniş davranışla,
yalnızca dosyanın değişmesine bakarak çalışır. Verilirse runtime sadece eklenen
ve çıkarılan satırlarda bu sinyali arar; diff context satırları kuralı
tetiklemez.

Yeni bir repo için starter policy üretilebilir:

```bash
npm run product:policy -- --init --out bounded-agent.policy.yml
```

Policy doğrulama komutu, dosyanın parse edilebilir olmasının ötesinde bazı ürün
uyarıları da verir:

```bash
npm run product:policy -- --validate --policy bounded-agent.policy.yml
```

Örneğin boş `forbidden_paths` bir syntax hatası değildir, fakat ürün açısından
zayıf bir boundary sinyalidir. Bu yüzden validation sonucu error ve warning
ayrımı yapar.

## CLI Usage

Build sonrası:

```bash
npm run product:review -- \
  --task task.md \
  --diff patch.diff \
  --policy policy.yml \
  --out-dir reports/product-runtime
```

MVP kullanım rehberi ve GitHub Action örneği için:

```text
docs/MVP_USAGE.md
```

Çıktılar:

- JSON review artifact,
- Markdown PR/report metni,
- comment-ready PR summary,
- idempotent PR comment marker,
- report index artifact,
- decision,
- risk level,
- findings,
- remask regions,
- role-specific bounded views,
- SharedWorkspace v1 events,
- verifier/remask/merge decision records,
- trace.

## PR Comment Publishing

Runtime'ın güvenli varsayılanı artifact üretmektir. PR sayfasına yorum yazmak
opsiyonel bir yayınlama yüzeyidir. Bu nedenle dogfood workflow'u önce
`pr-comment.md` üretir; sadece `BOUNDED_REVIEW_POST_COMMENT=true` repository
variable'ı açılmışsa GitHub PR yorumunu yazar veya günceller. Composite action
bu artifact'i `comment-path` output'u olarak verir. Aynı action ayrıca
`json-path`, `markdown-path`, `index-json-path` ve `index-markdown-path`
output'larını üretir.

Yorum güncelleme davranışı sabit bir marker ile yapılır:

```text
<!-- bounded-agent-review -->
```

Bu marker kullanıcıya görünmez. Ürün açısından görevi, aynı PR'da tek bounded
review yorumunun güncel kalmasını sağlamaktır. Böylece runtime hem CI artifact
olarak denetlenebilir kalır hem de PR içinde okunabilir bir review yüzeyi sunar.

## Why This Matters

Bu runtime, klasik “hangi model hangi işi yapsın?” orkestrasyonu değildir.

Asıl hedef:

```text
context + authority + workspace orchestration
```

Bu sayede her agent tüm geçmişi veya tüm repo bağlamını görmek zorunda kalmaz.
Her agent kendi rolüne göre task-bound, ephemeral ve policy-bound bounded
working memory görür.

## Current Scope

İlk ürün çekirdeği şunları yapar:

- task/diff/policy input alır.
- Task, scope, authority, repo facts ve patch intent içeren SharedWorkspace v1 üretir.
- Workspace event/mutation kaydı tutar.
- Role-specific bounded view üretir.
- Scope ve forbidden path kontrolü yapar.
- Missing authority durumunda refusal üretir.
- Sensitive pattern riskini yakalar.
- Paired-file eksiklerinde remask region üretir.
- Verifier result, remask request ve merge decision kayıtlarını workspace'e yazar.
- Workspace JSON serialization/deserialization contract'ı sağlar.
- Markdown ve JSON rapor üretir.

İlk ürün çekirdeği şunları yapmaz:

- IDE yerine geçmez.
- Kod patch’i otomatik üretmez.
- Her patch’i remask etmez.
- İnsan review yerine geçmez.
- dLLM veya belirli bir model provider gerektirmez.
- PR reviewer olarak daralmaz; PR yüzeyi yalnızca ilk kullanım alanıdır.
