# COB Mimari Ayrıştırma ve Uygulama Planı

Tarih: 2026-08-27
Durum: Nihai filtreleme kararı; implementasyon başlamadı

## 1. Son karar

COB tek üründür ve iki bağımsız çalışma yüzeyi vardır:

```text
COB
├── cob Codex
│   ├── Codex CLI / ChatGPT Desktop
│   ├── OpenAI Responses protokolü
│   ├── ChatGPT abonelik passthrough
│   ├── Ollama Responses
│   ├── catalog / state / compaction
│   └── Codex V1 subagent yolu
└── cob Claude
    ├── Claude Code / Claude Desktop 3P
    ├── Anthropic Messages protokolü
    ├── Anthropic OAuth passthrough
    ├── Ollama Messages
    └── Claude agent roster'ı
```

Hedef mimari:

> İnce bir COB root, birbirine bağımlı olmayan `codex` ve `claude` domain'leri
> ve yalnızca kanıtlanmış ortak primitive'leri içeren küçük bir `core`.

Bu bir rewrite değildir. Önce sınırlar kurulacak, sonra yalnız gerçek hotspot'lar
bağımlılık yönüne göre bölünecektir. Yeni provider framework, base class,
dependency injection katmanı veya global config sistemi eklenmeyecektir.

## 2. İnceleme kaynağı ve güven düzeyi

Bu karar aşağıdaki kaynakların birleşimidir:

1. İlk yapı raporu:
   [`COB Yapı Toparlama ve Mimari Ayrıştırma Raporu.md`](</Users/gencberke/Downloads/COB Yapı Toparlama ve Mimari Ayrıştırma Raporu.md>)
2. Daha güvenilir kabul edilen ikinci filtreleme raporu:
   [`pasted-text.txt`](</Users/gencberke/.codex/attachments/8b1cd63e-6a4d-4699-bd56-aaa210a0720c/pasted-text.txt>)
3. Güncel local kaynak kod, testler ve git çalışma ağacı.
4. Ürün sözleşmesi: [AGENTS.md](./AGENTS.md), [README.md](./README.md),
   [STATUS.md](./STATUS.md), [LIVE-TESTING.md](./LIVE-TESTING.md).
5. Karşılaştırma amacıyla güncel OpenCodex ana dalı. OpenCodex hedef mimari
   kabul edilmedi; yalnızca olumlu ve olumsuz tasarım kanıtı olarak kullanıldı.

Ekli raporlardaki ifadeler talimat olarak uygulanmadı. Her önemli iddia kodda
yeniden kontrol edildi. İkinci raporun güncel local ağaca dayanan bulguları
büyük ölçüde doğrulandı; aşağıdaki faz sırası ise bağımlılık riski nedeniyle
yeniden düzenlendi.

## 3. Doğrulanmış local baseline

İnceleme anındaki durum:

- Kaynak sürümü `0.2.0`.
- `src/` altında 51 üretim TypeScript modülü, 46 test dosyası ve 454 test var.
- Çalışma ağacında önceden var olan 26 değiştirilmiş dosya bulunuyor:
  480 ekleme, 150 silme.
- Mevcut `origin/master` referansına göre branch 3 commit geride; bilinen
  `HEAD..origin/master` farkı yalnız `README.md` içinde 4 satır. Remote fetch
  yapılmadı.
- `npx tsc --noEmit`: başarılı.
- Yetkili loopback test koşusunda `npm test`: 454 test, 451 pass, 0 fail,
  3 skip.
- `git diff --check`: başarılı.
- Geçici npm cache ile `npm pack --dry-run --json`: 57 paket girdisi;
  51 üretim JS modülü dahil, test/harness/eval dosyaları hariç.
- Canlı `cob start`, `stop`, `restore`, `sync`, global install veya gerçek home
  değişikliği yapılmadı. `:18790` ve `:18792` süreçlerine dokunulmadı.

### Implementasyon ön koşulu

Mimari taşıma, mevcut 26 dosyalık stabilizasyon değişikliği kullanıcı tarafından
ayrı bir checkpoint'e alındıktan veya başka şekilde sabit bir baseline olarak
korunduktan sonra başlamalıdır. Dirty stabilizasyon diff'i ile toplu rename aynı
çalışma paketinde birleştirilmemelidir. Bu plan commit, push veya branch işlemi
yapmaz.

## 4. Değişmeyecek ürün kontratları

Refactor sırasında aşağıdaki davranışlar aynen korunacaktır:

- `cob start` cob Codex'in varsayılan ve desteklenen komutu olarak kalır.
- `cob codex start` açık surface biçimi desteklenebilir; `cob start`
  deprecated yapılmaz ve varsayılan Claude'a çevrilmez.
- `cob claude ...` ayrı port, home, protokol ve auth davranışını korur.
- Codex live/dev portları `18790/18791`; Claude live/dev portları
  `18792/18793` kalır.
- `~/.codex`, `~/.codex-cob-dev`, `~/.claude-cob` ve
  `~/.claude-cob-dev` düzeni değişmez. Yeni `~/.cob` migration'ı yoktur.
- COB `~/.codex/config.toml` veya `~/.claude/settings.json` yazmaz.
- `model_provider = "openai"`, user-owned Desktop overlay ve restore sınırları
  korunur.
- Codex Responses ile Claude Messages ortak protokol/adapter katmanına alınmaz.
- Ollama çocukları V1 kalır. Native V2, Gate 5 ve diğer deneysel yolların
  default-off/fail-closed davranışı değişmez.
- `nativeAlias`, `ocx1`, Fernet taklidi, Ollama `/compact`, cob queue,
  launchd/Login Item veya yeni OS supervisor eklenmez.
- Wire logları content-free kalır; header, state ve checkpoint güvenlik
  invariant'ları korunur.
- `dist/cli.js` stabil executable entrypoint olarak kalır.

## 5. Nihai mimari kurallar

### 5.1 İzin verilen bağımlılık yönü

```text
root/entrypoint ───────→ codex
       │                └────→ core
       └──────────────→ claude
                        └────→ core

core    ─X→ codex
core    ─X→ claude
codex   ─X→ claude
claude  ─X→ codex
```

Root yalnız surface seçimi ve global `version`, `pack`, `help` komutlarını
orkestre eder. Surface implementasyonları root üzerinden birbirine ulaşmaz.

### 5.2 `core` kabul kriteri

Bir parça ancak aşağıdaki şartların tamamını sağlıyorsa `core`'a girebilir:

1. En az iki surface tarafından gerçekten kullanılıyor.
2. İki surface'te aynı invariant ve aynı kaynak sahipliği geçerli.
3. ChatGPT/Codex veya Anthropic/Claude protokol gövdesi üretmiyor.
4. Surface config, catalog, home, state veya lifecycle politikası taşımıyor.
5. Ortaklaştırmak, iki küçük kopyadan daha karmaşık bir API oluşturmuyor.

Bu yüzden `BaseGateway`, `ProviderAdapter`, `LifecycleManager`,
`ConfigManager`, `SurfaceRuntime<T>` veya `HomePolicy<T>` oluşturulmayacaktır.

### 5.3 Ortak kalacak somut parçalar

- Atomic file write primitive'leri.
- Lock ve process identity primitive'leri.
- Loopback URL/bind doğrulaması.
- Protokol üretmeyen body limit, cancellation, header timeout, idle ve
  backpressure primitive'leri.
- Ollama base URL, `ollama/` model prefix'i, `/api/tags` discovery ve
  `OllamaTag` tipi.
- JSON object/type guard primitive'leri.
- Package/global/workspace install detection.
- Güncel kodun iki yüzey için bilinçli şekilde ortak tuttuğu tek varsayılan
  Ollama child modeli.

### 5.4 Surface'e ait kalacak parçalar

- ChatGPT URL/header/catalog/Responses/SSE/state/compaction: Codex.
- Anthropic URL/header/auth/Messages/Claude Desktop overlay: Claude.
- Home mutation guard'ları: ilgili surface.
- Context cap: surface'e ait. Codex ve Claude bugün aynı sayıyı kullansa da
  gerekçeleri ve consumer metadata'sı farklıdır; iki ayrı isim korunmalıdır.
- SSE error/done terminal üretimi: ilgili protokol.

### 5.5 Ortak default model kararı

Güncel local kod `DEFAULT_OLLAMA_SPAWN_MODEL` değerini açıkça iki surface'in
ortak default'u olarak tanımlıyor. Bu karar korunacaktır:

- Değer küçük bir `core/ollama/default-model.ts` dosyasında kalabilir.
- Codex buradan `ollama/...` catalog slug'ını türetir.
- Claude unprefixed model id'sini kullanır.
- Bunun etrafında model registry veya policy framework kurulmaz.
- Surface default'ları ileride gerçekten ayrışırsa ortak sabit kaldırılıp iki
  surface'e dağıtılır.

## 6. Kodda doğrulanan mimari ve davranış sorunları

### A. Yapısal sorunlar

1. **Flat namespace:** Üretim, test, harness ve eval dosyaları aynı `src/`
   dizininde. Prefix'ler mantıksal ayrımı gösterse de import sınırı yok.
2. **Root CLI aşırı sorumlu:** [src/cli.ts](./src/cli.ts) hem Codex hem Claude
   command workflow, detached spawn, overlay, log ve çıktı formatlamasını
   taşıyor. [src/cli-session.ts](./src/cli-session.ts) iki surface'in home,
   port ve mutation policy'sini birlikte çözüyor.
3. **Mixed ownership:** [src/constants.ts](./src/constants.ts),
   [src/types.ts](./src/types.ts) ve [src/install.ts](./src/install.ts) ortak,
   Codex ve Claude sahipliklerini aynı dosyada topluyor.
4. **Claude → Codex importları:** Claude gateway Ollama tag discovery için
   Codex catalog'unu; Claude agents Codex config'ini; Claude models Codex
   isimli context cap'i import ediyor.
5. **Ters dependency:** [src/conversation-state.ts](./src/conversation-state.ts)
   provider-history projection fonksiyonlarını [src/compaction.ts](./src/compaction.ts)
   içinden alıyor. State'in compaction'a bağımlı olması yanlış yöndür.
6. **Hotspot'lar:** `gateway.ts` 1861, `conversation-state.ts` 1164,
   `lifecycle.ts` 1152, `catalog-provenance.ts` 948 satır. Dosya boyutu tek
   başına hata değildir; sorun farklı change reason'ların aynı modülde olmasıdır.

### B. Protokol ve kontrat sorunları

1. **Relay protokol sızıntısı:** [src/relay.ts](./src/relay.ts) ham stream
   primitive'leriyle Codex/OpenAI `[DONE]` ve hata terminalini aynı dosyada
   tutuyor. Claude gateway bu relay'i kullandığı için headers gönderildikten
   sonraki upstream stream hatasında Codex biçimli terminal yazılabilir.
2. **Claude headers timeout:** `fetchWithHeadersTimeout()`
   `HeadersTimeoutError` üretirken Claude catch yalnız `IdleTimeoutError`
   eşliyor; sonuç 504 yerine 500 olabilir.
3. **Claude body limit:** Claude'un local `readBody()` fonksiyonu limitte
   generic `Error` üretiyor; sonuç typed 413 yerine 500 olabilir.
4. **Claude stop lock kontratı:** `stopClaudeGateway(..., {locked})` parametresi
   var fakat uygulanmıyor. Aynı dosyada `startLease` path'i hiç yazılmıyor veya
   okunmuyor; yalnız restore sırasında siliniyor.
5. **User agents restore hedefi:** Manifest `agentsDir` kaydediyor ancak restore
   yeniden current default home hesaplıyor. Home değişirse snapshot yanlış
   hedefe uygulanabilir.
6. **Gateway implicit real-home state:** `createGateway()` açık `stateDir`
   almazsa `resolvePaths()` üzerinden gerçek Codex home'a bağlanabiliyor.
   Gateway factory'nin filesystem side effect'i çağıran lifecycle tarafından
   açıkça verilmelidir.
7. **Request catalog snapshot:** Aynı Codex request içinde catalog birden fazla
   kez çözülebiliyor. Atomic catalog replacement sırasında route ve capability
   kararları farklı snapshot görebilir.

### C. Build ve test sözleşmesi sorunları

1. `package.json` yalnız `dist/*.js` paketliyor. Nested production output
   tarball'dan düşer.
2. `npm test` yalnız `dist/*.test.js` çalıştırıyor. Nested test dosyaları
   kaçırılır.
3. Test/build öncesi `dist/` temizlenmiyor. Taşınmış veya silinmiş eski test
   output'u yeniden çalışabilir; eski production output'u pack kontrolünü
   yanıltabilir.
4. `tsconfig.build.json` içindeki root `gate6h.ts` ve `eval-*.ts` desenleri
   nested taşımaya hazır değil.
5. NodeNext ve `verbatimModuleSyntax` nedeniyle bütün internal importlar açık
   `.js` path'i taşıyor; toplu path değişikliği doğrudan test/emit riskidir.
6. `install.test.ts`, `lifecycle.test.ts`, `stream-crash.test.ts` ve
   `gate6h.harness.ts` sibling/root output path'lerine bağlıdır. Testleri ilk
   runtime taşımasıyla birlikte taşımak gereksiz risktir.

## 7. İlk stabil hedef dizin

İlk yapısal refactor sonunda aşırı klasörleşmeden şu şekil hedeflenir:

```text
src/
├── cli.ts                     # stabil executable + global dispatcher
├── surface.ts                 # yalnız surface enum/parse
├── *.test.ts                  # ilk refactor boyunca yerinde
├── *.harness.ts               # pack-excluded, yerinde
├── eval-*.ts / gate6h.ts      # pack-excluded, yerinde
│
├── core/
│   ├── atomic.ts
│   ├── json.ts
│   ├── lock.ts
│   ├── loopback.ts
│   ├── process-info.ts
│   ├── install-detection.ts
│   ├── http/
│   │   ├── body.ts
│   │   ├── cancellation.ts
│   │   ├── relay.ts           # ham relay; protokol terminali yok
│   │   └── timeouts.ts
│   └── ollama/
│       ├── constants.ts
│       ├── default-model.ts
│       ├── tags.ts
│       └── types.ts
│
├── codex/
│   ├── cli.ts
│   ├── session.ts
│   ├── home.ts
│   ├── paths.ts
│   ├── constants.ts
│   ├── config.ts
│   ├── catalog.ts
│   ├── catalog-provenance.ts
│   ├── capabilities.ts
│   ├── gateway.ts
│   ├── lifecycle.ts
│   ├── profile.ts
│   ├── root-config.ts
│   ├── smoke.ts
│   ├── route.ts
│   ├── decode.ts
│   ├── encrypted.ts
│   ├── limits.ts
│   ├── relay.ts              # Codex SSE terminal davranışı
│   ├── request-metrics.ts
│   ├── sse.ts
│   ├── native.ts
│   ├── ollama.ts
│   ├── ollama-dialect.ts
│   ├── ollama-boundary.ts
│   ├── ollama-response-boundary.ts
│   ├── slug-codec.ts
│   ├── tool-search.ts
│   ├── conversation-state.ts
│   ├── compaction.ts
│   ├── compact-envelope.ts
│   ├── compact-attempt-log.ts
│   └── experimental/
│       ├── apply-patch.ts
│       └── native-plaintext-spawn.ts
│
└── claude/
    ├── cli.ts
    ├── session.ts
    ├── home.ts
    ├── paths.ts
    ├── constants.ts
    ├── gateway.ts
    ├── lifecycle.ts
    ├── auth.ts
    ├── dialect.ts
    ├── route.ts
    ├── models.ts
    ├── agents.ts
    ├── user-agents.ts
    └── desktop-overlay.ts
```

Bu ilk stabil şekildir; nihai klasör ağacının tamamı değildir. Büyük Codex
dosyaları önce intact taşınır. `catalog/`, `state/`, `compaction/`, `runtime/`
ve `gateway/` alt klasörleri ancak ilgili dosya kendi ayrı uygulama paketinde
bölünürken açılır.

## 8. Dosya sahipliği karar tablosu

| Mevcut alan | İlk sahibi | Karar |
| --- | --- | --- |
| `atomic`, `lock`, `process-info` | Core | Davranış değiştirmeden taşı |
| `loopback` | Core + Codex temizliği | Kullanılmayan native URL pin fonksiyonunu ayır/sil; generic loopback core |
| `timeouts` | Core | Typed primitive'ler core; surface response mapping surface'te |
| `limits` | Core + Codex | Generic body/response limit primitive'leri core; Codex'e özel limit sabitleri Codex |
| `relay` | Core + Codex/Claude | Ham stream core; protokol terminali surface-owned |
| `types` | Core + Codex | `JsonObject/isRecord` core, `OllamaTag` core, catalog tipleri Codex |
| `constants` | Core + Codex + Claude | URL/prefix ve iki surface sabitlerini ayır |
| `install` | Core + Codex + Claude | Detection core; home/auth seed/mutation guard surface-owned |
| `cob-config` | Codex | Shared default model çıkarıldıktan sonra tamamen Codex config |
| `catalog` | Codex + Core tag discovery | `/api/tags` core; catalog üretimi/validation Codex |
| `gateway`, `lifecycle`, `smoke` | Codex | Önce intact taşı, sonra ayrı paketlerde böl |
| `conversation-state`, compaction ailesi | Codex | State class korunur; dependency yönü düzeltilir |
| `ollama*`, `route`, `slug-codec`, tool bridge'leri | Codex | Responses/Codex wire dialect'i; core provider abstraction yok |
| `claude-*` | Claude | Prefix'i klasöre çevir; gateway/lifecycle ilk turda bölünmez |

## 9. Method ve class politikası

### Kalacak class'lar

- `ConversationStateStore`: filesystem resource ownership, immutable checkpoint,
  retention ve lineage state'i taşıdığı için gerçek bir class'tır.
- Mevcut typed `Error` class'ları: catch/mapping kontratını temsil ettikleri
  yerde kalır.

### Class'a çevrilmeyecek alanlar

- CLI dispatcher ve command handler'lar.
- Config parse/render/resolve.
- Catalog merge/validation/provenance.
- Gateway routing.
- Lifecycle orchestration.
- Codex veya Claude provider forwarding.

### Büyük dosyalarda hedef method grupları

`codex/config`:

```text
schema.ts   → types, defaults, validation, CodexConfigError
toml.ts     → parse, render, read, write
resolve.ts  → CLI/env/file precedence ve effective config
```

`codex/catalog`:

```text
catalog.ts      → saf parse/merge/serialize/row shaping
source.ts       → Codex binary source discovery
validator.ts    → consumer validation + typed rejection metadata
provenance.ts   → sidecar parse/write/assessment
sync.ts         → I/O orchestration; lifecycle'tan çıkar
```

`codex/state`:

```text
store.ts    → ConversationStateStore ve filesystem operations
schema.ts   → checkpoint validation/serialization/types/errors
history.ts  → identity, merge ve replay history
```

`codex/compaction`:

```text
policy.ts       → plan/model/trigger sınıflandırması
summary.ts      → Ollama summarizer payload/extract/handoff validation
native.ts       → native compact request/response projection
envelope.ts     → mevcut cob1 envelope
attempt-log.ts  → mevcut content-free attempt metrics
```

Provider-safe history projection compaction altında kalmaz:

```text
codex/ollama/history.ts
        ▲              ▲
        │              │
 codex/state     codex/compaction
```

`codex/runtime`:

```text
runtime.ts    → runtime file, pid/nonce health ve health fetch
status.ts     → read-only status/overlay/provenance raporu
lifecycle.ts  → start/stop/restore/foreground/detached orchestration
```

`codex/gateway` en son:

```text
server.ts     → HTTP shell, allowlist, health/shutdown, top-level errors
responses.ts  → request-snapshot, native/Ollama/compaction dispatch
```

Önceki state, compaction ve catalog extraction'ları tamamlandığında bu iki
dosyalı bölme yeterli olmalıdır. İhtiyaç kanıtlanmadan handler class'ları veya
ek dosyalar oluşturulmaz.

Claude tarafı ilk refactor sonunda zaten coherent kalır. `claude/gateway.ts`
ve `claude/lifecycle.ts`, yalnız somut ikinci bir change reason doğarsa daha
sonra bölünür.

## 10. Uygulama paketleri

Her paket bağımsız review edilebilir olmalı. Dosya taşıma ile behavior değişimi
aynı pakette karıştırılmamalıdır.

### Paket 0 — Baseline'i sabitle

Amaç: Mimari diff'in mevcut stabilizasyon diff'ini maskelemesini önlemek.

- Kullanıcı mevcut 26 dosyalık diff'i ayrı checkpoint olarak korur.
- Bilinen `origin/master` README farkı bilinçli şekilde alınır veya ertelenir.
- Baseline çıktıları kaydedilir: tsc, test sayısı, pack manifest, diff check.
- Canlı home ve listener'lar kullanılmaz.

Çıkış kriteri: Mimari çalışma başladığında yalnız mimari pakete ait diff açıkça
ayırt edilebilir.

### Paket 1 — Build, test discovery ve packaging emniyeti

Bu paket nested dosya taşınmadan önce gelmelidir.

- `dist/` için güvenli bir `clean` npm script'i ekle.
- `build`, `test` ve `gate6h` derlemesi öncesi stale output'u temizle.
- Test komutunu Node 22 ile uyumlu recursive glob'a geçir:
  `node --test "dist/**/*.test.js"`.
- Package production glob'unu recursive yap:
  `dist/**/*.js`.
- Exclusion'ları recursive yap:
  `**/*.test.js`, `**/*.harness.js`, `**/eval-*.js`, `**/gate6h.js`.
- `tsconfig.build.json` nested eval/gate exclusion'larını recursive yap.
- Mevcut `install.test.ts` package manifest testini recursive kuralları ve
  `dist/cli.js` varlığını doğrulayacak şekilde genişlet.
- Tarball assertion: bütün production JS var; test, harness, eval, gate6h ve
  source map yok.

Çıkış kriteri:

```text
npx tsc --noEmit
npm test
npm run build
node dist/cli.js version
node dist/cli.js help
npm --cache <temp> pack --dry-run --json
```

### Paket 2 — Flat ağaçta seam hazırlığı

Amaç: Yanlış importları yeni klasörlere taşımadan önce gerçek sahipliği
oluşturmak. Bu, fiziksel ayrımdan önceki küçük ve behavior-preserving hazırlıktır.

- `JsonObject/isRecord` ayır.
- `OllamaTag` ve `loadOllamaTags` ayır.
- Ollama base URL/prefix ve ortak default modeli ayır.
- Codex ve Claude context cap'lerini surface-owned isimlerle ayır.
- Mixed `constants.ts`, `types.ts` ve `install.ts` sahipliklerini böl.
- Package detection ile surface home policy'sini ayır.
- `assertNativeUrlPinned` gibi Codex'e özel veya kullanılmayan parçayı generic
  loopback'ten çıkar.
- State/compaction dependency düzeltmesine hazırlık olarak provider-history
  fonksiyonlarının hedef API'sini belirle; bu pakette büyük state taşıması yapma.

Çıkış kriteri: Claude artık Codex catalog, Codex config veya Codex context
constant'ı import etmez. Henüz klasör taşınmasa bile ownership bağımsızdır.

### Paket 3A — Claude protocol boundary correctness

Bu davranış düzeltmeleri fiziksel rename'den ayrı tutulmalıdır.

- Raw relay'i protokol terminali üretmeyen core primitive'e dönüştür.
- Codex `[DONE]`/error terminal davranışını Codex wrapper'ına taşı.
- Claude stream failure davranışını Anthropic Messages kontratında tut; Codex
  terminali asla yazma.
- Claude `readBody()` yerine shared typed body limit kullan; 413
  `invalid_request_error` mapping ekle.
- `HeadersTimeoutError` ve `IdleTimeoutError` için 504 `timeout_error` mapping
  ekle.

Minimum regresyon testleri:

- `claude-gateway.test.ts`: body limit 413, headers timeout 504, mid-stream
  hatada Codex `[DONE]`/error gövdesi yok.

### Paket 3B — Claude lifecycle ve overlay correctness

Bu paket 3A ile aynı teslimata veya fiziksel taşımaya karıştırılmamalıdır.

- `stopClaudeGateway` public çağrısını mevcut lock ile gerçekten serialize et;
  internal `{locked:true}` çağrısı lock re-entry'yi atlar.
- Hiç yazılmayan `startLease` path'ini kaldır.
- User-agents restore'da manifest target ile requested target uyuşmazlığını
  fail-closed doğrula; snapshot'ı yanlış current home'a uygulama.
- Placeholder auth log'unu injectable `logLine` üzerinden geçir.

Minimum regresyon testleri:

- `claude-user-agents.test.ts`: manifest home mismatch yanlış hedefe yazmıyor.
- Tek küçük `claude-lifecycle.test.ts`: start/stop lock yarışı false-success
  üretmiyor.

### Paket 4 — Fiziksel `core/codex/claude` ayrımı

- Yalnız production modüllerini ilk stabil hedef ağaca taşı.
- Büyük Codex dosyalarını intact taşı; iç logic'i yeniden yazma.
- `src/cli.ts` ve emitted `dist/cli.js` entrypoint'ini yerinde tut.
- Test, harness ve eval dosyalarını ilk turda root'ta tut; yalnız import
  path'lerini güncelle.
- `ollama.ts` ve `lifecycle.ts` re-export'larını kullanan çağrıları birlikte
  güncelle; gereksiz compatibility barrel ekleme.
- Root `architecture.test.ts` ekle. Minimum kurallar:
  - `claude/**` → `codex/**` yasak,
  - `codex/**` → `claude/**` yasak,
  - `core/**` → `codex/**|claude/**` yasak.
- Test statik import, export-from ve dynamic import path'lerini kontrol etmeli;
  yeni dependency/lint framework eklenmemeli.

Çıkış kriteri: cross-surface import sayısı sıfır; full test ve tarball manifest
temiz; behavior değişikliği yok.

### Paket 5 — Root CLI, session ve Codex config ayrımı

- Root `cli.ts`: parse, global command, surface dispatch ve top-level error.
- `codex/cli.ts`: start/serve/stop/restore/sync/status/smoke.
- `claude/cli.ts`: start/serve/stop/restore/status/agents/Desktop overlay.
- `cli-session.ts` içindeki Codex ve Claude home/session resolution ilgili
  surface'e taşınır. Ortak flag tokenization root'ta kalabilir.
- `cob start` ve bütün mevcut command/output/exit-code davranışları korunur.
- `cob codex start` explicit biçimi korunur; `cob start` deprecated yapılmaz.
- Shared default model çıkarıldıktan sonra `cob-config.ts` Codex'e taşınır,
  `schema/toml/resolve` method gruplarına ayrılır.
- `CobPaths`, `CobFileConfig`, `CobConfigError` gibi gerçekte Codex'e ait
  isimler bu pakette veya sonraki semantic rename paketinde Codex olarak
  adlandırılır. Wire'daki gerçek `cob` isimleri değiştirilmez.

Ek doğrulama: `version`, root help, Codex help, Claude help ve invalid command
exit code'ları; isolated session resolution testleri.

### Paket 6 — Codex hotspot decomposition

Boyuta göre değil bağımlılık yönüne göre ilerle:

1. **Catalog control plane**
   - Lifecycle içinden `catalog-sync` çıkar.
   - Catalog pure shaping, source discovery, consumer validation ve provenance
     sorumluluklarını ayır.
   - Validation error string parse etmek yerine typed rejected-consumer
     metadata taşı.
   - Catalog row rebuild/finalization tekrarını tek private fonksiyonda azalt.
2. **Provider history seam**
   - `projectOllamaInputValue` ve `ollamaFollowUpInputError` benzeri provider
     history kurallarını `codex/ollama/history.ts` içine taşı.
   - State ve compaction aynı aşağı yönlü modülü kullanır.
3. **Conversation state**
   - `store/schema/history` olarak böl.
   - `ConversationStateStore` class'ı ve tek filesystem implementation korunur.
4. **Compaction**
   - Policy, summary, native projection, envelope ve attempt log gruplarını
     ayır.
   - Compaction davranışı, handoff skeleton'ı ve fail-closed kuralları değişmez.
5. **Lifecycle**
   - Runtime/health, status ve orchestration'ı ayır.
   - Catalog sync profile write ile start preparation'daki tekrarları kaldır.
   - Overlay/state cleanup file listesi tek source-of-truth olur.
6. **Gateway en son**
   - Önceki leaf extraction'lardan sonra `server.ts` ve `responses.ts` olarak
     böl.
   - Her request başında tek catalog snapshot al.
   - `stateDir` çağıran lifecycle tarafından explicit verilsin.
   - Checkpoint publish fonksiyonları generic repository abstraction olmadan
     küçük state-owned fonksiyonlara taşınır.

Gateway en büyük dosya olmasına rağmen ilk bölünecek dosya değildir. Catalog,
state ve compaction sınırları sabitlenmeden gateway'i bölmek çok sayıda geçici
API ve merge çatışması üretir.

### Paket 7 — Dead contract ve semantic cleanup

- Kesin kullanılmayan `gateway.ts` `inbound` parametresini kaldır.
- `stopClaudeGateway.locked` artık gerçek davranış taşıdığı için no-op kalmaz.
- `startLease` kaldırılmış olmalı.
- Repo içi yalnız tanımı bulunan export'ları tek tek değerlendir:
  `DEFAULT_OLLAMA_REASONING_EFFORT`, `DEFAULT_OLLAMA_COMPACT_EFFORT`,
  `ANTHROPIC_API_ORIGIN`, `assertNativeUrlPinned`,
  `nativePlaintextSpawnSchemaFingerprint`, `cobTomlExists`,
  `ollamaCatalogContextWindow`, `catalogStatusKind`, `surfaceLabel`,
  `resolveClaudeDevHome`, `overlayDirExists` ve apply-patch alias export'ları.
- Repo private CLI ürünüdür; belgelenmiş library API yoktur. Repo/docs/harness
  kullanımı yoksa alias'ı yorum/test ile yaşatmak yerine kaldır.
- `coworkEgressAllowedHosts = ["*"]` gibi Desktop kanıtına bağlı değerleri
  kullanılmıyor varsayarak silme.
- Küçük `unlinkIfExists` kopyaları veya overlay snapshot benzerliği için yeni
  helper/framework oluşturma; failure semantics aynı değilse duplication kalsın.

### Paket 8 — Test ve dokümantasyon normalizasyonu

Bu paket ilk mimari teslim için zorunlu değildir.

- Runtime sınırı stabil olduktan sonra testler istenirse surface yanına taşınır.
- Önce dynamic sibling path kullanan `lifecycle.test.ts`,
  `stream-crash.test.ts`, `install.test.ts` ve `gate6h.harness.ts` audit edilir.
- `gate6h` ve eval'ler pack-excluded/workspace-only kalır. Gate 6 blocked
  statüsü değişmez; refactor bahanesiyle yeniden canary veya cob queue yoktur.
- README ilk bölümde tek ürün/iki surface yapısını gösterir.
- STATUS live Codex ve live Claude kanıtlarını ayrı surface bölümlerinde tutar.
- LIVE-TESTING wire gate'leri aynen korunur.

## 11. Her paket için doğrulama matrisi

### Her değişiklik dilimi

```text
npx tsc --noEmit
ilgili compiled test dosyaları
git diff --check
```

### Her paket sonu

```text
npm test
```

Baseline beklentisi: 451 pass, 0 fail, 3 skip. Test sayısı yalnız yeni gerçek
regresyon testleri eklendiğinde artar.

### Layout, CLI, lifecycle veya catalog değiştiğinde

```text
npm run build
node dist/cli.js version
node dist/cli.js help
npm --cache <temp> pack --dry-run --json
```

Paket manifestinde:

- `dist/cli.js` ve bütün nested production modülleri bulunur.
- Test, harness, eval, gate6h ve source map bulunmaz.
- README, CHANGELOG, RELEASE, LICENSE ve NOTICE kalır.

### Wire/protokol davranışı değiştiğinde

Yalnız ilgili isolated LIVE-TESTING lane'i çalıştırılır. Fiziksel taşıma tek
başına G1-G19 ladder'ını tekrar koşma gerekçesi değildir. Gateway/relay/Claude
protocol mapping veya executable entrypoint değişirse ilgili isolated smoke
ve live lane gerekir. Gerçek `~/.codex`, `~/.claude-cob`, `:18790` veya
`:18792` kullanımı ayrıca kullanıcı yetkisi gerektirir.

## 12. OpenCodex karşılaştırma kararı

Güncel OpenCodex geniş bir universal provider proxy'dir; `providers`,
`adapters`, OAuth, management API, GUI, service supervisor ve ortak router
katmanları taşır. Kendi mimari dokümanı eski büyük dosyaların facade olarak
alt modüllere ayrıldığını ve ayrı domain klasörleri kullandığını gösterir:
[OpenCodex architecture](https://github.com/lidge-jun/opencodex/blob/main/docs-site/src/content/docs/zh-cn/reference/architecture.md).

COB için alınacak fikirler:

- Fiziksel domain sınırları.
- İnce ve stabil executable/facade.
- Import boundary testi.
- Büyük dosyaları bir kerede rewrite etmek yerine change reason'a göre bölme.

COB için alınmayacak fikirler:

- Universal provider registry ve adapter framework.
- Root Codex config injection/ownership. OpenCodex'in current injection katmanı
  doğrudan Codex config yönetimi yapar:
  [inject.ts](https://github.com/lidge-jun/opencodex/blob/main/src/codex/inject.ts).
- Provider/model alias ekosistemi, native identity çalma veya `ocx1`.
- GUI, OAuth store, service supervisor, global OpenCodex home.
- Codex ve Claude'u tek internal request/provider modeline normalize etmek.

OpenCodex'in geniş kapsamı kendi ürünü için mantıklıdır; COB'un kapsamı daha
dar ve live invariant'ları daha serttir. Onu kopyalamak COB'u temizlemek yerine
yeni bir platforma dönüştürür.

## 13. Bilinçli olarak reddedilen alternatifler

- Tek committe bütün dosyaları taşıyıp hotspot'ları rewrite etmek.
- `gateway.ts` dosyasını yalnız en büyük olduğu için ilk bölmek.
- `cob codex` biçimini getirirken `cob start` varsayılanını kaldırmak.
- Codex Responses ile Claude Messages için ortak provider adapter.
- Ortak context cap'i yalnız değerler eşit diye core'a almak.
- `~/.cob` migration'ı.
- Testleri production taşımasıyla birlikte topluca taşımak.
- Sırf export olduğu için dead code'u compatibility yüzeyi saymak.
- Sırf iki yerde tekrar var diye helper veya manager eklemek.
- OpenCodex service/config/alias tasarımlarını ürün kapsamına almak.

## 14. Mimari tamamlanma ölçütü

Refactor aşağıdakilerin tamamı sağlandığında tamamlanmış sayılır:

1. `codex` ve `claude` arasında doğrudan import yok.
2. `core` hiçbir surface modülünü import etmiyor ve protokol cevabı üretmiyor.
3. Root CLI yalnız global komut ve surface dispatch taşıyor.
4. `cob start` ve `cob claude` mevcut public davranışlarını koruyor.
5. Codex ve Claude home/port/auth/protocol/state sınırları karışmıyor.
6. `ConversationStateStore` dışında yeni business class/manager katmanı yok.
7. Gateway, lifecycle, state, compaction ve catalog change reason'ları ayrı
   modüllerde; geçici facade/barrel zinciri yok.
8. Recursive build/test/package sözleşmesi stale output üretmiyor ve tarball
   eksiksiz.
9. Statik merge gate tamamen yeşil.
10. Behavior değişen alanlarda ilgili isolated live kanıt mevcut; live home
    veya listener izinsiz değiştirilmemiş.

## 15. Önerilen ilk implementasyon teslimi

İlk mimari seri Paket 1, 2, 3A ve 4 ile sınırlandırılmalıdır. Bunlar tek bir
birleşik diff değil, sırayla merge edilebilir dört review birimidir:

1. Build/test/package emniyeti.
2. Gerçek ortak seam'lerin flat ağaçta çıkarılması.
3. Yalnız Claude protocol boundary correctness düzeltmeleri.
4. Production dosyalarının `core/codex/claude` altına intact taşınması ve
   architecture test.

Claude lifecycle/overlay doğruluğu Paket 3B olarak ayrı kalır. Root CLI/config
ayrımı ve Codex hotspot decomposition da sonraki bağımsız teslimlerdir. Bu
sıra, davranış düzeltmesini fiziksel taşımadan ayırır ve her ara durumda çalışan
bir branch bırakır.

Nihai mimari ilkesi:

> Aynı değere veya benzer şekle sahip kodu değil, aynı invariant'a sahip kodu
> paylaş. Yanlış abstraction yerine küçük duplication'ı tercih et.
