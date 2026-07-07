# Phase O 12-Case Live Benchmark Sonuçları

## Özet

Phase O.1 kapsamında, Phase N'de hazırlanan 12-case live benchmark runner gerçek RunPod ortamında Qwen2.5-Coder-7B ve Dream-Coder-v0-Instruct-7B endpointleriyle çalıştırıldı.

Amaç, bounded-agent verifier-style case setinde iki model slotunun karar uyumu, JSON compliance, latency ve token davranışını gözlemlemekti.

Bu çalışma yeni bir model üstünlüğü iddiası üretmek için değil, canlı benchmark yüzeyinin gerçekten çalıştığını ve model davranışlarının ölçülebilir hale geldiğini göstermek için yapılmıştır.

## Deney Ortamı

```text
Provider: RunPod
GPU: NVIDIA RTX 3090 24 GB
LLM slot: Qwen2.5-Coder-7B GGUF via llama.cpp
dLLM/verifier slot: Dream-Coder-v0-Instruct-7B via custom OpenAI-compatible server
Qwen endpoint: http://127.0.0.1:8000/v1/chat/completions
Dream endpoint: http://127.0.0.1:8002/v1/chat/completions
Benchmark command: npm run report:live-mini-benchmark
Case count: 12
Result count: 24
```

## Live Acceptance

Benchmark öncesinde iki endpoint için live acceptance çalıştırıldı.

```text
status: completed
required: true
configuredWorkerCount: 2
skippedWorkerCount: 0
failedWorkerCount: 0
acceptanceExitCode: 0
```

Acceptance sonucunda iki endpoint de canlı model-worker yüzeyinde kullanılabilir durumda göründü.

## 12-Case Benchmark Sonucu

Benchmark tamamlandı:

```text
ok: true
status: completed
expectationsOk: false
```

`expectationsOk: false` olmasının sebebi, Dream-Coder çıktılarının çoğunda parse edilebilir JSON decision bulunamamasıdır.

## Model Bazlı Özet

| Model Slot | Model | Result Count | Completed | Expected Match Rate | JSON Compliance Rate | Avg Latency | Avg Total Tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| LLM | qwen2.5-coder-7b | 12 | 12 | 100% | 100% | 385 ms | 310 |
| dLLM/verifier | dream-coder-v0-instruct-7b | 12 | 12 | 16.67% | 16.67% | 69,336 ms | 0 |

## Qwen Sonucu

Qwen2.5-Coder-7B, 12 case'in tamamında expected decision setiyle uyumlu karar verdi.

```text
expectedMatchedCount: 12 / 12
expectedMatchRate: 1.0
jsonComplianceCount: 12 / 12
jsonComplianceRate: 1.0
averageLatencyMs: 385
averagePromptTokens: 266
averageCompletionTokens: 44
averageTotalTokens: 310
```

Karar dağılımı:

```text
approve: 4
needs_review: 5
reject: 3
```

Bu sonuç, Qwen'in mevcut benchmark prompt contract'ına ve JSON output beklentisine güçlü şekilde uyduğunu göstermektedir.

## Dream-Coder Sonucu

Dream-Coder endpoint'i 12 case'in tamamını tamamladı, fakat yalnızca 2 case'te parse edilebilir JSON decision üretildi.

```text
expectedMatchedCount: 2 / 12
expectedMatchRate: 0.1667
jsonComplianceCount: 2 / 12
jsonComplianceRate: 0.1667
averageLatencyMs: 69336
averagePromptTokens: 0
averageCompletionTokens: 0
averageTotalTokens: 0
```

Karar dağılımı:

```text
unknown: 10
approve: 1
reject: 1
```

Bu sonuç, Dream-Coder'ın çalışmadığı anlamına gelmez. Endpoint tamamlandı ve yanıt döndürdü. Fakat mevcut OpenAI-compatible wrapper + prompt contract altında çoğu case için benchmark'ın beklediği JSON decision contract'ına uyamadı.

## Case Ailesi Gözlemleri

### Safe Cases

Safe case ailesinde Qwen tüm case'lerde `approve` üretti ve expected decision setiyle uyumlu kaldı.

Dream tarafında yalnızca `test-only-safe-change` case'i JSON compliant `approve` üretti. Diğer safe case'lerde decision parse edilemedi.

### Scope / Review Risk Cases

Scope broadening, unrelated package change, unresolved remask, stale authority, generated file touch ve dependency risk case'lerinde Qwen `needs_review` veya `reject` kararlarıyla expected set içinde kaldı.

Dream tarafında bu case'lerin çoğu `unknown` olarak kaldı. Bu, modelin riskli durumları anlamadığı anlamına gelmeyebilir; ancak mevcut contract altında ölçülebilir karar üretemediğini gösterir.

### Reject Cases

Qwen, `prod-infra-touch` ve `secret-env-line` gibi yüksek riskli case'lerde `reject` verdi.

Dream, `prod-infra-touch` case'inde `reject` ile expected decision üretti; ancak `secret-env-line` case'inde parse edilebilir decision üretilemedi.

## İlk Bulgular

Bu run'dan çıkarılabilecek güvenli bulgular:

1. Qwen2.5-Coder-7B, mevcut benchmark contract'ına çok güçlü uyum gösterdi.
2. Qwen, 12/12 expected decision match ve 12/12 JSON compliance elde etti.
3. Qwen latency değeri bu serving stack altında oldukça düşük göründü.
4. Dream-Coder endpoint'i çalıştı ve 12 case'i tamamladı.
5. Dream-Coder mevcut wrapper/prompt contract altında çoğu case'te parse edilebilir JSON decision üretemedi.
6. Dream latency değeri Qwen'e göre çok daha yüksekti.
7. Dream token usage değeri raporda 0 göründü; bu wrapper/proxy usage parsing uyumsuzluğuna işaret ediyor olabilir.

## Güvenli Araştırma Yorumu

Bu run için güvenli yorum şudur:

```text
12-case canlı benchmark koşusunda Qwen2.5-Coder-7B, bounded-agent decision contract'ına Dream-Coder'dan çok daha iyi uydu. Dream-Coder endpoint'i çalıştı ve tüm case'leri tamamladı; ancak mevcut OpenAI-compatible wrapper ve prompt contract altında çoğu çıktıda parse edilebilir JSON decision üretemedi.
```

Bu sonuç şu anlama gelmez:

```text
Qwen her açıdan Dream'den üstündür.
dLLM yaklaşımı başarısızdır.
Dream-Coder verifier rolünde kullanılamaz.
```

Daha doğru çıkarım:

```text
Dream-Coder'ın adil değerlendirilebilmesi için önce output contract, wrapper ve prompt formatı iyileştirilmelidir. Bu iyileştirmeden sonra aynı 12-case benchmark tekrar çalıştırılmalıdır.
```

## Limitasyonlar

- Bu run tek seferliktir.
- Aynı 12-case benchmark tekrarlı çalıştırılmamıştır.
- Dream-Coder özel OpenAI-compatible wrapper üzerinden sunulmuştur.
- Dream token usage değerleri 0 görünmektedir; wrapper/proxy usage uyumsuzluğu olabilir.
- Dream'in düşük skoru model kapasitesinden ziyade JSON contract uyumsuzluğundan kaynaklanıyor olabilir.
- Latency farkı model mimarisi, quantization, serving stack ve generation method farklarından etkilenir.
- Case seti bounded-agent verifier-style görevleri temsil eder; genel kod yazma başarısını ölçmez.

## Sonraki Adım

Bir sonraki teknik adım:

```text
Phase O.2 — Dream output contract / wrapper improvement
```

Yapılacaklar:

- Dream server wrapper response formatını proxy ve benchmark parser ile uyumlu hale getir.
- Dream output için daha güçlü JSON-only prompt contract dene.
- Token usage alanlarını doğru döndür.
- Gerekirse max token / steps / temperature ayarlarını benchmark'a göre optimize et.
- 12-case benchmark'ı tekrar çalıştır.
- Dream'in JSON compliance ve expected match oranı iyileşiyor mu ölç.

## Phase O.1 Durumu

```text
12-case live benchmark run: tamamlandı
Qwen result: güçlü
Dream result: contract uyumsuzluğu tespit edildi
Artifact üretimi: tamamlandı
Sonraki adım: Dream contract fix + rerun
```


---

## Phase O.3 Rerun Sonucu — Parser Hardening Sonrası

Phase O.2'de live benchmark parser'ı plain JSON, fenced JSON ve gömülü JSON cevaplarını daha iyi yakalayacak şekilde sertleştirildi. Ardından aynı Qwen + Dream 12-case benchmark RunPod üzerinde tekrar çalıştırıldı.

## O.3 Özet Sonuç

```text
Benchmark status: completed
expectationsOk: false
Case count: 12
Result count: 24
```

## O.3 Model Bazlı Sonuç

| Model Slot | Model | Expected Match Rate | JSON Compliance Rate | Avg Latency | Decision Counts |
| --- | --- | ---: | ---: | ---: | --- |
| LLM | qwen2.5-coder-7b | 100% | 100% | 409 ms | approve: 4, needs_review: 5, reject: 3 |
| dLLM/verifier | dream-coder-v0-instruct-7b | 8.33% | 8.33% | 82,774 ms | approve: 1, unknown: 11 |

## O.1 ve O.3 Karşılaştırması

| Model | Metric | O.1 | O.3 |
| --- | --- | ---: | ---: |
| Qwen | Expected Match Rate | 100% | 100% |
| Qwen | JSON Compliance Rate | 100% | 100% |
| Qwen | Avg Latency | 385 ms | 409 ms |
| Dream | Expected Match Rate | 16.67% | 8.33% |
| Dream | JSON Compliance Rate | 16.67% | 8.33% |
| Dream | Unknown Decisions | 10 / 12 | 11 / 12 |
| Dream | Avg Latency | 69,336 ms | 82,774 ms |

## O.3 Yorumu

Phase O.3 sonucu, Phase O.2 parser hardening değişikliğinin Qwen tarafında stabiliteyi bozmadığını gösterdi. Qwen yine 12/12 expected match ve 12/12 JSON compliance elde etti.

Dream-Coder tarafında ise beklenen iyileşme görülmedi. Dream 12 case'in tamamını tamamladı fakat yalnızca 1 case'te parse edilebilir ve expected set ile uyumlu decision üretti. 11 case `unknown` kaldı.

Bu nedenle güvenli çıkarım şudur:

```text
Dream-Coder'ın düşük benchmark uyumu yalnızca parser eksikliğinden kaynaklanmıyor. Mevcut Dream wrapper, prompt contract ve generation davranışı altında model çoğu case'te structured JSON decision üretmiyor.
```

Bu sonuç hâlâ şu anlama gelmez:

```text
Dream-Coder genel olarak başarısızdır.
dLLM yaklaşımı başarısızdır.
Qwen her açıdan Dream'den üstündür.
```

Daha doğru sonuç:

```text
Qwen2.5-Coder-7B mevcut bounded-agent decision contract'ına stabil şekilde uyuyor. Dream-Coder ise bu contract altında ölçülebilir verifier davranışı üretmek için wrapper-level veya generation-level iyileştirme gerektiriyor.
```

## Sonraki Teknik Adım

Bir sonraki adım parser değil, Dream wrapper seviyesidir:

```text
Phase O.4 — Dream wrapper-level repair
```

O.4'te hedef:

- Dream raw output örneklerini incelemek
- Dream için daha kısa ve daha sert JSON-only prompt denemek
- Gerekirse wrapper içinde post-processing veya retry stratejisi eklemek
- Token usage alanlarını düzeltmek
- Sadece Dream-focused mini rerun ile unknown oranını düşürmeye çalışmak
---

## Phase O.5 Rerun Sonucu — Repaired Dream Wrapper Sonrası

Phase O.5'te, Phase O.4'te düzeltilen Dream wrapper ile aynı 12-case Qwen + Dream live benchmark tekrar çalıştırıldı.

Bu rerun'un amacı model kalitesini genel olarak ölçmek değil, şu üç teknik soruya cevap vermekti:

```text
1. Dream token usage artık 0 olmaktan çıktı mı?
2. Dream latency düştü mü?
3. Dream structured JSON decision contract'a daha iyi uydu mu?
```

## O.5 Özet Sonuç

```text
Benchmark status: completed
expectationsOk: false
Case count: 12
Result count: 24
```

## O.5 Model Bazlı Sonuç

| Model Slot | Model | Expected Match Rate | JSON Compliance Rate | Avg Latency | Avg Total Tokens | Decision Counts |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| LLM | qwen2.5-coder-7b | 100% | 100% | 385 ms | 405 | approve: 4, needs_review: 5, reject: 3 |
| dLLM/verifier | dream-coder-v0-instruct-7b | 8.33% | 8.33% | 19,066 ms | 537 | unknown: 11, needs_review: 1 |

## O.3 ve O.5 Karşılaştırması

| Model | Metric | O.3 | O.5 | Yorum |
| --- | --- | ---: | ---: | --- |
| Qwen | Expected Match Rate | 100% | 100% | Stabil kaldı |
| Qwen | JSON Compliance Rate | 100% | 100% | Stabil kaldı |
| Qwen | Avg Latency | 409 ms | 385 ms | Benzer / hafif daha iyi |
| Qwen | Avg Total Tokens | 406 | 405 | Neredeyse aynı |
| Dream | Expected Match Rate | 8.33% | 8.33% | Düzelmedi |
| Dream | JSON Compliance Rate | 8.33% | 8.33% | Düzelmedi |
| Dream | Unknown Decisions | 11 / 12 | 11 / 12 | Düzelmedi |
| Dream | Avg Latency | 82,774 ms | 19,066 ms | Belirgin iyileşti |
| Dream | Avg Total Tokens | 0 | 537 | Token accounting düzeldi |

## O.5 Yorumu

Phase O.5 sonucu, Phase O.4 Dream wrapper repair değişikliğinin iki konuda işe yaradığını gösterdi:

```text
1. Dream artık prompt/completion/total token usage alanlarını 0 yerine gerçek değerlerle döndürüyor.
2. Dream ortalama latency yaklaşık 82.7 saniyeden 19.1 saniyeye düştü.
```

Ancak structured decision davranışı düzelmedi:

```text
Dream JSON compliance 8.33% seviyesinde kaldı.
Dream expected match rate 8.33% seviyesinde kaldı.
Dream 12 case'in 11'inde unknown/unparseable decision üretti.
```

Bu nedenle O.5'in güvenli çıkarımı şudur:

```text
O.4 wrapper repair, Dream endpoint davranışını ölçülebilir ve daha hızlı hale getirdi; fakat Dream'in JSON-only bounded verifier contract'a uyum problemini çözmedi.
```

Bu sonuç şunu destekler:

```text
Bir sonraki teknik çalışma parser hardening değil, Dream output-contract / generation-control tarafında olmalıdır.
```

## O.5 Sonrası Teknik Karar

Phase O.5'ten sonra iki yol var:

```text
Yol A — Dream'i current verifier contract altında bırakmak:
Dream düşük JSON compliance nedeniyle ana karşılaştırmalı verifier olarak kullanılmaz; sadece negative/diagnostic baseline olarak raporlanır.

Yol B — Dream için output-contract repair deneyi yapmak:
Dream'e özel daha kısa prompt, retry, constrained wrapper veya post-hoc JSON extraction stratejileri denenir.
```

Araştırma açısından en doğru sonraki adım:

```text
Phase O.6 — Dream output-contract repair probe
```

O.6'nın hedefi benchmark parser'ı değiştirmek değil, Dream'in structured JSON decision üretmesini sağlayacak minimal ve dürüst bir generation-control yaklaşımı denemektir.


## Phase O.8 — Compact Payload Clean Rerun

O.8 deneyinde verifier prompt'u korunurken user payload formatı daha kompakt metin tabanlı hale getirildi. Amaç, Dream'in büyük JSON input'u kopyalama davranışını azaltmak ve output contract uyumunu artırmaktı.

Temiz O.8 koşusunda Qwen tarafı tekrar stabil kaldı:

- Completed: 12/12
- Expected match: 12/12
- JSON compliance: 12/12
- Average latency: 350 ms

Dream tarafında ise kompakt payload güvenilir bir iyileştirme sağlamadı:

- Completed: 12/12
- Expected match: 2/12
- JSON compliance: 2/12
- Unknown: 10/12
- Average latency: 25.38 s

Bu sonuç, problemin yalnızca input formatından kaynaklanmadığını gösteriyor. Dream çoğu case'te hâlâ `To determine...`, `In the context...` gibi prose çıktılarla başlıyor ve istenen JSON output contract'ını takip edemiyor.

O.8 sonucu bu yüzden pozitif bir iyileştirme değil, negatif/kararsız deney sonucu olarak değerlendirildi. Qwen aynı koşulda 12/12 stabil kalırken Dream'in düşük kalması, bu verifier görevinde Dream'in output-contract adherence tarafının zayıf olduğunu gösteriyor.

Sonraki adım olarak O.9'da format-following ile decision-quality ayrıştırılmalıdır. Bunun için Dream'den tam JSON yerine yalnızca tek karar token'ı (`approve`, `needs_review`, `reject`) istenen ayrı bir diagnostic mode eklenmesi önerilir.


## Phase O.9 — Decision Token Diagnostic Benchmark

O.9 deneyinde format-following problemi ile decision-quality problemi ayrıştırıldı. Bu benchmark'ta modellerden tam JSON nesnesi üretmeleri istenmedi; yalnızca tek karar token'ı üretmeleri istendi:

- `approve`
- `needs_review`
- `reject`

Script daha sonra bu token'ı parse ederek karar kalitesini ölçtü. Böylece JSON üretme zorluğu benchmark'tan çıkarıldı.

Qwen sonuçları:

- Completed: 12/12
- Parsed decision: 12/12
- Expected match: 12/12
- Token compliance: 12/12
- Average latency: 71.08 ms
- Average completion tokens: 2.42

Dream sonuçları:

- Completed: 12/12
- Parsed decision: 0/12
- Expected match: 0/12
- Token compliance: 0/12
- Unknown: 12/12
- Average latency: 12.74 s
- Average completion tokens: 16

Bu sonuç, Dream tarafındaki problemin yalnızca JSON output contract uyumsuzluğu olmadığını gösterdi. Format yükü minimuma indirildiğinde bile Dream çoğu çıktıda `To evaluate...`, `To determine...`, `Let's analyze...` gibi açıklama/prose üretmeye devam etti ve tek karar token'ı üretemedi.

Bu nedenle O.9 sonucuna göre Dream'in bu bounded verifier görevinde hem output-contract adherence hem de constrained decision-token following açısından zayıf kaldığı değerlendirildi. Qwen ise aynı koşulda hem format hem karar kalitesi açısından 12/12 stabil kaldı.

O.9, çalışmanın ana çıkarımını güçlendirmektedir: Bu görevde Qwen tabanlı LLM verifier pratik olarak kullanılabilir davranış gösterirken, Dream-Coder v0 Instruct 7B mevcut wrapper ve prompt rejimiyle güvenilir bounded verifier olarak kullanılamamaktadır.

