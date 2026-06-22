# MVP Usage: Bounded Agent Runtime

Bu MVP, kurumsal agentic coding için tam orkestrasyon platformunun ilk küçük
ürün yüzeyidir. Bir IDE değildir; bir model router değildir. İlk işi, task +
diff + policy girdisini okuyup patch'in scope, authority, sensitive boundary ve
paired-file risklerini deterministik olarak değerlendirmektir.

## Kim İçin?

İlk hedef kullanıcılar:

- AI coding kullanan engineering ekipleri,
- PR review yükünü azaltmak isteyen tech lead'ler,
- kurum içi AI coding policy standardı kurmak isteyen platform/DevEx ekipleri,
- kendi coding agent'ına verifier/remask katmanı bağlamak isteyen agent tool
  geliştiricileri.

## Ne Yapar?

Runtime şu kararları üretir:

| Decision | Anlamı |
| --- | --- |
| `approve` | Patch scope ve policy açısından geçebilir. |
| `refuse` | Eksik authority/karar var; agent tahmin yürütmemeli. |
| `reject` | Forbidden path, unsafe scope veya sensitive risk var. |
| `remask_required` | Patch scope içinde ama lokal/paired-file repair gerekiyor. |
| `human_review_required` | Otomatik karar için yeterli sinyal yok. |

Ek olarak JSON ve Markdown raporda şunları verir:

- summary metrics,
- role-specific bounded views,
- verifier findings,
- remask regions,
- trace events,
- comment-ready PR summary,
- report index for CI artifacts.

## CLI

Önce build:

```bash
npm install
npm run build
```

Yeni bir repoda starter policy üretmek:

```bash
npm run product:policy -- \
  --init \
  --out bounded-agent.policy.yml
```

Policy dosyasını doğrulamak:

```bash
npm run product:policy -- \
  --validate \
  --policy bounded-agent.policy.yml
```

Starter policy bilinçli olarak muhafazakardır. Önce `allowed_paths`,
`forbidden_paths`, `paired_files` ve `sensitive_patterns` alanlarını takımın repo
yapısına göre daraltmak gerekir. Bu adım ürün felsefesinin temelidir: her agent'a
tüm repo değil, policy-bound çalışma alanı verilir.

Örnek approve koşusu:

```bash
npm run product:review -- \
  --task examples/product-runtime/tasks/release-metadata.md \
  --diff examples/product-runtime/diffs/approve.diff \
  --policy examples/product-runtime/policies/release-policy.yml \
  --format both
```

Örnek remask koşusu:

```bash
npm run product:review -- \
  --task examples/product-runtime/tasks/release-metadata.md \
  --diff examples/product-runtime/diffs/remask-required.diff \
  --policy examples/product-runtime/policies/release-policy.yml \
  --format both
```

CI için risk eşiği:

```bash
npm run product:review -- \
  --task task.md \
  --diff patch.diff \
  --policy policy.yml \
  --fail-on high
```

`--fail-on medium` medium ve high riskte non-zero döner. `--fail-on never`
sadece rapor üretir.

PR comment artifact üretimi:

```bash
npm run product:comment -- \
  --review reports/product-runtime/2026-...-product-review.json \
  --out reports/product-runtime/pr-comment.md \
  --marker "<!-- bounded-agent-review -->"
```

`--marker` PR yorumunun içine görünmez bir HTML marker ekler. Bunun amacı
yorum içeriğini değiştirmek değil, GitHub workflow'unun önceki bounded review
yorumunu bulup güncellemesini sağlamaktır. Böylece her CI koşusunda yeni yorum
oluşmaz.

Birden fazla ürün raporunu indekslemek:

```bash
npm run product:report-index -- \
  --dir reports/product-runtime \
  --out-dir reports/product-runtime
```

## GitHub Action

Örnek workflow:

```yaml
name: Bounded Agent Review

on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Create PR diff
        run: git diff origin/${{ github.base_ref }}...HEAD > pr.diff
      - name: Bounded review
        id: bounded-review
        uses: theOguz16/bounded-dllm-agent-lab@main
        with:
          task: task.md
          diff: pr.diff
          policy: bounded-agent.policy.yml
          fail-on: high
          output-dir: reports/product-runtime
      - name: Show bounded review outputs
        run: |
          echo "Decision: ${{ steps.bounded-review.outputs.decision }}"
          echo "Risk: ${{ steps.bounded-review.outputs.risk-level }}"
          echo "Comment: ${{ steps.bounded-review.outputs.comment-path }}"
          echo "Index: ${{ steps.bounded-review.outputs.index-markdown-path }}"
      - uses: actions/upload-artifact@v4
        with:
          name: bounded-agent-review
          path: reports/product-runtime
```

Composite action şu artifact'leri üretir:

| Output | Anlamı |
| --- | --- |
| `json-path` | Makine-okunur review sonucu |
| `markdown-path` | İnsan-okunur review raporu |
| `comment-path` | PR yorumuna hazır kısa Markdown |
| `index-json-path` | Ürün runtime rapor index'i |
| `index-markdown-path` | İnsan-okunur rapor index'i |

Bu repo kendi kendini dogfood etmek için ayrıca şu workflow'u içerir:

```text
.github/workflows/bounded-review.yml
```

Workflow PR diff'i çıkarır, `bounded-agent.policy.yml` ile local action'ı
çalıştırır ve JSON/Markdown/comment/index artifact'lerini yükler. Model veya API
secret gerektirmez.

Varsayılan mod artifact-only'dir. Yani workflow PR comment dosyasını üretir ama
PR sayfasına otomatik yorum yazmaz. PR'a yorum yazdırmak isteyen repo sahibi şu
repository variable'ı bilinçli şekilde açabilir:

```text
BOUNDED_REVIEW_POST_COMMENT=true
```

Bu değişken açıkken workflow `<!-- bounded-agent-review -->` marker'ı taşıyan
önceki yorumu arar. Bulursa günceller, bulamazsa tek yeni yorum oluşturur. Bu
mod için workflow `issues: write` ve `pull-requests: write` izinlerini ister.
Fork PR'larında token izinleri kısıtlı olabileceği için posting modu dikkatli
kullanılmalıdır.

## Policy Contract

Minimum policy:

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
sensitive_patterns:
  - SECRET
  - API_KEY
required_tests:
missing_authority_rules:
```

Bu repo kendi dogfood policy dosyasını kökte tutar:

```text
bounded-agent.policy.yml
```

## Örnekler

Hazır örnekler:

| Diff | Beklenen Karar |
| --- | --- |
| `examples/product-runtime/diffs/approve.diff` | `approve` |
| `examples/product-runtime/diffs/remask-required.diff` | `remask_required` |
| `examples/product-runtime/diffs/reject-forbidden.diff` | `reject` |
| `examples/product-runtime/diffs/refuse-missing-authority.diff` | `refuse` |
| `examples/product-runtime/diffs/human-review-empty.diff` | `human_review_required` |

Repo dogfood örnekleri:

| Diff | Beklenen Karar |
| --- | --- |
| `examples/product-runtime/diffs/repo-docs-approve.diff` | `approve` |
| `examples/product-runtime/diffs/repo-package-remask.diff` | `remask_required` |
| `examples/product-runtime/diffs/repo-sensitive-reject.diff` | `reject` |

## Ne Yapmaz?

MVP şunları özellikle yapmaz:

- IDE yerine geçmez.
- Cursor/Codex/Windsurf alternatifi değildir.
- Patch'i otomatik üretmez.
- Her patch'i otomatik remask etmez.
- Belirli bir model veya API key gerektirmez.
- İnsan review yerine geçmez.

Bu MVP'nin amacı daha dar ve ölçülebilirdir:

```text
AI patch'lerde context, authority, scope ve repair kararlarını görünür yapmak.
```
