# MVP Readiness Checklist

Bu doküman, Bounded Agent Orchestration Runtime MVP'sini demo etmeden veya bir
başka repoda denemeden önce geçilmesi gereken kısa kontrol listesidir.

## MVP Tanımı

MVP şu işi yapar:

```text
task + diff + policy
  -> bounded workspace
  -> verifier findings
  -> approve / refuse / reject / remask_required / human_review_required
  -> JSON + Markdown + PR comment artifact
```

MVP şu işi yapmaz:

- IDE değildir.
- Kod üreten ana agent değildir.
- İnsan review yerine geçmez.
- Her patch'i otomatik düzeltmez.
- dLLM'i zorunlu dependency yapmaz.
- Güvenlik garantisi vermez; policy risklerini görünür yapar.

## Local Demo Gate

Demo öncesi şu komutlar geçmeli:

```bash
npm install
npm run build
npm run test:smoke
npm run product:policy -- --init --out /tmp/bounded-agent.policy.yml
npm run product:policy -- --validate --policy /tmp/bounded-agent.policy.yml
npm run product:policy -- --validate --policy bounded-agent.policy.yml --format both
npm run product:action-smoke
npm run product:pilot -- --out-dir /tmp/bounded-agent-pilot --fail-on-regression
npm run product:pilot-v2 -- --out-dir /tmp/bounded-agent-pilot-v2 --fail-on-regression
npm run product:cross-repo-validation -- --out-dir /tmp/bounded-cross-repo --fail-on-runtime-drift --fail-on-unreviewed
npm run product:mixed-external-validation -- --out-dir /tmp/bounded-mixed-external --fail-on-false-blocker --fail-on-missed-blocker
npm run product:dogfood-validation -- --out-dir /tmp/bounded-agent-dogfood-validation --fail-on-error
npm run product:external-evidence -- --out-dir /tmp/bounded-agent-external-evidence --fail-on-regression
```

Ürün review örneği:

```bash
npm run product:review -- \
  --task examples/product-runtime/tasks/repo-dogfood.md \
  --diff examples/product-runtime/diffs/repo-package-remask.diff \
  --policy bounded-agent.policy.yml \
  --format both
```

Beklenen karar:

```text
remask_required
```

Çünkü `package.json` değişirken policy'ye göre paired `package-lock.json`
değişikliği eksiktir. Bu, ürünün temel farkını gösterir: patch tamamen
reddedilmez; güvenli lokal repair bölgesi işaretlenir.

## PR Comment Gate

Review JSON üretildikten sonra yorum artifact'i oluşmalı:

```bash
npm run product:comment -- \
  --review reports/product-runtime/2026-...-product-review.json \
  --out reports/product-runtime/pr-comment.md \
  --marker "<!-- bounded-agent-review -->"
```

Kontrol:

```text
pr-comment.md içinde <!-- bounded-agent-review --> marker'ı bulunmalı.
```

Bu marker aynı PR'da tek yorumun güncellenmesini sağlar.

Composite GitHub Action kullanıldığında bu artifact ayrıca manuel üretilmez;
action `comment-path` output'u olarak verir.

## GitHub Action Gate

Bir consumer repo için minimum workflow:

```yaml
name: Bounded Agent Review

on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Create PR diff
        run: git diff origin/${{ github.base_ref }}...HEAD > pr.diff
      - name: Bounded review
        id: bounded-review
        uses: theOguz16/bounded-dllm-agent-lab@main
        with:
          task: task.md
          diff: pr.diff
          policy: bounded-agent.policy.yml
          output-dir: reports/product-runtime
          fail-on: high
      - name: Show bounded review outputs
        run: |
          echo "Decision: ${{ steps.bounded-review.outputs.decision }}"
          echo "Comment: ${{ steps.bounded-review.outputs.comment-path }}"
          echo "Index: ${{ steps.bounded-review.outputs.index-markdown-path }}"
```

PR comment posting güvenli varsayılan olarak kapalıdır. Açmak için repository
variable:

```text
BOUNDED_REVIEW_POST_COMMENT=true
```

## Demo Script

Kısa anlatım:

1. Bu runtime model router değildir; context + authority + workspace
   orkestrasyonudur.
2. Policy agent'ın sınırlarını tanımlar.
3. Runtime diff'i policy ile karşılaştırır.
4. Eksik authority varsa `refuse`, forbidden scope varsa `reject`, lokal eksik
   varsa `remask_required` üretir.
5. Sonuç JSON/Markdown/PR comment artifact olarak trace edilebilir.
6. MVP-2 pilotunda owner alias, required test mapping ve policy quality score
   sinyalleri gösterilir.

## Known Limits

- Policy parser basit YAML subset'i destekler.
- Glob desteği sınırlı ama MVP için yeterlidir.
- Runtime henüz gerçek repo graph çıkarmıyor.
- Ownership kuralları ve owner alias'ları karar motorunda deterministic
  uygulanıyor; fakat gerçek organizasyon ownership graph'i henüz otomatik
  çıkarılmıyor.
- GitHub comment posting repo variable ile açılır; fork PR izinleri ayrıca
  değerlendirilmelidir.
- Dashboard, SDK ve IDE adapter sonraki fazdır.
- Static artifact viewer ve SDK/API draft vardır; IDE adapter sonraki fazdır.
- Provider adapter live-call yolu opt-in'dir ve gerçek credential seçimi pilot
  sahibinin kontrolündedir.

## Readiness Kararı

MVP demo edilebilir sayılır, eğer:

- local build ve smoke test geçiyor,
- starter policy üretilebiliyor,
- starter ve dogfood policy validate edilebiliyor,
- action artifact smoke geçiyor,
- MVP-1 pilot suite geçiyor,
- dogfood review expected decision üretiyor,
- PR comment artifact marker içeriyor,
- GitHub Action JSON/Markdown/comment/index artifact path'lerini output olarak
  verecek şekilde dokümante edilmişse,
- MVP-2 pilot suite policy quality, owner alias ve required test mapping
  senaryolarını regresyonsuz geçiriyorsa,
- cross-repo reviewed external validation drift üretmiyorsa,
- mixed external validation pozitif PR'larda false blocker ve negatif
  kontrollerde missed blocker üretmiyorsa,
- dogfood validation workflow/action artifact contract'ını doğruluyorsa,
- external evidence package NanoID ve p-limit pilotlarını tek raporda
  geçirebiliyorsa.
