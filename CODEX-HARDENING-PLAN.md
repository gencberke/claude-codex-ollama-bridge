# COB Codex Hardening Uygulama Planı

- Tarih: 2026-08-30
- Durum: Uygulamaya hazır plan; bu belge kod değişikliği veya release yetkisi değildir
- Baseline: cob `94a0d9a473040b753192bf3cc8a978d14ec58a6d` / source `0.2.2`

## 1. Hedef ve tamamlanma tanımı

Bu plan, 0.2.2 patch re-review sonrasında doğrulanan **cob Codex**
correctness ve release-discipline açıklarını en küçük güvenli değişikliklerle
kapatır. Hedef yeni bir mimari kurmak değil; mevcut owner sınırları içinde dört
somut hatayı düzeltmek, bir küçük privacy açığını kapatmak ve tekrarını CI ile
engellemektir.

Plan tamamlandığında:

1. Başarısız bir checkpoint yayını mevcut geçerli conversation state'i silemez.
2. Normal Ollama JSON/SSE yanıtı yalnız exact ve tek bir completed terminal ile
   başarı/checkpoint üretebilir.
3. Custom Codex `--home`, explicit port override yoksa live `:18790` yerine
   isolated `:18791` kullanır.
4. Yalnız `ENOENT` eksik `cob.toml` sayılır; diğer I/O hataları fail closed olur.
5. Generic Ollama upstream hata metni bearer secret veya local absolute path'i
   client yanıtına taşımaz.
6. Temiz checkout CI; typecheck, test, production build ve packed CLI smoke
   adımlarını çalıştırır.
7. Sonuç yalnız **Codex-scoped hardening** olarak kaydedilir. Whole-product
   production-readiness iddiası yapılmaz.

## 2. Yetki, kapsam ve değişmeyecek kontratlar

### Aktif kapsam

- `src/codex/**`, gerekli ortak primitive'ler, Codex testleri ve repository CI.
- `README.md`, `STATUS.md`, `LIVE-TESTING.md`, `RELEASE.md` ve gerekiyorsa
  `CHANGELOG.md` içindeki Codex/source/live kanıt ayrımı.
- Normal Ollama Responses JSON/SSE, Ollama summarizer yanıtı ve cob-owned
  continuation state.

### Kapsam dışı

- `src/claude/**` değişikliği, Claude test/canary geliştirmesi veya `:18792`
  listener replacement.
- Claude Desktop overlay, Windows Claude credential store, `~/.claude`
  containment ve diğer ertelenmiş Claude bulguları.
- Native GPT slug impersonation, `nativeAlias`, `ocx1`, Fernet, Ollama V2,
  cob-owned queue, Multi-Agent V2 veya Upstream U1'in cob içine alınması.
- Live `~/.codex` yazısı, live `:18790` restart/replace, global install, tag,
  commit, push veya PR. Bunların her biri ayrıca kullanıcı yetkisi ister.
- Generic provider framework, yeni storage engine veya OpenCodex/CLIProxyAPI
  mimarisinin cob'a taşınması.

### Korunacak davranışlar

- 0.2.2 reserved top-level `functions` alias fix'i ve exact canonical restore.
- Ollama V1 child, tool-search ve default-off Gate 5 güvenlik sınırları.
- Native compact ile Ollama summarize kontratlarının ayrılığı.
- Upstream `[DONE]` olmadan `response.completed` + temiz EOF kabul eden reviewed
  Ollama davranışı.
- Content-free log politikası; request/response body, tool adı/argümanı,
  checkpoint içeriği ve secret loglanmaz.
- Mevcut bind + health + nonce + start-lease doğrulaması. Lifecycle yeniden
  yazılmaz.

## 3. Doğrulanmış açıklar ve disposition

| ID | Öncelik | Doğrulanmış durum | Uygulama kararı |
| --- | --- | --- | --- |
| C-S1 | P0 | `ConversationStateStore.publish()` eski dosyaları exhaustion ve yeni commit'ten önce siliyor | Pure eviction plan → preflight → archive → checkpoint commit → post-commit prune |
| C-R1 | P0 | JSON 2xx invalid envelope relay edilebiliyor; SSE booleans duplicate/çelişkili terminali ayırt etmiyor | Exact envelope + route-specific terminal transaction |
| C-I1 | P1 | Custom non-live `--home`, `isolated === true` olsa da port resolver'a `flags.dev` gönderiyor | Resolver'a hesaplanmış `isolated` değerini ver |
| C-C1 | P1 | `readCobToml()` non-`CobConfigError` bütün I/O hatalarını absent sayıyor | Yalnız `ENOENT` absent; diğerleri typed fail-closed |
| C-P1 | P1 opportunistic | Generic non-2xx Ollama error body client'a secret/path taşıyabilir | Küçük ve bounded sanitizer; classification değişmez |
| C-CI1 | P2 | Tracked `.github/workflows` yok; packed artifact smoke immutable değil | Minimal cross-platform CI + temp-prefix pack smoke |
| C-D1 | P2 | `LIVE-TESTING.md` live `0.2.0` derken `STATUS.md` live `0.2.1` diyor | Implementation evidence sonrasında source/live metnini tekilleştir |

## 4. Çapraz keşif sonucu

Vault'taki yönlendirme gereği referans repository'ler protokol doğrusu değil,
fikir ve fixture kaynağı olarak kullanıldı. cob'un provider ve ownership
kontratına uymayan davranışlar alınmayacaktır.

### 4.1 OpenCodex'ten alınacak fikirler

- `src/responses/state.ts:151-161,305-345,803-922` ve
  `tests/responses-state.test.ts:930-941,1062-1077,1244-1262`:
  yeni durable generation yayımlanmadan superseded generation silinmiyor;
  deletion yalnız stable commit'ten sonra yapılıyor.
- `src/responses/spill-store.ts:302-395`: temp publication, exact identity,
  digest/size/schema doğrulaması. cob ilk düzeltmede kendi immutable
  response-id path + lock modelini koruyacak; yalnız commit-before-prune kuralı
  alınacak.
- `src/server/relay.ts:158-248`: bounded, frame-aware ve sticky terminal owner.
  cob bütün stream'i buffer'lamayacak; yalnız terminal data frame'ini mevcut
  body/line limitleri altında kısa süre tutacak.
- `src/adapters/upstream-http-error.ts` ve testi: upstream error text'te bearer
  secret ve POSIX/Windows absolute path redaction.
- `.github/workflows/ci.yml`: read-only permissions, clean checkout, explicit
  gates ve packed CLI smoke fikri.

### 4.2 CLIProxyAPI'den alınacak fikirler

- `sdk/api/handlers/openai/openai_responses_handlers.go:51-170,622-973`:
  split chunk/multiline frame fixture'ları, sticky terminal ve bounded error
  diagnostics.
- `sdk/api/handlers/openai/openai_responses_handlers_stream_error_test.go`:
  malformed frame, failure/completed ordering, post-terminal ve post-DONE
  fixture'ları.
- `internal/watcher/config_reload.go:51-96` ve store read path'leri:
  candidate geçerli olmadan current state'i değiştirmeme; `ENOENT` ile gerçek
  read failure'ı ayırma.
- `.github/workflows/pr-test-build.yml`: temiz checkout'ta build doğrulama.

### 4.3 Bilinçli olarak alınmayacak fikirler

- Referansların relay için kullandığı **first-terminal-wins** politikası,
  checkpoint yetkisi için yeterli değildir. cob'da ikinci/çelişkili terminal
  stream'i taint eder ve checkpoint'i engeller.
- Terminal görülür görülmez upstream'i cancel etmek, sonradan gelen çelişkiyi
  gözlenemez yapar. cob mevcut davranış gibi EOF/idle'a kadar drain eder; yalnız
  terminal frame client'tan tutulur.
- Status'süz `{ id, output }` fixture'ları accepted-contract sayılmaz. Reviewed
  Ollama response `status: "completed"` üretir; normal success boundary bunu
  exact ister.
- OpenCodex'in snapshot debounce/spill generation sistemi, CLIProxyAPI'nin
  generic translator'ları, output reconstruction framework'ü, Bun sharding ve
  runtime-crash retry sistemi kopyalanmaz.
- CLIProxyAPI'nin `EISDIR`'ı bazı optional config path'lerinde missing sayması ve
  `O_TRUNC` ile in-place config yazması cob için reddedilir.
- Full request-body capture, generic protocol conformance framework, yeni
  logging header'ı ve broad lifecycle/catalog rewrite yapılmaz.

## 5. Uygulama iş paketleri

İş paketleri aynı sırayla uygulanmalı ve her paket kendi targeted testini
geçmeden sonraki pakete başlanmamalıdır. Başlangıçta mevcut dirty dokümanlar ve
untracked `.idea/` korunur; unrelated dosyalar değiştirilmez.

### WP1 — State publication transactionality (`C-S1`)

#### Dokunulacak yerler

- `src/codex/state/store.ts`
  - `ConversationStateStore.publish()` (`148-228` baseline)
  - mevcut `writeImmutable()` ve `removeCheckpointFiles()` kullanılır
- `src/conversation-state.test.ts`

Yeni storage abstraction, manifest veya database eklenmez.

#### Hedef invariant

Checkpoint dosyasının successful rename'i transaction'ın **commit point**'idir:

```text
lock
  normalize + serialize
  read current valid state
  compute retention/eviction plan (no mutation)
  prove candidate can fit after the full plan
  write candidate archive, if any
  write candidate checkpoint       <- commit point
  prune planned obsolete nodes     <- maintenance
unlock
```

Her pre-commit failure'da önceki checkpoint/archive kümesi aynen resolvable
kalmalıdır. Kısa süreli budget excess, geçerli eski state'i erken silmekten
daha güvenlidir.

#### Uygulama adımları

1. `removable` iterasyonunda `removeCheckpointFiles()` çağırma. Sayaçları
   simüle et ve `plannedRemovals` listesi/ID seti oluştur.
2. `remainingNodes` veya `remainingBytes` hâlâ limit üstündeyse
   `state_retention_exhausted` fırlat; bu noktaya kadar filesystem mutation
   olmamalı.
3. `rawCompactBody` varsa mevcut immutable archive path'ine yaz. Archive,
   checkpoint'ten önce gelir; checkpoint archive'ın authoritative referansıdır.
4. Candidate checkpoint'i `writeImmutable()` ile yayımla. Bu adım başarılıysa
   yeni continuation state authoritative'dir.
5. Yalnız bundan sonra planned checkpoint/archive çiftlerini oldest-first sil.
6. Post-commit prune ilk I/O hatasında durmalı; committed yeni checkpoint geri
   alınmamalı ve publish başarısızmış gibi raporlanmamalı. Content-free warning
   yalnız `planned_n`, `removed_n` ve bounded error code taşıyabilir. Sonraki
   distinct publish veya `cleanup()` kalan prune'ı tekrar deneyebilmelidir.
7. `removeOrphanedArchives()` listesine yalnız gerçekten silinen ID'leri ver;
   failed prune sonucu hâlâ bilinen node'u yanlışlıkla orphan sayma.
8. Idempotent same-response/same-bytes davranışını ve conflict davranışını
   değiştirme.

#### Minimal regression'lar

1. **Exhaustion preserves old state**
   - Default store ile küçük `old` checkpoint yayımla.
   - Aynı `stateDir` üzerinde `maxHeads: 1`, küçük `maxBytes` kullanan ikinci
     store oluştur.
   - Candidate'i tek başına budget'ı aşacak büyük history/output ile yayımla.
   - `state_retention_exhausted`, `old` hâlâ exists/resolves, candidate absent.
2. **Archive commit failure preserves planned removal**
   - `maxNodes: 1` altında unreachable eski node'u planned removal yap.
   - Yeni response ID'si için farklı bytes taşıyan conflicting compact archive
     oluştur.
   - Publish fail; eski node hâlâ exists/resolves; candidate checkpoint absent.
3. **Successful commit prunes afterward**
   - `maxNodes: 1`, iki unrelated head.
   - Yeni checkpoint exists/resolves; eski checkpoint/archive absent.
4. Mevcut concurrent forks, compact archive, cleanup ve tamper testleri green.

#### Kabul ölçütü

- `state_retention_exhausted` öncesinde unlink yok.
- Archive/checkpoint write failure öncesinde unlink yok.
- Başarılı candidate commit'ten sonra yalnız planned unreachable node'lar
  siliniyor; reachable ancestors korunuyor.
- Publication failure client'a completed response/DONE açmıyor.

### WP2 — Exact normal Ollama completion transaction (`C-R1`)

#### Dokunulacak yerler

- `src/codex/ollama-response-boundary.ts`
  - strict completed-envelope validator
  - küçük pure terminal tracker
- `src/codex/ollama.ts`
  - `ollamaSseTransform()` içine route-specific terminal gate
- `src/codex/gateway/responses.ts`
  - `StreamCapture`, `captureObserver`, `isCompleteStreamCapture`
  - `parseSummarizerResponse()`
  - `relayOllama()` JSON ve SSE success boundary
- `src/codex/ollama-dialect.ts`
  - successful JSON contract'ına exact `status: "completed"`
- `src/ollama-response-boundary.test.ts`, `src/state-gateway.test.ts`,
  `src/gateway.test.ts`
  - mevcut positive fixture'larda eksik `object/status/id/output` tamamlanır

Generic `src/codex/sse.ts` permissive primitive'i global olarak
sıkılaştırılmaz. Native compaction'ın specialized
`nativeCompactionResponseError()` authority'si korunur.

#### Exact JSON success kontratı

Normal Ollama response ancak şu koşulların tamamıyla success olabilir:

```text
top-level value is an object
object === "response"
status === "completed"
id is a non-empty string
output is an array
every output item is an object with a non-empty string type
tool calls pass the existing exact final-declaration guard
```

`response.compaction`, nested `{ response: ... }`, status'süz object veya
yalnız `output: []` normal response success değildir. Native compaction ayrı
validator'ında kalır.

JSON sırası:

```text
parse JSON
strict envelope validate
tool/apply_patch guard
normalize model/tool aliases
publish checkpoint
write 2xx client response
```

Validation yoksa mevcut generic, content-free `502 / ollama_response_invalid`
kontratı kullanılmalı; raw body veya upstream field client'a/log'a
yansıtılmamalı ve checkpoint yazılmamalıdır.

#### SSE state machine

Tracker yalnız data-bearing event'leri ve `[DONE]` trailer'ını izler. Blank,
comment ve standart metadata line'ları state transition değildir.

| Current phase | Input | Yeni durum / davranış |
| --- | --- | --- |
| `open` | ordinary valid event | normalize + stream et |
| `open` | exact `response.completed` | terminal frame'i hold et; candidate'i kaydet |
| `open` | `response.failed`, `response.incomplete` veya top-level error | non-success terminal frame'i hold et; checkpoint authority yok |
| `open` | `[DONE]` | `tainted` (premature DONE) |
| terminal held | optional first `[DONE]` | trailer görüldü; hold etmeye devam et |
| terminal held | herhangi data event, ikinci terminal veya ikinci `[DONE]` | `tainted`; held terminali success olarak yayımlama |
| DONE seen | herhangi data event | `tainted`; post-DONE data relay edilmez |
| any | malformed/oversized frame | `tainted`; no checkpoint |
| any | client abort / idle / read error | incomplete; no checkpoint |

EOF kararı:

- Exact tek completed terminal, valid envelope ve hiç taint yoksa önce WP1
  checkpoint publish edilir; başarıdan sonra normalized held terminal ve tam
  bir client `[DONE]` yazılır.
- Exact tek failed/incomplete terminal varsa held non-success terminal bir kez
  yayımlanır, checkpoint yoktur. Mevcut normal Ollama failure semantiği
  korunur; synthetic success terminal/DONE üretilmez.
- Duplicate completed, completed→failed, failed→completed, premature/duplicate
  DONE, post-DONE data, malformed frame veya terminal'siz EOF: no checkpoint,
  held success terminal yok, client DONE yok.
- Terminal frame dışındaki delta/output event'leri buffer'lanmaz. Böylece TTFB
  ve streaming throughput korunur.
- Upstream terminalden sonra hemen cancel edilmez; EOF'a kadar drain edilerek
  contradiction gözlenir. Bu mevcut relay'in EOF bekleme davranışıyla uyumludur.

#### Uygulama ayrıntıları

1. Pure tracker event'i `open`, `completed`, `non_success`, `tainted` olarak
   sınıflandırmalı; string/bool kombinasyonları kullanılmamalı.
2. Tool guard held terminal üzerinde de çalışmalı. Terminal gate, guard'dan
   sonra fakat client normalization'dan önce raw candidate'i kaydetmeli.
3. Terminal event `SSE_OMIT_LINE` ile upstream relay'den tutulmalı. EOF kararı
   başarılıysa `normalizeOllamaResponse()` ile bir kez normalize edilip
   yayımlanmalı.
4. Upstream `[DONE]` her durumda suppress edilir. Başarılı checkpoint sonrası
   cob tam bir `[DONE]` üretir; böylece client exactly-once görür.
5. `parseSummarizerResponse()` aynı strict Ollama envelope/tracker'ı kullanır.
   Summarizer text extraction status'süz veya contradictory response'u başarı
   sayamaz.
6. Native ChatGPT compact, generic SSE primitive ve Gate 5 structural failure
   terminali bu çalışma içinde birleştirilmez. Gate 5 structural failure
   tracker'ı preempt eder ve kendi `response.failed + [DONE]` kontratında
   kalır; Guard'ı geçen Gate 5 success yine strict normal envelope ister.
7. Diagnostics yalnız terminal kind, phase, raw byte count, malformed/done
   boolean/count ve stable reason code taşımalı; payload/id/model/tool adı yok.

#### Minimal regression matrisi

JSON:

- exact valid completed → 2xx + one checkpoint.
- missing `status`, missing/wrong `object`, empty/missing `id`, missing output,
  primitive/typeless output item → 502 + no checkpoint.
- `status: failed|incomplete` → success olarak relay/checkpoint edilmez.
- unrelated `{ ok: "provider-private" }` → generic 502; private value body/logda
  yok.

SSE:

- completed + DONE ve completed + clean EOF → one checkpoint, one completed,
  one client DONE.
- failed→completed, completed→failed, duplicate completed → tainted; no
  checkpoint/DONE.
- DONE→completed, DONE-only, duplicate DONE, post-DONE data → tainted; no
  checkpoint/DONE; trailing private data relay edilmez.
- malformed event→completed ve terminal'siz EOF/idle/abort → no checkpoint/DONE.
- valid declared tool call → success; undeclared/malformed call guard failure
  sticky kalır.
- Existing compaction and no-upstream-DONE tests green.

#### Kabul ölçütü

- Hiçbir invalid/ambiguous 2xx body client success veya checkpoint olamaz.
- Tek bir stream en fazla bir completed terminal ve bir client DONE açabilir.
- Contradictory/duplicate terminal state'e rağmen checkpoint yazılamaz.
- Normal delta streaming ve existing tool/model rewrites byte-semantically
  korunur.

### WP3 — Codex custom-home isolation ve config I/O (`C-I1`, `C-C1`)

#### Custom-home port

Dosyalar: `src/codex/session.ts`, `src/install.test.ts`.

1. `resolveCliSession()` içindeki `resolveListenPort({ isolated: flags.dev })`
   çağrısını hesaplanmış `isolated` shorthand'iyle değiştir.
2. Custom temp `--home`, `--dev` yok: `session.isolated === true` ve port
   `18791`.
3. `--port` ve `COB_PORT` override precedence'ı aynen kalmalı ve sibling
   assertions ile kilitlenmeli.
4. Yalnız Codex session değiştirilir. Aynı pattern Claude'da bulunsa da frozen
   scope nedeniyle `src/claude/session.ts` dokunulmaz.

#### `cob.toml` read taxonomy

Dosyalar: `src/codex/config/toml.ts`, `src/cob-config.test.ts`.

1. `CobConfigError` aynen rethrow.
2. `NodeJS.ErrnoException.code === "ENOENT"` ise `undefined`.
3. Diğer her hata `cob_config_read_failed` gibi stable bir `CobConfigError`
   olarak fail closed olabilir. Mesaj operation, exact path ve bounded errno
   code taşıyabilir; config içeriği taşıyamaz.
4. Missing path → `undefined`; config path bir directory → typed `EISDIR`
   failure; file-as-parent → typed `ENOTDIR`; malformed TOML → mevcut
   `invalid_cob_toml`.
5. Config salvage, backup veya hot-reload sistemi eklenmez.

#### Kabul ölçütü

- Custom Codex home implicit olarak live portu seçemez.
- Explicit port/env override davranışı değişmez.
- Unreadable/mis-typed config sessizce default policy'ye düşemez.
- `src/claude/**` diff'i yoktur.

### WP4 — Bounded Ollama upstream error sanitization (`C-P1`)

Bu paket original review blocker'ı değildir; çapraz keşifte bulunan küçük ve
aynı boundary'ye ait privacy iyileştirmesidir. WP1-WP3'ten bağımsız bir diff
olarak tutulmalıdır.

Dosyalar: `src/codex/ollama-boundary.ts`, `src/ollama-boundary.test.ts`.

1. Quota/rate classification raw ama bounded selected message üzerinde önce
   çalışır; existing code/canned message değişmez.
2. Generic `other` message client'a verilmeden bearer credential ve
   `/Users/...`, `/home/...`, `/root/...`, `C:\\Users\\...` path segmentleri
   redacted edilir.
3. Output message makul bir üst sınırla (örneğin 2048 character) kesilir.
4. Safe ordinary provider message korunur; boş/unsafe sonuç
   `Ollama returned HTTP <status>` fallback'ine döner.
5. Test fixture bearer secret + POSIX path + Windows path içerir; client body ve
   diagnostic hiçbirini içermez. Existing quota/rate/retry-after tests green.
6. OpenCodex'in geniş redaction framework'ü kopyalanmaz; request body capture
   veya yeni logging eklenmez.

### WP5 — Immutable CI ve packed-artifact smoke (`C-CI1`)

Dosya: `.github/workflows/ci.yml`.

#### Workflow kontratı

- Trigger: `pull_request`, `master` push, `workflow_dispatch`.
- `permissions: contents: read` ve branch/ref bazlı concurrency/cancel.
- Trusted actions mutable tag yerine reviewed commit SHA ile pinlenir. Bu local
  keşifteki başlangıç pinleri `actions/checkout`
  `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0` ve `actions/setup-node`
  `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` değerleridir; workflow yazılırken
  owner/repository eşleşmesi tekrar doğrulanır.
- Matrix: Linux + macOS, Node 22 + Node 24. Windows eklenmez; frozen Claude
  Windows claim'i bu Codex cycle içinde yeniden açılmaz.
- Her matrix leg:
  1. clean checkout
  2. Node/npm cache setup
  3. `npm ci`
  4. `npx tsc --noEmit`
  5. `npm test`
  6. `npm run build`
- Tek Linux/Node 22 leg ayrıca:
  1. `npm pack --silent`
  2. tarball'ı `mktemp -d` altındaki local prefix'e install et
  3. packed binary ile `cob version` ve `cob help`
  4. packed file listesinde test/harness/gate6h/eval olmadığını mevcut manifest
     testine ek olarak doğrula

Smoke live home/gateway kullanmaz, `cob start/sync/restore` çağırmaz ve network
catalog discovery istemez. OpenCodex sharding/retry sistemi eklenmez.

#### Kabul ölçütü

- Broken `dist/cli.js`, eksik runtime import veya pack leakage CI'ı kırar.
- Source tests ile packed executable aynı clean checkout'tan doğrulanır.
- CI sonucu static evidence'tır; isolated/live wire gold yerine geçmez.

### WP6 — Doküman ve evidence kapanışı (`C-D1`)

Kod ve static validation tamamlandıktan sonra:

1. `LIVE-TESTING.md` üst bölümündeki stale live `0.2.0` ifadesini authoritative
   `STATUS.md` ile uyumlu live `0.2.1` olarak düzelt.
2. `STATUS.md`: source/workspace evidence ile live install evidence'ı ayrı tut.
   Hardening source'ta olsa bile `:18790` hâlâ 0.2.1 olarak yazılmalı.
3. `RELEASE.md`: yalnız gerçek implementation HEAD/version seçildikten sonra
   source satırını güncelle. Version bump, pack veya install otomatik değildir.
4. `README.md` ve `AGENTS.md` içindeki mevcut Codex-only / Claude-frozen scope
   korunur.
5. `CHANGELOG.md` yalnız yeni source version gerçekten seçilirse güncellenir.
6. “Codex hardening ready” ile “whole product production ready” aynı cümlede
   eşitlenmez; deferred Claude findings açık kalır.

## 6. Uygulama sırası ve bağımlılıklar

```text
baseline snapshot
  ├─ WP1 state transaction
  ├─ WP2 response terminal transaction  (WP1 güvenli publish semantiğine dayanır)
  ├─ WP3 port + config fail-closed
  └─ WP4 error sanitization
          ↓
       WP5 CI + pack smoke
          ↓
       WP6 docs/evidence
```

WP1 ve WP2 aynı geniş refactor'a dönüştürülmemeli. Önce state commit point'i
güvenli hale gelir; ardından terminal success bu commit point'ine bağlanır.
WP3 ve WP4 küçük bağımsız paketlerdir. CI en son eklenmezse bile her paketin
local testleri hemen çalıştırılır; final workflow bütün paketi birlikte kilitler.

## 7. Doğrulama merdiveni

### 7.1 Her iş paketinde targeted

- WP1: conversation-state publish/retention/compact tests.
- WP2: Ollama response-boundary + state-gateway + gateway stream tests.
- WP3: install/session + cob-config tests.
- WP4: Ollama boundary error tests.

Targeted komutlar repo'nun compile-first düzeniyle çalıştırılmalı; test adı
pattern'i kullanılsa bile finalde full suite zorunludur.

### 7.2 Static merge gate

```bash
npx tsc --noEmit
npm test
npm run build
npm pack --dry-run --json
git diff --check
```

Pack manifest'te test, harness, `gate6h` ve `eval-*` bulunmamalıdır.

### 7.3 İzole protocol canary

Static gate sonrasında, live home/listener'a dokunmadan isolated `:18791`
yolunda:

1. Bir real valid Ollama JSON turn ve bir SSE turn.
2. SSE'de upstream DONE'lı ve DONE'sız completed varyantı.
3. Her başarılı turn için client tarafında tam bir completed ve bir DONE;
   private state'te tek checkpoint.
4. `previous_response_id` ile follow-up continuation.
5. Mock/fixture gateway üzerinden duplicate/contradictory/post-DONE invalid
   varyantların zero checkpoint sonucu.
6. Root `~/.codex/config.toml` SHA before/after aynı.

Bu canary source kanıtıdır. `:18790` global replacement, ChatGPT Desktop full
quit/reopen ve yeni live gold ancak ayrıca yetkilendirilmiş release adımıdır.

## 8. Rollback ve failure policy

- WP1 rollback'i kod rollback'idir; hiçbir test gerçek live state'i kullanmaz.
- WP2 invalid stream'de başarı terminali üretmek yerine prefix'i terminal/DONE
  olmadan kapatmak bilinçli fail-closed davranıştır.
- WP3 custom home testleri `mkdtemp` altındadır; live home ve port sahipliği
  etkilenmez.
- WP4 sanitizer classification veya safe message testlerini bozarsa ayrı paket
  olarak geri alınabilir; P0 state/terminal fix'leri etkilenmez.
- CI pack smoke yalnız runner temp prefix'ine install eder; global npm veya live
  gateway mutation yoktur.
- Hiçbir rollback `git reset --hard`, broad recursive delete veya user-owned
  config overwrite kullanmaz.

## 9. Sonraya bırakılan adaylar

Aşağıdaki fikirler değerli olabilir, fakat bu hardening diff'ine eklenmemelidir:

- State temp/checkpoint publication için file + parent-directory `fsync` ve
  power-loss durability çalışması. Logical commit-before-prune fix'inden ayrı
  platform testleri ister.
- Repository-wide privacy scan. Önce WP4 ve packed CI ile somut leak path'i
  kapatılmalı; geniş allowlist/false-positive sistemi şimdilik gereksizdir.
- Shared JSON/SSE conformance framework. WP2'nin table-driven existing test
  extensions yeterlidir; yeni framework ancak ikinci gerçek drift bug'ında
  değerlendirilir.
- Process-local request correlation ID. Log faydası olabilir, protokol header'ı
  yapılmamalıdır ve mevcut blocker'larla bağımsızdır.
- State scan yardımcılarındaki diğer catch-all I/O path'lerinin ayrı audit'i.
  WP1 sırasında davranış değişmeden not alınır; kanıtsız broad error refactor
  yapılmaz.
- Claude overlay/permission/containment/Windows çalışmaları. Kullanıcı Claude
  scope'unu açıkça yeniden açana kadar frozen kalır.

## 10. Referans snapshot kimliği

- cob baseline: git `94a0d9a473040b753192bf3cc8a978d14ec58a6d`.
- CLIProxyAPI baseline: git `f0de1d008fe8881dcb7431cf97b147295874c2b2`.
- Local `opencodex-main` export'unda `.git` metadata yoktur; immutable upstream
  SHA iddiası yapılmaz. İncelenen ana dosya SHA-256 değerleri:
  - `src/responses/state.ts`: `d35e62769ea0667eaf9d1c7d5f8fec6d703bf95a10b9a28db32795867567d3c3`
  - `src/responses/spill-store.ts`: `152ce26a13b7db8a867b2e789497230bc163ed0168eb45d929ee0c267165a354`
  - `src/server/relay.ts`: `9526de452ff9d9c7c1560b9d56249941ff5b905b8ecfd9e367a2bf4077ceb870`
  - `src/adapters/upstream-http-error.ts`: `4875e77e46d96131e7a3e6c0feb15a54ffcb3901efceac2360abe28b7a0f414b`

Bu hash'ler yalnız bu planın çapraz-keşif provenance'ıdır; cob dependency veya
vendor pin'i değildir.
