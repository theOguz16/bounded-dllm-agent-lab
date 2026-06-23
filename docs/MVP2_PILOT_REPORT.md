# MVP-2 Pilot Report

MVP-2, MVP-1'in kontrollü enterprise pilotunu daha dış-repo benzeri bir
senaryoya taşır. Bu aşama hâlâ gerçek production pilot değildir; fakat bir
consumer repository'nin GitHub Action üzerinden alacağı sinyalleri daha iyi
temsil eder.

## MVP-2'de Eklenenler

| Özellik | Neden Eklendi? |
| --- | --- |
| Policy quality score | Policy dosyasının fazla boş veya zayıf olup olmadığını görünür yapmak için. |
| Owner aliases | `billing-team` yerine `billing`, `payments`, `runtime` gibi gerçek dil varyasyonlarını desteklemek için. |
| Required test mappings | Değişen path için beklenen test sinyalini path-aware kontrol etmek için. |
| External-style pilot | NanoID/OSS benzeri repo davranışlarını kontrollü şekilde ölçmek için. |
| Demo package | Öğretmen, reviewer veya erken kullanıcıya iddiayı kontrollü anlatmak için. |

## Çalıştırma

```bash
npm run product:pilot-v2 -- \
  --out-dir reports/product-runtime \
  --fail-on-regression
```

## Ölçülen Metrikler

| Metric | Anlamı |
| --- | --- |
| Decision accuracy | Beklenen karar ile runtime kararı eşleşiyor mu? |
| False positive rate | Geçmesi gereken patch yanlış engellendi mi? |
| False refusal rate | Refuse olmaması gereken patch yanlış refuse edildi mi? |
| Missed blocker rate | Bloklanması gereken patch yanlış approve edildi mi? |
| Expected finding coverage | Beklenen finding kategorileri üretildi mi? |
| Policy quality score | Policy dosyası temel ürün sinyallerini ne kadar kapsıyor? |

## Beklenen İdeal Sonuç

```text
Decision accuracy: 100%
False positive rate: 0%
False refusal rate: 0%
Missed blocker rate: 0%
Expected finding coverage: 100%
Policy quality grade: strong
```

Bu sonuç, runtime'ın controlled external-style senaryolarda beklenen kararları
üretebildiğini gösterir.

## Ne Kanıtlar?

- Policy quality sinyali üretilebilir.
- Owner alias ile authority kontrolü daha gerçekçi hale gelir.
- Required test mapping ile source/test eksikleri yakalanabilir.
- External-style PR senaryoları tek komutla raporlanabilir.
- GitHub Action consumer deneyimine daha yakın bir contract oluşur.

## Ne Kanıtlamaz?

- Gerçek tüm repo'larda false positive düşük kalır demek değildir.
- Full repo graph çıkarımı yapıldığını göstermez.
- Security/compliance garantisi değildir.
- LLM/dLLM verifier adapter'ın hazır olduğunu göstermez.
- İnsan review ihtiyacını ortadan kaldırmaz.

## Ürün Yorumu

MVP-2 sonrası ürün şu seviyeye gelir:

```text
Developer Preview -> Pilot Candidate
```

Yani ürün hâlâ erken aşamadadır; fakat artık sadece kendi fixture'larımızda
çalışan bir CLI değil, external repo adoption rehberi, action contract smoke'u,
policy quality score'u ve pilot v2 raporu olan bir pilot adayına dönüşür.
