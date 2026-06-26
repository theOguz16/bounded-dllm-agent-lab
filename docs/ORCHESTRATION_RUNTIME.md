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
  -> Context Composer v1
  -> role-specific bounded working memory views
  -> Agent Orchestrator v1 mock flow
      workspace:create
      planner:claim
      coder:patch_plan
      verifier:decision
      remask:optional
      merge:final
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
- included/excluded context facts,
- view token estimate, budget utilization and context sufficiency risk,
- SharedWorkspace v1 events,
- orchestration step results,
- mock flow trace,
- merge safety findings and conflict records,
- cost/token benchmark flow summaries,
- repo intelligence package manager, file classification, generated/build, paired-file and test-mapping suggestions,
- model adapter role outputs and adapter validation,
- dLLM-style synthetic workspace packet experiment summaries,
- stable product artifact summary schema,
- team-level dashboard metrics JSON/Markdown,
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

This section separates what is already implemented from what is scaffolded or
planned. The product direction is a bounded-context shared-workspace agent
orchestration runtime, but the current production-ready surface is still smaller
than the full target architecture.

<!--
Maintainer note:
Do not list roadmap goals as current product capabilities. If the runtime only
has a schema, mock command, or artifact field for a module, mark it as
"scaffolded" until it is exercised by a stable flow and regression tests.
-->

### Implemented Now

The current product runtime can:

* accept `task + diff + policy` input,
* parse changed files and diff hunks,
* evaluate configured scope and policy boundaries,
* check allowed paths and forbidden paths,
* detect missing authority signals,
* detect sensitive pattern risks,
* detect paired-file and required-test gaps,
* produce one of these decisions:

```text
approve | refuse | reject | remask_required | human_review_required
```

* generate JSON and Markdown review artifacts,
* generate a PR-comment-ready Markdown summary,
* generate report index artifacts,
* run in CLI and GitHub Action surfaces,
* run without model provider credentials,
* keep provider-backed model calls opt-in,
* keep PR comment publishing disabled by default unless explicitly enabled.

This implemented layer is the first integration surface of the runtime. It is
not the full long-term product.

### Scaffolded Now

The repository also contains early contracts, artifacts, or mock paths for:

* `SharedWorkspace v1`,
* workspace event and mutation records,
* role-specific bounded working memory views,
* included/excluded context fact reports,
* context token estimate and budget utilization fields,
* deterministic mock orchestration flow,
* planner/coder/verifier/remask-style step outputs,
* conflict and merge safety records,
* cost/token benchmark summaries,
* repo intelligence and starter policy suggestions,
* provider-backed role adapter contracts,
* stable `product-runtime-artifact/v1` summary,
* team metrics artifacts.

These pieces should be treated as active product scaffolding. They are important,
but they should not be presented as a complete autonomous orchestration platform
yet.

### Planned Next

The next product phases should turn the scaffolding into the actual runtime
center:

1. Promote `SharedWorkspace` from review artifact snapshot to central runtime
   state model.
2. Stabilize planner, coder, verifier, tester and remask bounded working memory
   contracts.
3. Make Context Composer a standalone policy-aware context selection module.
4. Add a deterministic multi-step Agent Orchestrator over the workspace.
5. Add explicit conflict-aware merge behavior for agent claims and patch
   proposals.
6. Restrict remask repair to verifier-triggered failed regions.
7. Standardize direct large-context vs bounded workspace cost/token comparison.
8. Expand repo intelligence into starter policy generation.
9. Stabilize model adapter contracts without letting models own final decisions.
10. Research dLLM-style verifier/remask roles after the runtime contracts are
    stable.

### Non-Goals

The current runtime does not:

* replace an IDE,
* replace Cursor, Codex or Windsurf,
* automatically generate production patches,
* automatically merge code,
* replace human review,
* require a dLLM or a specific model provider,
* treat PR review as the whole product.

PR review is the first surface. The durable product core is context, authority,
workspace, bounded working memory, verifier/remask, merge decision, trace and
cost orchestration.
