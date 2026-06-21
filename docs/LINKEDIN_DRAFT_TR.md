# LinkedIn Paylaşım Taslağı

## Başlık Önerileri

1. Agentic Coding’de Sorun Sadece Model Değil: Workspace, Verifier ve Remask Üzerine Açık Kaynak Bir Deney
2. Aynı Coder Model, Farklı Agent Mimarisi: Patch Pass `%78`den `%96`ya Nasıl Çıktı?
3. Kurumsal Agentic Coding İçin Verifier Kontrollü Remask Neden Önemli Olabilir?

## Önerilen Paylaşım Metni

Agentic coding araçları giderek güçleniyor. Fakat kurumsal yazılım geliştirme
ortamlarında sorun çoğu zaman modelin kod yazamaması değil; modelin **ne zaman
kod yazmaması gerektiğini bilememesi**.

Bir billing, auth veya platform modülünde çalışırken agent’ın yalnızca doğru kodu
yazması yetmiyor. Şunları da bilmesi gerekiyor:

- Hangi dosyalara dokunabilir?
- Hangi kararlar eksikse durmalı?
- Scope dışına çıktı mı?
- Paired file, schema, type veya test eksik kaldı mı?
- Patch approve mu edilmeli, refuse mu edilmeli, yoksa sadece hatalı bölge mi
  yeniden tamir edilmeli?

Bu soruları ölçmek için açık kaynak bir araştırma laboratuvarı üzerinde çalışıyorum:

`bounded-dllm-agent-lab`

Bu çalışmada yeni bir büyük dil modeli eğitmedim. Asıl soru şuydu:

> Aynı coder model, daha doğru bir agent mimarisine yerleştirildiğinde daha
> güvenli ve kapsam kontrollü davranır mı?

İlk sonuçlar oldukça ilginç:

| Akış | Patch Pass | Boundary Guess |
| --- | ---: | ---: |
| Direct Qwen2.5-Coder | 78% | 10 |
| Workspace | 90% | 4 |
| Workspace + Verifier | 96% | 0 |
| Workspace + Verifier + Remask | 96% | 0 |

Yani model aynı kaldı. Değişen şey agent mimarisiydi.

Direct patching yerine shared semantic workspace + verifier akışına geçince:

- patch pass `%78`den `%96`ya çıktı,
- boundary guess `10`dan `0`a düştü,
- invalid patch contract artmadı.

Remask tarafında da ayrıca bir test yaptım. İlk testte remask nötr kaldı; çünkü
verifier zaten problemi çözüyordu. Sonra daha gerçekçi bir kurumsal repair
senaryosu kurdum:

> İlk agent dar role-view ile sadece `package.json` tarafını görüyor. Fakat
> kurumsal policy `jsr.json`ın da aynı versiyona güncellenmesini istiyor.
> Verifier eksik paired-file değişikliğini yakalıyor. Remask ise sadece bu eksik
> bölgeyi tamir ediyor.

Sonuç:

| Akış | Patch Pass | Missing Expected File |
| --- | ---: | ---: |
| Verifier only | 0% | 8 |
| Verifier + Remask | 100% | 0 |

Bu benim için önemli bir ders oldu:

> Remask her patch’ten sonra otomatik çalışacak bir mekanizma olmamalı.
> Verifier tarafından tetiklenen, güvenli ve hedefli bir repair modu olmalı.

Kısa ürün fikri:

> AI patch boundary reviewer for enterprise teams.

Yani Cursor/Windsurf alternatifi bir IDE değil; farklı AI coding agent’larının
ürettiği patch’leri kurumsal scope, authority, paired-file consistency ve güvenli
repair açısından denetleyen bir katman.

Bu çalışma henüz erken fazda. Tek repo, sınırlı benchmark ve quantized Qwen2.5
baseline ile ölçüldü. Bu yüzden “genel kanıt” değil; açık kaynak bir araştırma
notu olarak okunmalı.

Ama şu sinyal bence değerli:

> Agentic coding güvenilirliği yalnızca model kalitesiyle açıklanamaz.
> Context mimarisi, workspace tasarımı, verifier politikası ve hedefli remask
> mekanizması sonuç kalitesini doğrudan etkileyebilir.

Rapor ve repo:

`https://github.com/theOguz16/bounded-dllm-agent-lab`

Geri bildirimlere çok açığım. Özellikle agentic coding, code review automation,
LLM/dLLM mimarileri ve enterprise software tooling tarafında çalışan kişilerden
yorum duymak isterim.

## Daha Kısa Versiyon

Agentic coding’de problem sadece “model daha iyi kod yazsın” değil.

Bence asıl soru şu:

> Agent hangi kapsamda çalıştığını, hangi kararı vermeye yetkisi olmadığını ve
> hangi patch bölgesinin güvenli şekilde tamir edilebileceğini bilebilir mi?

Bu soruyu ölçmek için açık kaynak bir benchmark lab üzerinde çalıştım.

Aynı Qwen2.5-Coder modeliyle:

| Akış | Patch Pass | Boundary Guess |
| --- | ---: | ---: |
| Direct | 78% | 10 |
| Workspace | 90% | 4 |
| Workspace + Verifier | 96% | 0 |

Remask-required kurumsal repair senaryosunda:

| Akış | Patch Pass |
| --- | ---: |
| Verifier only | 0% |
| Verifier + Remask | 100% |

Benim çıkarımım:

> Verifier kaliteyi koruyor. Remask ise yalnızca güvenli ve tamir edilebilir
> kısmi hatalarda üretkenliği geri kazandırıyor.

Bu yüzden remask default-on değil, verifier-triggered olmalı.

Repo ve Türkçe rapor:

`https://github.com/theOguz16/bounded-dllm-agent-lab`

## Paylaşırken Eklenebilecek Not

Bu çalışma final paper değildir; erken faz, açık kaynak ve ölçülebilir bir
araştırma notudur. Sonuçların daha büyük repository’lerde, farklı modellerde ve
farklı kurumsal task tiplerinde tekrarlanması gerekir.
