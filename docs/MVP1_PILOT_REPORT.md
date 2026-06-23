# MVP-1 Pilot Report

Bu rapor, MVP-0'dan sonra eklenen ilk pilot-readiness katmanını açıklar.
Amaç, runtime'ın sadece basit örneklerde değil, daha kurumsal PR review
senaryolarında da ölçülebilir kararlar üretebildiğini göstermektir.

## Araştırma/Ürün Sorusu

MVP-1'in ana sorusu:

```text
Bounded Agent Runtime, enterprise-style policy ve ownership sinyalleriyle
PR patch'lerini doğru şekilde approve/refuse/reject/remask/human-review
kararlarına ayırabiliyor mu?
```

Bu soru model kalitesi ölçmez. Bu aşamada test edilen şey deterministic runtime
contract'ıdır:

- policy parsing,
- allowed/forbidden scope,
- ownership authority,
- sensitive boundary,
- paired-file remask,
- missing authority refusal,
- human-review fallback.

## Pilot Suite

Pilot suite şu karar ailelerini kapsar:

| Family | Amaç |
| --- | --- |
| `approve` | Yetkili, scope-safe değişiklik geçebilmeli. |
| `remask` | Lokal/paired-file eksik varsa full reject yerine repair önerilmeli. |
| `reject` | Forbidden path veya sensitive boundary ihlali merge öncesi durmalı. |
| `refuse` | Eksik owner/product authority varsa agent tahmin yürütmemeli. |
| `human_review` | Otomatik karar için yeterli diff sinyali yoksa insana gitmeli. |

Çalıştırma:

```bash
npm run product:pilot -- --out-dir reports/product-runtime --fail-on-regression
```

## Metrikler

| Metric | Anlamı |
| --- | --- |
| Decision accuracy | Runtime kararı beklenen kararla eşleşti mi? |
| False positive rate | Approve olması gereken case gereksiz bloklandı mı? |
| False refusal rate | Refuse dışı beklenen case yanlışlıkla refuse oldu mu? |
| Missed blocker rate | Bloklanması gereken case yanlışlıkla approve oldu mu? |
| Expected finding coverage | Beklenen finding kategorileri üretildi mi? |

Bu metrikler ürün açısından önemlidir çünkü tek başına “risk yakaladı” demek
yeterli değildir. Aşırı engelleyen bir runtime ekipleri yavaşlatır; fazla
kaçıran bir runtime ise güven vermez.

## Ownership Neden Eklendi?

MVP-0'da allowed path kontrolü vardı. Fakat kurumsal hayatta dosyanın allowed
olması tek başına yeterli değildir:

```text
packages/billing/** allowed olabilir,
ama billing-team authority yoksa agent o modülde karar vermemelidir.
```

MVP-1 bu yüzden `policy.ownership` alanını aktif verifier sinyaline dönüştürür.
Owned path değiştiğinde task içinde ilgili owner authority yoksa runtime
`refuse` üretir.

## Beklenen Yorum

İdeal MVP-1 pilot sonucu:

- decision accuracy yüksek,
- false positive düşük,
- false refusal düşük,
- missed blocker sıfır,
- ownership finding doğru case'lerde görünür.

Bu sonuç şu iddiayı destekler:

```text
Runtime, model üretiminden bağımsız olarak enterprise boundary ve authority
kararlarını deterministik şekilde görünür kılabilir.
```

Bu sonuç şunu kanıtlamaz:

- Gerçek tüm enterprise repo'larda yeterlidir.
- Security guarantee verir.
- Full repo graph/ownership inference çözüldü.
- dLLM verifier adapter hazırdır.
- İnsan review gereksizdir.

## Ürün Kararı

MVP-1 sonrası ürün yönü daha nettir:

1. CLI + GitHub Action ürün yüzeyi korunmalı.
2. Policy/ownership contract genişletilmeli.
3. Pilot suite farklı repo ailelerine yayılmalı.
4. LLM/dLLM-style verifier adapter sonra eklenmeli.
5. Dashboard/SDK ancak pilot davranışları stabil hale geldikten sonra gelmeli.

Kısaca:

```text
MVP-1, "runtime çalışıyor mu?" sorusundan
"runtime gerçek PR policy sinyallerini ölçülebilir yönetiyor mu?"
sorusuna geçiştir.
```
