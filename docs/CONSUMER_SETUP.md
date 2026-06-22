# Consumer Repository Setup

Bu rehber, Bounded Agent Runtime MVP'sini başka bir GitHub reposunda denemek
içindir. Amaç yeni bir IDE kurmak değil; PR diff'lerini `task + diff + policy`
üzerinden bounded review'a sokmaktır.

## 1. Policy Dosyası Oluştur

Bu repoda:

```bash
npm install
npm run build
npm run product:policy -- --init --out bounded-agent.policy.yml
```

Oluşan `bounded-agent.policy.yml` dosyasını consumer repoya taşı.

Consumer repoda ilk düzenlenecek alanlar:

| Alan | Neden Önemli |
| --- | --- |
| `allowed_paths` | Agent'ın hangi dosyalara dokunabileceğini daraltır. |
| `forbidden_paths` | Production secret, infra veya sahip olunmayan modülleri korur. |
| `paired_files` | `package.json` -> lockfile gibi birlikte değişmesi gereken dosyaları yakalar. |
| `sensitive_patterns` | Secret-like patch text için reject sinyali üretir. |
| `missing_authority_rules` | Eksik ürün/platform/compliance kararı varsa refuse üretir. |

Policy doğrula:

```bash
npm run product:policy -- \
  --validate \
  --policy bounded-agent.policy.yml \
  --format both
```

## 2. Workflow Ekle

Consumer repoya şu dosya eklenebilir:

```text
.github/workflows/bounded-agent-review.yml
```

Kopyalanabilir örnek:

```text
examples/github-actions/bounded-agent-review.yml
```

Minimum kullanım:

```yaml
- name: Bounded review
  id: bounded-review
  uses: theOguz16/bounded-dllm-agent-lab@main
  with:
    task: bounded-agent-task.md
    diff: bounded-agent-pr.diff
    policy: bounded-agent.policy.yml
    output-dir: reports/product-runtime
    fail-on: high
```

## 3. Üretilen Artifact'leri Oku

Action şu output'ları verir:

| Output | Açıklama |
| --- | --- |
| `decision` | `approve`, `refuse`, `reject`, `remask_required`, `human_review_required` |
| `risk-level` | `low`, `medium`, `high` |
| `json-path` | Makine-okunur review sonucu |
| `markdown-path` | İnsan-okunur review raporu |
| `comment-path` | PR yorumuna hazır kısa Markdown |
| `index-json-path` | Makine-okunur artifact index'i |
| `index-markdown-path` | İnsan-okunur artifact index'i |

Artifact-only mod güvenli varsayılandır. Yani workflow artifact üretir ama PR'a
otomatik yorum yazmaz.

## 4. Opsiyonel PR Comment Posting

PR'a yorum yazmak istiyorsan kendi workflow'unda `comment-path` output'unu
kullanarak tek yorumu update eden bir adım ekleyebilirsin. Bu repodaki dogfood
workflow örnek alınabilir:

```text
.github/workflows/bounded-review.yml
```

Yorum idempotency marker'ı:

```text
<!-- bounded-agent-review -->
```

Bu marker aynı PR'da yorum tekrarını engeller.

## 5. İlk Beklenen Sinyaller

| Decision | Ne Yapmalı |
| --- | --- |
| `approve` | Normal human review'a devam et. |
| `remask_required` | Sadece verifier'ın işaretlediği lokal bölgeyi düzelt. |
| `refuse` | Eksik authority bilgisini netleştir; model tahmin yürütmesin. |
| `reject` | Patch boundary ihlali yapmış; merge etme. |
| `human_review_required` | Runtime yeterli sinyal bulamadı; insan kararı gerekiyor. |

## Known Limits

- MVP deterministic policy/review runtime'dır; model çağırmaz.
- Full repo graph ve ownership inference henüz yoktur.
- YAML parser basit subset destekler.
- Güvenlik garantisi vermez; policy risklerini görünür yapar.
- İlk kullanımda `allowed_paths` fazla geniş bırakılırsa boundary sinyali zayıflar.

## Önerilen İlk Deneme

1. Küçük bir docs/package metadata PR'ı aç.
2. `bounded-agent.policy.yml` içinde sadece ilgili paths'i allowed yap.
3. Lockfile veya paired-file eksik bırakarak `remask_required` davranışını gözle.
4. Forbidden path'e küçük bir test diff'i ile `reject` davranışını doğrula.
5. Sonra policy'yi takım modül sınırlarına göre daralt.
