# COB Post-Refactor Architecture Review

Bu belge 2026-08-27 mimari ayrıştırmasından sonra ortaya çıkan yapının kalıcı
değerlendirmesidir. Bir bug listesi, release günlüğü veya canlı makine durum
raporu değildir.

- Güncel ürün ve kullanım sözleşmesi: [README.md](../README.md)
- Güncel makine/workspace/canary durumu: [STATUS.md](../STATUS.md)
- Release event, burned artifact, install ve rollback otoritesi: [RELEASE.md](./RELEASE.md)
- Sürüm geçmişi: [CHANGELOG.md](../CHANGELOG.md)
- Canlı doğrulama kontratı: [LIVE-TESTING.md](./LIVE-TESTING.md)
- Geçici işler ve düzeltmeler: açık kullanıcı talimatı ve
  [IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md)

## 1. Sonuç

Mimari revizyon doğru yöndedir ve korunmalıdır. COB tek ürün olarak kalırken
iki bağımsız protokol yüzeyine ayrılmıştır:

```text
COB
├── cob Codex
│   ├── OpenAI Responses
│   ├── ChatGPT subscription passthrough
│   ├── Ollama Responses
│   ├── catalog / state / compaction
│   └── Codex V1 subagent path
├── cob Claude
│   ├── Anthropic Messages
│   ├── Claude OAuth passthrough
│   ├── Ollama Messages
│   ├── Claude Desktop 3P overlay
│   └── Claude agent roster
└── core
    └── proven shared primitives only
```

Bu ayrım ürünün temel hedefini destekliyor: Codex Desktop ve Codex harness
yeteneklerini koruyarak Ollama Cloud modellerini açık `ollama/...` kimlikleriyle
hem ana ajan hem V1 subagent olarak kullanmak; Claude entegrasyonunu aynı ürün
içinde fakat ayrı protokol ve ownership sınırlarıyla büyütmek.

## 2. Onaylanan modül sınırları

### `src/codex/`

Codex'e ait Responses gateway, model kataloğu, tool projection, conversation
state, compaction, runtime lifecycle ve root-overlay gözlemi burada yaşar.
Claude Messages veya Claude Desktop state'i bu domain'e taşınmamalıdır.

### `src/claude/`

Anthropic Messages gateway, Claude auth kararı, model route'u, Claude runtime,
Claude Desktop 3P overlay ve Claude agent roster'ı burada yaşar. Codex catalog,
Responses checkpoint veya ChatGPT header semantiği bu domain'e taşınmamalıdır.

### `src/core/`

Yalnız iki yüzeyde de gerçekten aynı invariant'a sahip küçük primitive'ler
bulunur: bounded HTTP/body okuma, atomic/private file helpers, lock, process
identity, loopback ve genel JSON/path yardımcıları. Surface-specific auth,
route, lifecycle veya config policy generic abstraction adına `core` içine
alınmamalıdır.

### Root CLI

Root CLI yalnız command routing ve ortak presentation glue taşımalıdır.
`cob start` Codex yüzeyi olarak kalır; `cob claude ...` ayrı namespace'tir.
Port, home, protocol ve restore ownership'i iki yüzey arasında birleştirilmez.

## 3. Kalıcı ownership sınırları

| Kaynak | Owner | Kalıcı karar |
|---|---|---|
| `~/.codex/config.toml` | Kullanıcı / Codex Desktop | COB yazmaz; yalnız read-only overlay assessment yapar |
| COB Codex profile/catalog/state | cob Codex | COB-owned; restore yalnız bu dosyaları temizler |
| `~/.claude/settings.json` | Kullanıcı / Claude Code | COB yazmaz |
| `~/.claude-cob*` | cob Claude | Runtime, token, log ve code-agent state'i burada tutulur |
| Claude Desktop 3P profile | Opt-in cob Claude overlay | Snapshot/restore manifest'iyle yönetilir; Claude.app COB tarafından restart edilmez |
| Native GPT/Claude credentials | Native istemci/auth store | Ollama route'una gönderilmez |
| Ollama conversation state | cob Codex private state | Native opaque identity ile karıştırılmaz |

Root overlay'in user-owned kalması bilinçli bir karardır. Desktop görünürlüğü
ile config ownership aynı şey değildir; COB drift'i tespit eder fakat kullanıcı
config'ini sahiplenmez.

## 4. Kalıcı protokol kararları

- Native GPT istekleri ChatGPT yoluna, native Claude istekleri Anthropic yoluna
  passthrough edilir. Ollama model kimlikleri açıkça `ollama/...` olarak kalır.
- Codex ve Claude aynı gateway, port, auth header seti veya state store'u
  paylaşmaz.
- Ollama çocukları V1'de kalır. Multi-Agent V2, Fernet/encrypted collaboration
  payload'ları ve COB-owned child queue ürün yüzeyine eklenmez.
- Ollama'ya ChatGPT/Anthropic credential, `x-codex-*`, Fernet, native compact
  material veya başka bir provider'ın opaque envelope'u gönderilmez.
- Tool kimliği Codex tarafında canonical `{namespace, name}` olarak korunur.
  Ollama için gereken düz alias yalnız private provider boundary'sinde ve exact
  request-scoped map ile uygulanır. Delimiter parsing, fuzzy dispatch ve
  undeclared-call acceptance yapılmaz.
- Native compaction ve Ollama summarization iki ayrı kontrattır. Native opaque
  compaction material'i Ollama'ya çevrilmez; Ollama handoff state'i COB-owned
  ve fail-closed kalır.
- Model capability alanları kimlik impersonation aracı değildir. Native GPT
  slug'ları Ollama için çalınmaz; `nativeAlias` ürün çözümü değildir.

## 5. Modülerlik ilkesi

COB'un hedefi evrensel provider framework olmak değildir. Yeni davranış şu
sırayla eklenmelidir:

1. Exact istemci/provider kontratını ve sürümünü kanıtla.
2. Değişimin hangi surface'e ait olduğunu belirle.
3. En küçük boundary adapter veya policy değişikliğini uygula.
4. Fail-closed regression ile canonical kimliği kilitle.
5. İzole gerçek-model canary'si çalıştır.
6. Canlı gateway değişecekse ayrıca kullanıcı yetkisi al.

Birden fazla surface'te benzer görünen kod, aynı invariant'a sahip olduğu
kanıtlanmadan ortaklaştırılmamalıdır. Daha iyi çözüm bulunduğunda modül
değiştirilebilir; fakat ownership ve protocol separation korunmalıdır.

## 6. İzlenecek mimari hotspot'lar

Bunlar tek başına bug veya refactor görevi değildir:

- `src/codex/gateway/responses.ts` terminal capture, compaction, relay ve state
  publication gibi birkaç değişim eksenini hâlâ aynı orchestration alanında
  taşıyor. Yalnız gerçek bir correctness değişimi doğal sınır oluşturduğunda
  bölünmelidir.
- Codex ve Claude lifecycle dosyaları büyüktür; fakat process ownership ve
  rollback tek davranış alanıdır. Generic lifecycle manager yerine küçük,
  surface-specific locked transaction helper'ları tercih edilmelidir.
- Root CLI/session glue iki surface'i tanır. Bu katman yeni policy taşımaya
  başlarsa bağımlılık yönü yeniden gözden geçirilmelidir.

Dosya boyutu veya simetri tek başına rewrite gerekçesi değildir.

## 7. External-contract disiplini

Codex Desktop, PATH Codex ve Ollama davranışları sürümle değişebilir. Bu nedenle:

- Catalog producer/validator/consumer identity kaydedilir.
- Desktop davranışı exact bundled Codex kanıtı olmadan CLI sonucundan
  genellenmez.
- Picker başarısı route, tool dispatch veya subagent gold sayılmaz.
- Static test başarısı gerçek Responses/Message wire kanıtının yerine geçmez.
- App güncellemesinden sonra picker, native route, Ollama route ve V1 child yolu
  yeniden ölçülür.
- Canlı listener restart/replace işlemi kullanıcı yetkisi olmadan yapılmaz.

## 8. OpenCodex'ten alınan ve reddedilen fikirler

OpenCodex hedef mimari değildir; daha geniş provider ve policy ürünüdür.

Seçici olarak yararlı fikirler:

- Tek construction authority
- İçeriksiz structural route diagnostics
- Desired-state ile mutation transaction ayrımı
- Runtime/catalog producer-consumer identity
- Bounded response state ve atomic ownership

COB'a alınmayacak yaklaşımlar:

- Native GPT id'lerini çalan alias sistemi
- Root config/provider ownership'ini bridge'e aktarma
- Fernet veya provider envelope impersonation
- Generic provider registry/base gateway/DI framework
- Account pool, quota router veya policy-profile ürünü
- Ollama Multi-Agent V2 ve bridge-owned collaboration queue
- launchd/Login Item/OS supervisor

## 8.1 Logging ve evidence sınırı

Gözlemlenebilirlik kalıcı bir güvenlik ve ownership sınırıdır:

- Structured persistence yalnız opt-in'dir; default hot path ve human-readable
  log değişmeden kalır.
- Log ve persisted diagnostic alanları yapısaldır ve content-free'dur; prompt,
  output, tool name/ID, auth malzemesi veya raw error yazılmaz.
- Logging diagnostic-only'dir: model/provider call, automatic retry, queue veya
  background worker başlatmaz. Logging failure hiçbir request'i fail ettiremez.
- Exact usage yalnız upstream trace/receipt ile kanıtlanıyorsa taşınır; değer
  fabricate, estimate veya infer edilmez.
- Controller retry ve no-progress sahipliği upstream controller'dadır. Gateway
  bunları ancak trace/receipt açıkça sağlıyorsa raporlar; counter'ları icat
  etmez, birleştirmez ve kendi retry davranışıyla karıştırmaz.
- Operasyonel logging ve receipt ayrıntıları [README.md](../README.md) ile
  [LIVE-TESTING.md](./LIVE-TESTING.md)'dedir; güncel kurulum/install durumu
  [STATUS.md](../STATUS.md)'dedir.

## 9. Bilinçli non-goal'lar

- Ollama parent → native GPT child
- COB içinde upstream Codex collaboration scheduler geliştirmek
- ChatGPT Desktop veya Claude Desktop binary patchlemek
- Canlı Gate 5 `apply_patch` veya experimental plaintext V2'yi varsayılan yapmak
- Bütün platformları kanıt olmadan supported ilan etmek
- Root kullanıcı config'ini COB restore ownership'ine almak
- Protocol-specific state ve lifecycle'ı tek generic service'e birleştirmek

## 10. Dokümantasyon otoritesi

Bu dosya yalnız mimari kararı açıklar. Aynı bilginin birden fazla yerde
yaşamasını önlemek için:

| Konu | Tek otorite | Sınır |
|---|---|---|
| Ürün ve kullanıcı-visible davranış | `README.md` | Kurulum ve kalıcı ürün kontratı; canlı snapshot değil |
| Agent rules ve kalıcı safety bans | `AGENTS.md` | Çalışma kuralları ve ürün güvenlik sınırları; volatile durum değil |
| Güncel makine, workspace ve canary durumu | `STATUS.md` | Tarihli snapshot; PID, sürüm, SHA ve gate disposition burada kalır |
| Release event, burned artifact, install ve rollback | `docs/RELEASE.md` | Hangi artifact'in üretildiği/kurulduğu ve geri dönüş kaydı burada kalır |
| Tekrarlanabilir gold prosedürü ve kanıt | `docs/LIVE-TESTING.md` | PASS yalnız trace/receipt ile; fixture veya mock tek başına gold değildir |
| Tamamlanmış kullanıcı-visible değişiklik | `CHANGELOG.md` | Release/change özeti; makine durumu değil |
| Geçici iş, defect ve deney görevleri | Açık kullanıcı talimatı + `IMPLEMENTATION-PLAN.md` | Kalıcı mimari kararlar bu review'a kopyalanmaz |
| Kişisel vault bağlamı ve durable principles | Vault (`second-brain`) | Yalnız routing, tercih ve kalıcı ilke; repo dokümanı/PID/SHA/gate sonucu kopyalanmaz |
| Implementation plan | `docs/IMPLEMENTATION-PLAN.md` | Lifecycle ve içerik reconciliation deferred; `docs/` relocation plan kararlarını değiştirmez |
| Controller collaboration sequencing/retry/evidence | Upstream Codex controller + `docs/UPSTREAM-U1.md` / `docs/LIVE-TESTING.md` | Controller send/follow-up sırası ve controller retry counter'ı cob gateway'e devredilmez |
| Gateway provider-boundary retry/transport/evidence | cob gateway contract + `README.md` / `docs/LIVE-TESTING.md` | Gateway yalnız kendi provider-attempt/transport kanıtını sahiplenir; controller event'lerini replay etmez ve queue eklemez |
| Logging/diagnostic persistence ve receipt alanları | `README.md` / `docs/LIVE-TESTING.md` | Structured persistence opt-in; default human log/hot path korunur, log failure request'i fail ettirmez |

## 11. Manuel docs synchronization checklist

Dokümanlar arasında bir senkronizasyon yapılacağı zaman şu kontrol listesi
uygulanır:

- [ ] Düzenlemeden önce tek bir timestamped evidence snapshot donduruldu; snapshot'ın tarih/saat, artifact ve ortamı kaydedildi.
- [ ] Her iddia tam olarak bir authority'ye sınıflandırıldı; diğer belgeler authority'ye link veriyor.
- [ ] Volatile PID, version, root/catalog SHA ve gate diary çoğaltılmadı; bunlar `STATUS.md` veya `docs/RELEASE.md` içinde tutuldu.
- [ ] `PASS` yalnızca ilgili trace veya receipt ile destekleniyor; test/fixture başarısı tek başına gold sayılmadı.
- [ ] Her kaydedilmiş iddiada date + artifact identity/version + evidence pointer/receipt bulunuyor.
- [ ] Vault ve `AGENTS.md` içinde volatile gerçekler tutulmadı; vault yalnız durable principle/routing bağlamı taşıyor.
- [ ] Stale identifier/link/diff audit yapıldı: eski sürüm/PID/SHA/gate adları, kırık linkler ve kapsam dışı diff aranıp temizlendi.
- [ ] `docs/IMPLEMENTATION-PLAN.md` içerik/lifecycle kararı yalnız açık yetkiyle değiştirildi; salt relocation ve path düzeltmesi plan uygulaması sayılmadı.
