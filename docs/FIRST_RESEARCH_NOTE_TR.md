# Dar Baglamli Agentic Coding Icin Bounded dLLM ve Hybrid Agent Mimarisi

## Ozet

Bu calisma, agentic coding araclarinda sik gorulen scope drift, gereksiz kod
degisikligi, yetersiz baglamda tahmin yurutme ve kurumsal sinir ihlali
problemlerini incelemek icin gelistirilen acik kaynakli bir arastirma laboratuvaridir.

Calismanin amaci sifirdan yeni bir buyuk dil modeli egitmek degildir. Daha dar
ve olculebilir bir soru soruyoruz:

```text
Dar ve kontrollu context paketleri, shared workspace, mask/remask politikasi ve
dLLM-style refinement yaklasimlari agentic coding sistemlerinde daha scope-safe,
daha traceable ve daha az tahmine dayali sonuclar uretebilir mi?
```

Ilk fazda hem davranis benchmarklari hem de gercek bir open-source repository
uzerinde code patch benchmarklari gelistirildi. Sonuclar, tek bir modelin her
rolde kazanmasindan cok, farkli model ve agent rollerinin farkli failure mode'lara
sahip oldugunu gosterdi. Bu nedenle calisma ikinci fazda hybrid bir mimariye
evrilmelidir: autoregressive coder model patch uretir, dLLM veya dLLM-style
agent ise verifier, boundary checker ve remask planner olarak calisir.

## Motivasyon

Gunumuz agentic coding araclari oldukca kullanisli hale geldi. Fakat bu araclar
kurumsal yazilim gelistirme ortamlarinda bazi temel sorunlarla karsilasiyor:

- Model istenen degisikligi yaparken komsu scope'lara tasabiliyor.
- Eksik baglam oldugunda durmak yerine tahmin yurutebiliyor.
- Buyuk context pencereleri maliyeti artiriyor fakat her zaman daha guvenilir
  sonuc uretmiyor.
- Birden fazla agent veya model kullanildiginda ortak bir workspace yerine daha
  cok model-switching akisi olusuyor.
- Kurumsal moduller dar sahiplik sinirlarina sahip oldugu icin agent'in her seye
  dokunmasi kabul edilebilir degil.

Bu problem ozellikle modern yazilim organizasyonlarinda onemlidir. Bir ekip
sadece billing modulunden, digeri auth modulunden, bir baskasi deployment veya
mobile shell kararlarindan sorumlu olabilir. Agent'in iyi kod yazmasi tek basina
yeterli degildir; agent'in hangi karari vermeye yetkisi olmadigini da bilmesi
gerekir.

Bu calisma bu nedenle "daha akilli tek model" sorusundan cok "daha dogru
agent mimarisi" sorusuna odaklanir.

## Arastirma Sorusu

Ana arastirma sorusu:

```text
Dar context, synthetic context enrichment, shared semantic workspace ve
mask/remask tabanli agent akislari; uzun context'e yaslanan autoregressive LLM
agentlarina gore daha scope-aware, traceable ve boundary-safe sonuclar verebilir mi?
```

Bu sorunun alt sorulari sunlardir:

1. Bounded context agent'in scope drift davranisini azaltir mi?
2. Synthetic context paketleri eksik baglamda daha iyi karar verilmesini saglar mi?
3. dLLM-style masked refinement, code ve workspace region repair icin uygun bir
   agent rolu saglar mi?
4. Bir model iyi kod yazarken ayni zamanda iyi boundary/refusal karari verebilir mi?
5. Hybrid bir mimari, tek modelden daha iyi agentic coding davranisi uretebilir mi?

## Mimari Yaklasim

Bu projedeki temel fikir, agent'i yalnizca uzun prompt alan ve cevap ureten bir
model olarak gormemektir. Bunun yerine agent'in calistigi alan structured bir
workspace olarak modellenir.

Workspace su bilgileri tasir:

- task intent,
- allowed scope,
- forbidden scope,
- relevant facts,
- stale facts,
- sensitive boundaries,
- uncertainty records,
- agent claims,
- patch intent,
- verifier results,
- remask regions,
- final decision.

Bu yaklasimda farkli agent rolleri ayni workspace uzerinde farkli mask view'larla
calisabilir:

- Planner agent hedef ve riskleri doldurur.
- Implementer agent patch niyetini uretir.
- Boundary agent baglam yeterli mi degil mi karar verir.
- Verifier agent patch veya kararin sinirlara uyup uymadigini kontrol eder.
- Remask planner sadece hatali veya belirsiz bolgeyi yeniden uretime acar.

Bu, klasik "X model dusunsun, Y model kodlasin" model-switching yaklasimindan
farklidir. Buradaki asil hedef ortak bir semantic workspace ve agent rollerinin
birbirinin isini ezmeden ayni karar alani uzerinde calisabilmesidir.

## Deney Tasarimi

Ilk fazda iki ana benchmark ailesi gelistirildi.

### 1. Davranis Benchmarklari

Davranis benchmarklari agent'in kod yazmasindan once karar verme davranisini
olcer:

- correction override,
- sensitive boundary,
- scope drift,
- insufficient context,
- conflict resolution.

Bu benchmarklar su metrikleri uretir:

- task success rate,
- required term coverage,
- forbidden term hit rate,
- scope drift rate,
- sensitive leakage rate,
- boundary accuracy,
- evidence coverage,
- trace completeness.

### 2. Code Patch Benchmarklari

Gercek kod davranisini olcmek icin `ai/nanoid` open-source repository'si uzerinde
deterministik code patch benchmarklari hazirlandi.

Code patch benchmarklari uc gerceklik seviyesine ayrildi:

| Reality level | Amac |
| --- | --- |
| `micro_patch` | Kucuk ve dar kapsamli tek dosya editlerini olcmek. |
| `module_patch` | Birden fazla dosyada tutarli ama sinirli module degisikligini olcmek. |
| `enterprise_boundary` | Eksik karar, yetki veya compliance baglaminda modelin durup durmadigini olcmek. |

Bu benchmarklarda modelin sadece test gecip gecmedigine bakilmadi. Su metrikler
de takip edildi:

- patch pass rate,
- expected file coverage,
- allowed file accuracy,
- forbidden file touch rate,
- forbidden pattern hit rate,
- refusal accuracy,
- invalid model output,
- failure taxonomy.

Bu onemli cunku agentic coding'de "test geciyor" her zaman yeterli degildir.
Agent yanlis yetkiyle dogru calisan kod da yazabilir.

## Ilk Bulgular

### Bulgu 1: Qwen2.5-Coder scoped implementation tarafinda guclu

Qwen2.5-Coder 7B GGUF, Nano ID code patch benchmarkinda micro ve module patch
seviyelerinde guclu performans gosterdi.

Ozet:

| Strategy | Patch pass | Refusal | Boundary guess |
| --- | ---: | ---: | ---: |
| Qwen2.5 plain | 78% | 80% | 10 |
| Qwen2.5 synthetic | 78% | 80% | 10 |
| Qwen2.5 expanded | 84% | 86% | 7 |
| Qwen2.5 RAG | 80% | 82% | 9 |

Micro ve module patch seviyesinde model oldukca basariliydi. Bu bize sunu
gosterir:

```text
Qwen2.5-Coder kod yazma ve dar scoped patch uretme tarafinda guclu bir
implementation agent adayidir.
```

### Bulgu 2: Qwen2.5-Coder enterprise boundary/refusal tarafinda zayif

Ayni model enterprise-boundary case'lerinde sistematik olarak zorlandi. Dogru
davranis, eksik urun veya compliance karari varken patch uretmemekti. Fakat model
cogu durumda `20`, `22`, `24` gibi degerler tahmin ederek runtime veya type
dosyalarini degistirmeye calisti.

Bu sonucun anlami:

```text
Model kod yazabiliyor, fakat ne zaman kod yazmamasi gerektigini her zaman
bilmiyor.
```

Bu agentic coding icin kritik bir ayrimdir. Kurumsal ortamda yanlis karar uzerine
dogru calisan patch uretmek yine de basarisiz bir agent davranisidir.

### Bulgu 3: Expanded context yardim etti ama problemi cozmedi

Expanded context, Qwen2.5-Coder icin patch pass oranini 78%'den 84%'e cikardi ve
boundary guess sayisini 10'dan 7'ye dusurdu.

Bu olumlu bir sinyaldir, fakat yeterli degildir:

```text
Expanded context enterprise-boundary davranisini iyilestirdi, fakat eksik
authority/refusal problemini cozmedi.
```

Bu bize context stratejisinin task tipine bagli oldugunu gosterir. Davranis
benchmarkinda expanded context auditability'yi zayiflatirken, code patch
benchmarkinda boundary davranisini kismen iyilestirdi.

### Bulgu 4: Synthetic context'in mevcut hali yeterli degil

Synthetic context Qwen2.5-Coder'da enterprise-boundary sonucunu iyilestirmedi:

```text
plain boundary guess: 10 / 10
synthetic boundary guess: 10 / 10
```

Bu negatif sonuc degerlidir. Mevcut synthetic context paketi yalnızca task,
allowed files, forbidden files ve genel disiplin bilgisi veriyor. Fakat modelin
eksik authority durumunda durmasi icin daha guclu ve policy-like bir synthetic
context gerekiyor.

Bir sonraki synthetic context paketi su kurallari daha acik tasimalidir:

- urun karari eksikse patch uretme,
- compliance karari eksikse patch uretme,
- runtime default degeri tahmin etme,
- allowed file olmak tek basina edit yetkisi anlamina gelmez,
- karar eksikse machine-readable refusal uret.

### Bulgu 5: Dream-Coder dLLM direct patch writer olarak zayif kaldi

Dream-Coder dLLM worker, direct code patch benchmarkinda 50 case'in 42'sinde
machine-readable patch/refusal contract'ini saglayamadi.

Ozet:

| Worker | Patch pass | Invalid contract |
| --- | ---: | ---: |
| Dream-Coder dLLM | 12% | 42 / 50 |

Bu, Dream-Coder'in tamamen degersiz oldugu anlamina gelmez. Daha dogru yorum:

```text
Mevcut Dream-Coder worker direct implementation agent olarak zayif, fakat
verifier, boundary checker, critique agent veya remask planner rolu icin hala
arastirmaya deger.
```

Dream-Coder cogu zaman gorevi aciklayabiliyor, fakat benchmarkin istedigi
machine-applicable JSON patch contract'ini tutturamiyor. Agentic coding'de bu
basli basina olculmesi gereken bir failure mode'dur.

## Failure Taxonomy'nin Onemi

Bu calismanin en onemli adimlarindan biri failure taxonomy oldu. Cunku raw task
success tek basina neyin yanlis gittigini anlatmaz.

Failure taxonomy sunlari ayirir:

- model kodu yanlis mi yazdi?
- forbidden file'a dokundu mu?
- expected file'i kacirdi mi?
- machine-readable contract'i bozdu mu?
- eksik authority varken tahmin mi yuruttu?
- patch uygulandi ama diff uretmedi mi?

Bu ayrim sayesinde su sonuca ulastik:

```text
Qwen2.5-Coder'in ana sorunu invalid contract degil, enterprise-boundary guess.
Dream-Coder'in ana sorunu ise enterprise guess degil, invalid contract.
```

Bu cok onemlidir cunku iki modelin failure mode'u farklidir. Dolayisiyla tek
modelin her isi yapmasini beklemek yerine role-specialized hybrid architecture
daha rasyonel gorunmektedir.

## Grafiklerle Okuma

Benchmark sonuclarini daha kolay anlatmak icin otomatik research figures raporu
uretilebilir:

```bash
npm run reports:research-figures
```

Ilk milestone icin kalici figur sayfasi:

```text
docs/results/FIRST_MILESTONE_FIGURES.md
```

Bu komut son benchmark artifact'lerini okuyarak Markdown icinde Mermaid bar chart
grafikleri uretir:

- code patch pass rate,
- enterprise boundary guess count,
- invalid machine-readable contract count,
- behavior benchmark task/evidence/trace karsilastirmasi,
- hybrid mimari yonu.

Bu grafikler sayilarin yerini almaz. Sayilari daha hizli okunabilir hale getirir.
Ozellikle iki ayrimi gorsel olarak anlatmak icin faydalidir:

```text
Qwen2.5-Coder: yuksek patch basarisi, yuksek enterprise-boundary guess.
Dream-Coder dLLM: dusuk direct patch basarisi, yuksek invalid contract.
```

## Ilk Faz Sonucu

Bu calismanin ilk fazi su sonucu desteklemektedir:

```text
Agentic coding sistemlerinde asil problem sadece daha iyi kod ureten model
bulmak degildir. Asil problem, kod ureten modelin etrafinda scope, authority,
boundary, refusal, verification ve remask kararlarini olculebilir sekilde
yoneten bir agent mimarisi kurmaktir.
```

Bu nedenle ilk faz, dLLM'in autoregressive LLM'den her konuda ustun oldugunu
kanitlamaz. Daha dikkatli sonuc sudur:

```text
Autoregressive coder modeller implementation icin guclu olabilir. dLLM-style
agentlar ise dogrudan patch yazmak yerine verifier, boundary checker veya
remask planner rollerinde daha anlamli test edilmelidir.
```

## Ikinci Faz: Hybrid Agent Mimarisi

Ilk fazdan sonra en dogal ikinci adim hybrid mimariydi. Bu ikinci faz artik
yalnizca onerilen bir adim degildir; ilk hybrid benchmarklari kosulmus ve
olculmustur.

Test edilen mimari:

```text
User task
  -> bounded context composer
  -> shared semantic workspace
  -> Qwen2.5-Coder implementation agent
  -> boundary/verifier agent
  -> verifier-triggered remask planner
  -> final patch + trace
```

Bu mimaride Qwen2.5-Coder patch uretir. dLLM veya dLLM-style worker patch'i
dogrudan yazmak yerine su sorulari cevaplar:

- Bu patch allowed scope icinde mi?
- Eksik product/compliance karari var mi?
- Model tahmin mi yuruttu?
- Hangi workspace bolgesi remask edilmeli?
- Patch machine-readable contract'a uyuyor mu?
- Final karar traceable mi?

Bu ikinci fazin temel arastirma sorusu:

```text
Autoregressive coder modelin enterprise-boundary hatalari, dLLM-style
verifier/remask agent eklenince azalir mi?
```

Ilk hybrid code benchmark sonucunda bu soruya pozitif bir ilk sinyal alindi:

| Akis | Patch pass | Refusal | Boundary guess | Invalid contract |
| --- | --- | --- | --- | --- |
| Qwen direct | 78% | 80% | 10 | 0 |
| Qwen workspace | 90% | 92% | 4 | 0 |
| Qwen workspace + verifier | 96% | 100% | 0 | 0 |
| Qwen workspace + verifier + remask | 96% | 100% | 0 | 0 |

Bu tablo su anlama gelir: ayni autoregressive coder model kullanilirken agent
akisinin degistirilmesi, kurumsal sinir ihlali sayisini dusurmus ve patch
basarisini artirmistir. Bu, "modeli degistirmeden mimariyi degistirmek" fikri
icin onemli bir arastirma sinyalidir.

Remask icin ayrica repair odakli ikinci bir suite kosuldu. Bu suite, verifier'in
eksik fakat guvenli sekilde tamir edilebilir bolgeyi isaretledigi kurumsal
senaryolari olcer.

| Akis | Patch pass | Required content miss | Missing expected file | Invalid contract |
| --- | --- | --- | --- | --- |
| Qwen verifier only | 0% | 8 | 8 | 0 |
| Qwen verifier + remask | 100% | 0 | 0 | 0 |

Bu sonuc remask'in default-on bir mekanizma olmamasi gerektigini gosterir.
Remask, sadece verifier tarafindan isaretlenen dar, guvenli ve tamir edilebilir
bolgelerde calistiginda kalite belirleyici bir faktor olabilir.

Bu nedenle calisma bir urun fikrine de evrilebilir:

```text
Scope-safe coding agent layer for enterprise software teams.
```

Bu urun fikri dogrudan yeni bir IDE yapmak zorunda degildir. Daha dar bir urun
baslangici olabilir:

- mevcut coding agentlar icin boundary checker,
- PR patch verifier,
- scope drift detector,
- missing authority/refusal layer,
- shared workspace trace generator,
- enterprise-safe agent orchestration SDK.

Daha guncel ve UTF-8 destekli ana rapor icin `docs/RESEARCH_REPORT_TR.md`
kullanilmalidir. Bu dosya ise ilk arastirma notu ve tarihsel anlatim olarak
korunur.

## Tehditler ve Sinirlar

Bu calisma henuz son sonuc degildir. Onemli sinirlar vardir:

- Tek open-source repo uzerinde code patch benchmark calisti.
- Qwen2.5-Coder 7B GGUF tek autoregressive model temsilidir.
- Dream-Coder worker'in mevcut prompt ve JSON contract ayarlari sonucu etkiliyor
  olabilir.
- dLLM direct patch sonucu, dLLM'in verifier rolundeki potansiyelini olcmez.
- Benchmark case'leri artirilmali ve farkli repository'lere yayilmalidir.
- Latency, cost ve throughput henuz sistematik olculmedi.
- Remask-required suite dar bir enterprise metadata ve repair senaryosu
  uzerinden olculdu; daha genis repo ve domain'lerde tekrar edilmelidir.

Bu sinirlar calismayi zayiflatmak icin degil, ucuncu fazi dogru tasarlamak icin
acikca belirtilmelidir.

## Sonuc

Ilk ve ikinci fazin ortak sonucu, "dLLM her konuda LLM'den iyidir" gibi
abartili bir iddia degildir. Daha guclu ve bilimsel olarak daha savunulabilir
sonuc sudur:

```text
Agentic coding'de modellerin failure mode'lari ayrismaktadir. Qwen2.5-Coder gibi
autoregressive coder modeller scoped implementation tarafinda gucluyken,
enterprise-boundary/refusal kararlarinda zayif kalabilir. Dream-Coder gibi
dLLM-style modeller direct patch contract'inda zayif kalabilir, fakat verifier,
boundary checker ve remask planner rollerinde arastirilmaya degerdir.
```

Bu nedenle proje hybrid bir agent mimarisine evrilmistir. Ikinci fazda elde
edilen en guclu sinyal, modelin degil agent akisinin degistirilmesiyle patch pass
oraninin 78%'den 96%'ya cikmasi ve boundary guess sayisinin 10'dan 0'a
dusmesidir.

Remask icin dogru yorum kosulludur:

```text
Remask default-on olmamalidir. Verifier tarafindan sinirlandirilmis, guvenli ve
tamir edilebilir bolgelerde calistiginda kalite artirabilir; aksi halde gereksiz
maliyet ve karmasiklik uretir.
```

Bu mimari, tek modelin daha akilli olmasina degil, farkli rollerin shared
workspace uzerinde olculebilir ve sinirli sekilde calismasina odaklanmalidir.

Bu calismanin ana katkisi, agentic coding arastirmasini "model iyi mi kotu mu?"
sorusundan "hangi role hangi model/agent davranisi uygun ve hangi failure mode'u
azaltiyor?" sorusuna tasimasidir.
