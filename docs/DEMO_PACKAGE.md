# Bounded Agent Runtime Demo Package

Bu demo paketi, projeyi bir hocaya, reviewer'a veya erken kullanıcıya
göstermek için kısa ve kontrollü bir akış sunar.

## Demo Mesajı

```text
Bu proje yeni bir IDE veya model router değildir.
Amaç, kurumsal agentic coding akışında context, authority, ownership,
scope ve repair kararlarını ölçülebilir bir runtime katmanına taşımaktır.
```

## 1. Temel Doğrulama

```bash
npm install
npm run typecheck
npm run build
npm run test:smoke
```

Anlatılacak şey:

- Kod compile oluyor.
- Smoke contract'ları geçiyor.
- Research lab ve product runtime contract'ları kırılmamış.

## 2. Policy Onboarding

```bash
npm run product:policy -- \
  --init \
  --out /tmp/bounded-agent.policy.yml \
  --format both

npm run product:policy -- \
  --validate \
  --policy /tmp/bounded-agent.policy.yml \
  --format markdown
```

Anlatılacak şey:

- Policy, agent'ın sınırıdır.
- Quality score policy'nin ne kadar pilot-ready olduğunu gösterir.
- Bu score güvenlik garantisi değil, onboarding sinyalidir.

## 3. Tek PR Review Örneği

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

Anlatılacak şey:

- Patch tamamen reddedilmiyor.
- Eksik paired-file bölgesi lokal repair olarak işaretleniyor.
- Bu, remask fikrinin ürün runtime karşılığıdır.

## 4. MVP-1 Pilot

```bash
npm run product:pilot -- \
  --out-dir /tmp/bounded-mvp1-pilot \
  --fail-on-regression
```

Anlatılacak şey:

- Enterprise-style controlled senaryolar.
- Ownership, refusal, reject, remask, human-review kararları ölçülüyor.
- False positive, false refusal, missed blocker metrikleri üretiliyor.

## 5. MVP-2 Pilot

```bash
npm run product:pilot-v2 -- \
  --out-dir /tmp/bounded-mvp2-pilot \
  --fail-on-regression
```

Anlatılacak şey:

- External/OSS-style senaryolara geçildi.
- Owner alias ve required test mapping eklendi.
- Policy quality score rapora girdi.

## 6. GitHub Action Contract

```bash
npm run product:action-smoke
```

Anlatılacak şey:

- Action'ın beklenen artifact zinciri lokal doğrulanıyor.
- Review JSON, Markdown, PR comment ve report index üretiliyor.

## Kısa Sonuç Cümlesi

```text
MVP-2, bounded-context agent orchestration fikrini deterministik policy,
ownership, test mapping, remask ve PR artifact contract'larıyla pilot adayı
seviyesine taşır.
```

## Dürüst Sınırlar

- Production-ready SaaS değildir.
- Dashboard yoktur.
- IDE adapter yoktur.
- Gerçek repo graph inference yoktur.
- dLLM verifier adapter henüz ürün runtime'a bağlanmamıştır.
- İnsan review yerine geçmez.

## Sonraki Demo İçin En Mantıklı Adım

Bir gerçek açık kaynak repo veya küçük private test repo üzerinde:

1. Policy dosyası yaz.
2. 10-20 gerçek PR diff'i topla.
3. Runtime kararlarını human reviewer kararlarıyla karşılaştır.
4. False positive ve missed blocker oranlarını raporla.
