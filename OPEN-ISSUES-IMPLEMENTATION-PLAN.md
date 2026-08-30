# COB Codex Açık Issue’lar — Part Bazlı Implementasyon Planı

- Tarih: 2026-08-30
- Kod tabanı: `master` / `e6a34495719f`
- Aktif ürün kapsamı: **cob Codex only**
- Kapsam dışı: `src/claude/**`, Claude live `:18792`, live `~/.codex`, Codex
  live `:18790`, commit/push/tag/issue-close/release
- Güncel consumer notu: ChatGPT Desktop `26.825.51511`, bundled Codex
  `0.151.0-alpha.7.2`; güncelleme için acil compatibility patch kanıtı yok
- Uygulama durumu: **Part 0 workspace-complete**; remote CI kanıtı commit/push
  yetkisi verilene kadar bekliyor

Bu plan GitHub issue #1–#10’u güncel koda karşı yeniden ayrıştırır. Amaç bütün
issue’ları tek büyük patch’e çevirmek değil; her partı kendi invariantı, kırmızı
regresyon testi ve kanıt seviyesiyle kapatmaktır.

## 1. Çalışma ağacı ve koruma sınırı

Plan hazırlanırken var olan ve korunması gereken dirty durum:

- `src/lifecycle.test.ts`: #9 için hermetik fake-Codex fixture’ı
- `AGENTS.md`, `CHANGELOG.md`, `CODEX-HARDENING-PLAN.md`, `LIVE-TESTING.md`,
  `RELEASE.md`, `STATUS.md`: kullanıcı/başka çalışma tarafından değiştirilmiş
  dokümanlar; bu plan tarafından düzenlenmez
- `.idea/`: ilişkisiz untracked IDE verisi; pakete veya patch’lere alınmaz

Her part başlamadan önce `git status --short` yeniden okunur. Başka partın veya
kullanıcının değişikliği revert edilmez. Aynı dosyaya dokunan partlar sıralı
uygulanır.

## 2. Güncel disposition

| Issue | Güncel durum | Plan |
| --- | --- | --- |
| #9 CI merge gate | Part 0 workspace-complete; remote matrix henüz çalışmadı | Remote matrix yeşili issue-close kanıtıdır |
| #8 exact-row `apply_patch` | Açık; gateway yetkisi global | Part 1 |
| #4 state transaction | Ana transaction kapalı; lock altında parent-chain revalidation açık | Part 2A |
| #5 strict terminal | Normal Ollama yolu kapalı; native-compaction SSE ordering açık | Part 2B |
| #7 lifecycle ownership | Custom-home/config kısmı kapalı; lease/log/rollback kalıntıları açık | Part 3 |
| #6 config/CLI policy | ENOENT taksonomisi kapalı; bypass/parser/slug/flag/port açık | Part 0 + Part 4 |
| #1 exec tools | Açık ürün boşluğu; current Codex A/B kanıtı geçerli | Part 5 + izole `0.151` canary |
| #10 shared gaps | Açık; birbirinden bağımsız mikro-partlar | Part 6 |
| #2, #3 Claude | Gerçek fakat bilinçli frozen | Yetki verilene kadar uygulanmaz |

Önemli yeniden inceleme sonucu: #5 tamamen kapanmış sayılmaz. Normal Ollama
terminal transaction’ı sağlamdır; ancak native ChatGPT compactor’dan gelen SSE
hala boolean/candidate capture kullanır ve terminal sırasını doğrulamaz.

## 3. Uygulama sırası

```text
Part 0  CI hermetiklik + production skip-hook kaldırma
  ↓
Part 1  exact-row apply_patch authorization
  ↓
Part 2  state lineage + native-compaction terminal ordering
  ↓
Part 3  detached-start lease/log/root-config ownership
  ↓
Part 4  strict cob.toml + spawn slug + CLI/port grammar
  ↓
Part 5  tool-capable rows için unified_exec
  ↓
Part 6  bounded I/O + atomic/private filesystem + loopback/platform mikro-partları
```

Part 5 davranış/capability açtığı için güvenlik ve state partlarından sonra
gelir. Part 6 kendi içinde bölünebilir; Part 6A/6B diğerlerinden bağımsızdır.

---

## Part 0 — #9 CI hermetikliği ve #6A skip-hook kaldırma

### Hedef

CI’nın temiz runner’da ortam PATH’i veya production bypass env’i olmadan aynı
katalog üretici/consumer sözleşmesini test etmesi.

### Dosyalar

- `.github/workflows/ci.yml`
- `src/lifecycle.test.ts`
- `src/codex/catalog/sync.ts`
- yalnız gerekirse ilgili sync testleri

### Değişiklik

1. Dirty tree’deki fake Codex fixture korunur:
   - executable fixture bir minimal native katalog üretir;
   - `discovery.pathBin` ve `inspect.readVersion` açıkça enjekte edilir;
   - ambient PATH kullanılmaz.
2. `COB_SKIP_CATALOG_CHECK` production hook’u `sync.ts` içinden kaldırılır.
3. `lifecycle.test.ts` içindeki dört env mutation kaldırılır. Bu testler zaten
   fake producer/validator sağladığı için bypass gerekmez.
4. Workflow tarball adını `npm pack --silent` çıktısından almayı sürdürür;
   boş/eksik dosya fail-closed kalır.

### Kırmızı test

- Clean env + PATH’te Codex yokken profile refresh fixture’ı geçmeli.
- Geçersiz consumer fixture katalog commit’ini durdurmalı; artık env ile bypass
  edilememeli.

### Done

- Targeted lifecycle/sync testleri yeşil.
- Full Linux/macOS × Node 22/24 remote matrix yeşil.
- Pack manifest ve isolated-prefix `cob version`/`cob help` smoke yeşil.
- #9 ancak remote run URL’si oluşunca kapatılabilir. Lokal başarı tek başına
  issue-close kanıtı değildir.

---

## Part 1 — #8 exact routed-row `apply_patch` authorization

### Hedef

Gate 5’in global gateway boolean’ını, her request için exact catalog row
capability’siyle daraltmak.

### Dosyalar

- `src/codex/gateway/responses.ts`
- `src/gateway.test.ts`
- gerekirse yalnız test catalog fixture’ları

### Değişiklik

1. Request başında alınan tek `catalogSnapshot` yetki kaynağıdır.
2. Küçük helper exact slug eşleşmesi yapar:

   ```ts
   catalogRowSupportsApplyPatch(catalog, model)
   // true yalnız row.apply_patch_tool_type === "freeform"
   ```

3. Effective policy:

   ```ts
   options.applyPatch === true && catalogRowSupportsApplyPatch(snapshot, threadModel)
   ```

4. Aynı request-scoped boolean hem `prepareOllamaPayload()` hem
   `forwardOllamaResponses()` için kullanılır.
5. Compaction-trigger yolunda yetki summarizer/compact modelinden değil,
   konuşmanın `threadModel` satırından türetilir. Summarizer’ın kendi toolsuz
   isteğinde patch köprüsü kapalı tutulur.
6. Catalog yoksa, row yoksa veya capability exact `freeform` değilse yetki
   false olur. Custom patch declaration bu durumda upstream fetch’ten önce
   mevcut `ollama_custom_tool_unsupported` sınırında reddedilir.
7. Native satırlar ve sıradan non-patch Ollama istekleri etkilenmez.

### Kırmızı testler

- Config/global Gate 5 açık + capability’siz `ollama/...:cloud` custom patch:
  4xx, upstream hit `0`.
- Catalog dışı `ollama/not-in-catalog`: aynı fail-closed sonuç.
- Capability taşıyan configured `:0731-cloud`: mevcut bridge round-trip geçer.
- Native model: patch-free kalır.
- Trigger/continuation: yetki thread row’a bağlı kalır; compact model yetki
  yükseltemez.

### Referans mirası

- OpenCodex’ten yalnız request-scoped catalog snapshot + exact declared-tool
  map fikri alınır.
- Generic provider registry, `nativeAlias` ve delimiter repair authorization
  olarak alınmaz.

### Done

- Unauthorized declaration upstream’e ulaşmaz, checkpoint üretmez ve content
  loglamaz.
- Gate default-off ve isolated-only kalır.

---

## Part 2A — #4 lock altında full parent-chain revalidation

### Hedef

Request hazırlanırken var olan fakat publish lock’u alınana kadar prune edilmiş
bir parent üzerinden dangling child commit edilmesini engellemek.

### Dosyalar

- `src/codex/state/store.ts`
- `src/conversation-state.test.ts`

### Değişiklik

1. `publish()` lock’u aldıktan ve abort’u kontrol ettikten sonra, parent varsa
   mevcut bounded `resolve(node.parentResponseId)` ile **tam ancestry** yeniden
   doğrulanır.
2. Doğrulama archive/checkpoint commit’inden önce yapılır. Parent-presence-only
   kontrol kullanılmaz; kırık grandparent da reddedilir.
3. Missing/corrupt/cyclic/depth-limit chain mevcut typed state hatalarıyla
   fail-closed olur.
4. Önceki geçerli state ve candidate archive/checkpoint bytes değişmeden kalır.

### Kırmızı fixture

`maxNodes=2`, `maxHeads=1`:

1. `root` publish.
2. `a(parent=root)` publish; `c(parent=a)` draft’ı request tarafında hazırlanır.
3. Sibling `b(parent=root)` publish ve retention `a`yı prune eder.
4. Stale `c` publish denenir.

Beklenti: `state_checkpoint_missing`/typed incompatible failure; `c` dosyası
yok; önceki valid state aynı.

### Done

- Restart sonrası hiçbir retained head eksik ancestry’ye işaret etmez.
- #4’ün transaction, retention exhaustion ve injected I/O testleri yeşil kalır.

---

## Part 2B — #5 native-compaction SSE terminal ordering

### Hedef

Native compactor SSE’sinde normal Ollama yoluyla aynı terminal-order
garantisini uygulamak; specialized compaction-envelope doğrulamasını korumak.

### Dosyalar

- `src/codex/gateway/responses.ts`
- `src/codex/ollama-response-boundary.ts` yalnız mevcut tracker API’si küçük
  bir compose ihtiyacı gösterirse
- `src/state-gateway.test.ts` ve/veya `src/gateway.test.ts`

### Değişiklik

1. Native compaction SSE transform’u mevcut terminal tracker’ı **tek kez**
   besler; `captureObserver` compaction output item’ını toplamaya devam eder.
2. Başarı yalnız:
   - exact `response.completed` terminali tutulmuşsa,
   - tracker `tainted` değilse,
   - en fazla bir terminal-sonrası `[DONE]` varsa,
   - `nativeCompactionResponseError(candidate)` exact bir compaction item ve
     ciphertext doğruluyorsa mümkündür.
3. `[DONE]` native upstream için opsiyoneldir; erken veya çift DONE yasaktır.
4. Contradiction/malformed/post-terminal data durumunda raw SSE client’a
   başarı olarak relay edilmez; checkpoint/archive yazılmaz; sanitized 502
   üretilir.
5. Unary native JSON yolu specialized envelope validator’ı kullanmaya devam
   eder; permissive capture helper checkpoint authority olmaz.

### Table-driven kırmızı testler

- `completed → failed`
- `failed → completed`
- iki valid `completed`
- `[DONE] → completed`
- `completed → [DONE] → data`

Her case: HTTP 502, checkpoint/archive yok, opaque ciphertext/error content
başarı gövdesinde yok.

### Referans mirası

- OpenCodex/CLIProxyAPI’den split frame, multiline frame, valid→malformed ve
  data-only EOF fixture fikirleri alınabilir.
- “first terminal wins” alınmaz; COB contradictory terminali taint etmelidir.

### Done

- #5 normal + summarizer + native-compaction SSE yollarının tamamında strict
  terminal ordering kanıtına sahip olur.

---

## Part 3 — #7 detached-start ve ownership safety

Bu part aynı dosya çevresinde üç sıralı alt dilime ayrılır.

### Part 3A — lease transaction ve rollback

Dosyalar: `src/codex/runtime/lifecycle.ts`, `src/core/lock.ts`, focused
`src/lifecycle.test.ts`.

Değişiklikler:

1. Healthy-runtime early return’dan önce lease okunur.
2. Runtime pid+nonce ile lease pid+nonce exact eşleşirse:
   - launcher hala aktif: “start in progress”; lease temizlenmez;
   - launcher ölü/yok ve child health exact: orphan lease lock altında
     temizlenir, sonra `alreadyRunning` dönülür.
3. Active veya mismatched lease otomatik temizlenmez.
4. Final commit sırası `runtime/files/health verify → clear lease → return`
   olur. Lease son doğrulamadan önce kaldırılmaz.
5. `spawnServe` child döndürmeden throw ederse de snapshot restore edilir;
   child reap yalnız child varsa yapılır.
6. `waitForLockAdopted()` lock record kaybolduğunda canlı child’ı başarı
   saymaz; timeout/death’e kadar bekleyip fail-closed olur.

Kırmızı testler:

- Healthy exact child + dead launcher orphan lease reconcile.
- Live launcher lease korunur.
- Final health/file failure sırasında lease hâlâ rollback ownership kanıtıdır.
- `spawnServe` pre-child throw sonrası overlay byte-equivalent restore.
- Canlı child + externally vanished lock handoff başarı sayılmaz.

Stop-during-start mevcut ürün kararıdır; bu part cancellation protokolü
eklemez.

### Part 3B — log target ve descriptor ownership

Dosyalar: `src/codex/cli.ts`, gerekirse küçük bir Codex/shared private-file
helper ve focused test.

Değişiklikler:

- Log `O_NOFOLLOW | O_APPEND | O_CREAT | O_WRONLY` ile açılır (desteklenen
  POSIX platformlarda).
- Açılmış fd `fstat` ile regular-file ve mevcut uid ownership açısından
  doğrulanır; `fchmod(0600)` uygulanır.
- Symlink, directory ve foreign-owned target spawn’dan önce reddedilir.
- Parent fd, detached child kendi descriptor kopyasını aldıktan sonra
  `try/finally` ile her başarı/hata yolunda kapanır.
- Yeni isolated home yaratılırken mode `0700` verilir; var olan user-owned
  `~/.codex` chmod edilmez.

Kırmızı testler: symlink log, directory target, non-private existing mode,
spawn failure sonrası kapanan fd. FD-count snapshot yerine observable
close/write davranışı tercih edilir.

### Part 3C — root-config read taxonomy

`readRootConfig()` yalnız `ENOENT` için `null` döndürür. `EACCES`, `EISDIR`,
`ENOTDIR` ve diğer I/O hataları typed/content-free failure olur. Snapshot ve
final comparison aynı semantics’i kullanır.

### Done

- Lease commit/rollback exact pid+nonce ownership taşır.
- Orphan lease güvenle uzlaştırılır; active/mismatched ownership fail-closed.
- Log path symlink izleyemez ve parent descriptor sızdırmaz.
- Root config unreadable durumu “missing” sayılmaz.

---

## Part 4 — #6 strict config ve CLI policy

### Part 4A — dar fakat strict `cob.toml` grammar

Dosyalar: `src/codex/config/toml.ts`, `schema.ts`, `resolve.ts`,
`src/cob-config.test.ts`.

Kurallar:

- Yeni runtime dependency eklenmez; COB’un yazdığı TOML subset’i için
  quote-aware küçük scanner kullanılır.
- `#` yalnız string dışında comment başlatır.
- Desteklenen multiline string-array korunur; escaped quote doğru işlenir.
- Malformed table header, key/value olmayan satır, unterminated quote/array,
  duplicate section/key, wrong scalar type ve bilinmeyen supported-section key
  fail-closed olur.
- Ortak slug validator:
  - exact `ollama/<non-empty-id>`;
  - trim sonrası eşitlik;
  - whitespace/control karakter yok;
  - native slug yok;
  - duplicate yok.
- Aynı validator file config, env spawn listesi ve compact Ollama modelinde
  kullanılır.

Kırmızı testler: quoted `#`, multiline arrays, escaped quote, duplicate key,
malformed table/scalar, `ollama/`, native slug, whitespace/control ve duplicate
spawn model.

### Part 4B — tek-pass CLI grammar ve port parser

Dosyalar: `src/cli-session.ts`, `src/install.test.ts` ve ilgili CLI testleri.

Kurallar:

- Her flag known, command-applicable ve doğru arity’de olmalıdır.
- Unknown flag, missing value, extra positional ve inapplicable flag reddedilir.
- Port yalnız decimal digit string’dir; `Number("1e3")` gibi formlar yasaktır.
- Explicit `--port` ve `COB_PORT` aynı ortak parser ile `1..65535` aralığını
  uygular.
- Malformed env sessiz fallback yapmaz; typed config/CLI failure olur.
- `--smoke`, `--dev`, `--home`, `--port` parse ediliyorsa uygulanır; aksi halde
  açıkça reddedilir.

Kırmızı testler: unknown/missing/inapplicable flags, `--port 1e3`, `0`,
`65536`, invalid env; `1` ve `65535` pozitif kontroller.

### Referans mirası

- OpenCodex `parseReadyArgs` içindeki single-pass, digits-only, bounded integer
  ve pre-side-effect validation kalıbı alınır.
- OpenCodex tolerant diagnostic TOML parser’ı ve Bun dependency’si alınmaz.

### Done

- #6 acceptance yüzeyi file/env/CLI için tek deterministic policy’ye iner.

---

## Part 5 — #1 tool-capable Ollama rows için `unified_exec`

### Tasarım kararı

Issue’daki hermetik A/B geçerlidir. Current Codex `exec_command` ve
`write_stdin` araçlarını ordinary `ToolSpec::Function` / `function_call`
olarak üretir. COB’un mevcut declaration guard ve function-call normalization
yolu bunu zaten taşır. Yeni `shell_call` veya `local_shell_call` bridge’i
gerekmiyor ve eklenmeyecek.

### Dosyalar

- `src/codex/capabilities.ts`
- `src/codex/catalog/catalog.ts`
- `src/capabilities.test.ts`, `src/catalog.test.ts`
- gerekli mevcut function-call/gateway fixture’ları
- capability değiştiği için `README.md`; live kanıt sonrası ilgili status/live
  docs

### Değişiklik

1. `OllamaChildProfile.supportsShell` boolean olur.
2. Yalnız **fresh başarılı** `/api/tags` yanıtındaki exact lowercase `tools`
   capability’si `supportsShell=true` üretir.
3. Catalog:
   - tools row → `shell_type="unified_exec"`;
   - no-tools/unknown/fallback row → `shell_type="disabled"`.
4. Validator yalnız bu iki exact değeri kabul eder ve generated evidence ile
   uyumu test eder.
5. Configured spawn row fresh evidence’de tools taşımıyorsa fail-closed olur;
   capability’siz row spawn window’a sessizce sokulmaz.
6. Discovery timeout/error/fallback önceki positive `unified_exec` alanını
   koruyamaz. Mevcut fallback `tools:false` reconstruction davranışı sürer.
7. `tool_mode`, V2, parallel calls, `apply_patch`, `shell_call` ve
   `local_shell_call` açılmaz.

### Kırmızı testler

- tools tag → unified exec.
- no-tools, unknown ve case-variant token → disabled.
- discovery fallback, önceki unified row’u disabled’a indirir veya candidate
  commit’ini fail-closed bırakır; stale positive yayınlanmaz.
- `exec_command` ve `write_stdin` ordinary declared function call olarak kabul
  edilir.
- undeclared name ve `local_shell_call` halen reddedilir.

### İzole `0.151` canary — merge’den ayrı live gate

Yalnız `~/.codex-cob-dev` / `:18791`:

1. Fresh 0731 tag ile candidate catalog `unified_exec`; no-tools control
   `disabled`.
2. Bundled Codex `0.151.0-alpha.7.2` candidate catalog’u kabul eder.
3. Child outbound request’te `exec_command` + `write_stdin` görünür.
4. Tek harmless command ordinary `function_call → function_call_output`
   continuation ile tamamlanır.
5. `shell_call/local_shell_call`, V2 ve live `:18790` değişikliği yoktur.

Canary geçmeden README dışındaki live-production claim’leri ve issue close
yapılmaz.

---

## Part 6 — #10 paylaşılan mikro-partlar

### Part 6A — bounded tags/health response

- `src/core/ollama/tags.ts` `response.json()` yerine küçük byte cap’li
  `readLimitedResponse()` + JSON parse kullanır.
- Runtime health JSON reader aynı bounded/time-limited primitive’i kullanır.
- Oversize/timeout/malformed body typed ve content-free failure olur.
- CLIProxyAPI’den yalnız `max+1` okuyup oversize reddetme kalıbı alınır;
  generic proxy reader kopyalanmaz.

### Part 6B — atomic temp cleanup ve mode preservation

- `writeFileAtomic()` write/rename dahil her failure’da yalnız kendi unique tmp
  dosyasını `finally` içinde temizler.
- Explicit mode verilmediyse mevcut target regular file’ın mode’u korunur;
  yeni target process umask davranışını dokümante eder veya çağıran sensitive
  yüzey explicit mode verir.
- Crash durability/fsync claim’i eklenmez; bu ayrı ürün kararıdır.
- Sensitive COB-owned state/config/lease files `0600`, COB-owned yeni
  directory’ler `0700`; mevcut user-owned root home chmod edilmez.

### Part 6C — loopback normalization ve credential rejection

- Tek shared normalizer `127.0.0.1`, case-normalized `localhost` ve bracketed
  URL formundaki `[::1]` / bind `::1` değerlerini yönetir.
- URL username/password her zaman reddedilir.
- Invalid URL error’u raw URL/password echo etmez.
- Root-config `openai_base_url` kontrolü aynı helper’ı kullanır; duplicate
  hostname mantığı kaldırılır.

### Part 6D — bounded-reader abort race

- `readLimitedResponse()` her awaited `reader.read()` sonrasında abort’u tekrar
  kontrol eder; cancel’ın `{done:true}` ile partial success dönmesine izin
  verilmez.
- Deterministic pending-read + abort fixture `BodyAbortedError` bekler.

### Part 6E — platform ve ek I/O taksonomisi

Bu dilim #10 kapanışından önce ayrı scope kontrolü ister:

- catalog file read yalnız ENOENT’i first-write saysın;
- catalog producer stdout/stderr bounded ve sanitized olsun;
- desteklenen platformlar README + CI ile macOS/Linux olarak eşleşsin;
- Windows destek iddiası yoksa erken ve açık unsupported-platform hatası
  verilsin.

Bu maddeler Part 6A–6D ile aynı patch’e zorla birleştirilmez.

---

## 4. Claude issue’ları #2 ve #3

Issue’lar geçerlidir fakat bu cycle’da uygulanmaz:

- `src/claude/**` değişmez.
- Claude manifest v2, home canonicalization, isolated port ve Desktop egress
  ayrı kullanıcı yetkisiyle tek Claude hardening döngüsünde ele alınır.
- Deferred Claude bulguları Codex-scoped merge’i bloklamaz; yeni whole-product
  production-ready claim’ini engellemeye devam eder.

## 5. Doğrulama merdiveni

Her part:

1. Değişiklik olmadan kırmızı regression kanıtı.
2. En dar ilgili test dosyaları.
3. `npx tsc --noEmit`.
4. Part sonunda `git diff --check`.

Birden çok part merge adayı olduğunda:

```bash
npx tsc --noEmit
npm test
npm run build
npm pack --dry-run --json
git diff --check
```

Pack gate:

- `dist/cli.js` var;
- test, harness, `gate6h`, `eval-*`, `.idea`, plan/evidence fixture’ları yok;
- isolated prefix smoke `cob version` + `cob help` geçer.

Kanıt seviyeleri karıştırılmaz:

- Unit/workspace test: merge correctness.
- Remote CI: #9 immutable gate.
- Isolated `:18791`: #1 current Desktop/Codex behavior proof.
- Live `:18790`: yalnız ayrıca yetkilendirilmiş packed release/gold turu.

## 6. Doküman ve issue kapanış kuralı

- #9: remote matrix URL’si sonrası close.
- #4/#5/#7/#8/#6/#10: regression + full merge gate sonrası close edilebilir;
  live claim gerektiren ifade yazılmaz.
- #1: merge gate yanında bundled `0.151` isolated canary gerekir.
- `CHANGELOG.md`: yalnız kullanıcıya görünen CLI/capability değişikliklerinde.
- `README.md`: `shell_type` ve config/CLI public contract değiştiğinde.
- `STATUS.md`/`LIVE-TESTING.md`: yalnız gerçekten ölçülen yeni machine/live
  evidence için.
- `RELEASE.md`: mevcut dirty kaydı korunur; yeni cut yapılacaksa aynı byte’larla
  `0.2.2` repack edilmez ve ayrıca version kararı alınır.

## 7. Sonraki implementasyon handoff’u

Part 0 workspace’te tamamlandı: mevcut `lifecycle.test.ts` fake-Codex fixture’ı
korundu, production `COB_SKIP_CATALOG_CHECK` hook’u ve test env mutasyonları
kaldırıldı. Remote CI kanıtı commit/push yetkisine bağlıdır.

Sonraki kod turu **Part 1 / issue #8** olmalıdır. Exact catalog-row
`apply_patch` authorization küçük ve güvenlik-sınırı odaklıdır; lifecycle’ın
daha geniş Part 3 değişikliklerinden önce bağımsız kırmızı/yeşil kanıtlanır.
