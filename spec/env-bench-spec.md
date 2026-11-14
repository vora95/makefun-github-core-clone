# Spesifikasi env + bench — github-core-clone-01 (spec presisi, bukan opini)

Sumber yang dibaca penuh (kit `~/workspace/makefun/github-core-clone-01-kit/github-core-clone-01-kit/`):

| File | Isi |
|---|---|
| `program/env/src/export.ts` (235 baris) | Penulis `state.json`/`perf.json`, aturan never-worse |
| `program/env/src/bench.ts` (877 baris) | 4 workload bench |
| `program/env/src/main.ts` (1060 baris) | Alur env: boot → checks → bench → export |
| `program/env/src/wire.ts` (1305 baris) | Konstanta, Scenario/`buildScenario`, StateFile/PerfFile, working bit |
| `program/env/src/manifest.ts` | Grup check (120), rumus skor, workload + T_ref (dibaca sebagai pendukung) |
| `program/env/src/calibration.json` | Nilai T_ref terukur (pendukung) |
| `competition.yaml` (457 baris) | **Lokasi benar: di root kit, BUKAN `rules/`** — aturan trial, skor, hadiah |
| `rules/instance.yaml` (41 baris) | Limits + beacon practice/scored |
| `practice/trial-{0,1,2}/reference/scenario.json` | Metadata seed per trial |
| `sdk/run.ts`, `starter/README.md`, `RULES.txt` (§ Grade locally) | Local runner |

Catatan koreksi terhadap brief tugas: `competition.yaml` tidak ada di `rules/` — yang ada di `rules/` hanya `instance.yaml`; `competition.yaml` ada di root kit. Nilai-nilai Scenario di §4 diverifikasi dengan menjalankan `buildScenario()` dari `wire.ts` (Node 22, `--experimental-strip-types`), bukan ditebak.

---

## 1. Alur trial lengkap

### 1.1 Pihak-pihak dan env var

- **Entry** (forge peserta): satu proses, `node /bot/main.ts` (Node 22) atau `python3 /bot/main.py` (Python 3.13), di repo root. Hanya stdlib + source yang di-vendor di repo; tidak ada install, tidak ada `git` binary, tidak ada layanan luar.
- **Env** (suite tersegel): `program/env/server.mjs` (build dari `env/src/*`); di trial mendengarkan port **8080** (default `MAKEFUN_ENV_PORT`; `0` = pilih port bebas). Env var yang diterima entry: `MAKEFUN_ENV_URL` (asal env, mis. `http://store:8080`), `MAKEFUN_SHOP_TOKEN` (bearer token untuk semua API call ke entry), `MAKEFUN_STATE_DIR` (state dir di luar container; di container `/state`).
- Env mendengarkan di `MAKEFUN_ENV_HOST` bila diset; bila tidak: `0.0.0.0` di container, `127.0.0.1` di bawah process driver. `reusePort: false` (tanpa `SO_REUSEPORT`).

### 1.2 Urutan fase (main.ts `runSuite` / `startEnv`)

```
0. startEnv: bind listener → tulis <state>/calls.ndjson KOSONG → tulis <state>/ready
   → konfirmasi <state>/ready terbaca kembali (READY_WAIT_MS = 30.000 ms)
   → jalankan runSuite di background, terus serve sampai SIGTERM
1. BOOT: tunggu register pertama (RegisterGate) → GET /healthz 2x
2. CONFORMANCE: install fixture git GraphQL → 120 check, satu per satu, sekuensial
3. BENCHMARK: 4 workload (bench.ts), sekuensial
4. EXPORT: tulis export/state.json dulu, lalu export/perf.json → GET /done = {"done": true}
5. DONE: entry exit 0; harness SIGTERM env → env tulis/pertahankan export → exit 0
```

Detail tiap langkah:

**Langkah 0 — listen + ready.**
- Setelah bind, env menulis `<stateDir>/ready` berisi `{"schema":"github-core-clone-01/ready/v1","host":…,"port":…}` (rename atomik via file `.tmp`), dan file `<stateDir>/calls.ndjson` kosong (harness menyimpannya sebagai env log; env tidak melakukan model call, jadi log tetap kosong — tidak pernah dipalsukan).
- Env menunggu `ready` terbaca kembali sampai 30 detik (`READY_WAIT_MS`); gagal baca → `finishSuite` langsung (export boot-failure, lihat §1.5).
- Harness menunggu file `ready` sebelum menjalankan entry.

**Langkah 1 — boot.**
- Entry **wajib**: bind port ephemeral sendiri (`listen(0)`; **dilarang bind 8080**), lalu `POST $MAKEFUN_ENV_URL/register` dengan body JSON `{"port": N}`.
  - Port valid: integer 1..65535 (`MIN_PORT`/`MAX_PORT`); body maks `MAX_REGISTER_BODY_BYTES = 65.536` byte.
  - Register pertama: HTTP **200** `{"ok": true}`. Register berikutnya: **409** `{"ok": false, "error": "already_registered"}` — base URL pertama tetap dipakai, tidak berpindah.
  - Body bukan JSON / port tidak valid: **400**; method bukan POST: **405**.
  - Env menurunkan base URL entry dari alamat asal request (`req.socket.remoteAddress`, dinormalisasi: `::ffff:a.b.c.d` → IPv4, bracket IPv6 dilepas, suffix zona `%eth0` dibuang) + port yang dinamai: `http://<host>:<port>`, tanpa trailing slash.
- Batas boot: `BOOT_BUDGET_MS = 20.000 ms` untuk register pertama (dibatasi juga oleh sisa deadline internal). Setelah register, env melakukan **boot probe**: `GET <entry>/healthz` sebanyak `HEALTHZ_ATTEMPTS = 2` kali, dalam `HEALTHZ_BUDGET_MS = 10.000 ms` (juga dibatasi sisa deadline). Keduanya harus menjawab HTTP 200 (body tidak diperiksa selain status; response body dibuang).
- `bootOk = true` hanya bila register ada DAN healthz menjawab 2/2.

**Langkah 2 — conformance.**
- Sebelum check pertama, env menginstal fixture git untuk check GraphQL (`configureGraphQLGit(createGitFixture(...))`): adapter yang membuat repo lewat REST lalu push branch yang dipakai check pull-request GraphQL, lewat `GitClient` env sendiri. Satu call `pushBranch` dibatasi `FIXTURE_PUSH_BUDGET_MS = 12.000 ms`; satu request git fixture maks `FIXTURE_REQUEST_TIMEOUT_MS = 4.000 ms`; commit fixture memakai epoch tetap `FIXTURE_EPOCH_SEC = 1.735.689.600`.
- Urutan check (tetap, `suiteChecks()`): `[...GIT_CHECKS, ...restChecks(), ...restProtocolChecks(), ...GRAPHQL_CHECKS, ...MCP_CHECKS]` — 120 check, **satu per satu, tidak pernah paralel**, masing-masing dengan timeout dan `AbortSignal` sendiri.
  - Timeout per check: default `CHECK_TIMEOUT_MS = 15.000 ms`, dijepit ke `CHECK_TIMEOUT_MIN_MS = 5.000` .. `CHECK_TIMEOUT_MAX_MS = 15.000 ms`, lalu dijepit lagi ke sisa fase (`checkTimeoutMs`).
  - Check yang timeout: dicatat 0 dengan detail `"deadline"`; sinyalnya di-abort; check berikutnya tetap jalan setelah drain maks `CHECK_DRAIN_GRACE_MS = 1.000 ms` (promise yang ditinggalkan diberi waktu itu untuk settle).
  - Check yang throw / mengembalikan hasil non-boolean: dicatat gagal (`fail('threw …')` / `'the check returned no result'`).
  - Check yang belum sempat jalan saat deadline fase/deadline internal jatuh: dicatat 0 dengan detail `"deadline"`.
- Validasi manifest: `validateCheckSpecs` memeriksa jumlah per grup cocok dengan manifest (git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15, protocol 5; total 120), tanpa id duplikat, id berbentuk `<group>.<slug>`, judul tidak kosong. **Perilaku kode (bukan komentar header)**: bila ada issue, env hanya mencatatnya ke log lalu **tetap menjalankan suite**; export kemudian mengisi check yang tidak terdaftar dengan id `<group>.missing-<n>` bit 0 (`exportCheckIds` di export.ts), sehingga denominator tetap 120. (Komentar header main.ts menyebut "refuses … then no check runs" — itu bertentangan dengan kode `runConformance`; yang berlaku adalah kode.)
- Fase conformance dibatasi `CONFORMANCE_BUDGET_MS = 240.000 ms` DAN deadline internal (yang lebih dulu habis yang menang: `phaseEnd = min(deadline, now + 240.000)`).

**Langkah 3 — benchmark.** Lihat §3. Dibatasi `BENCHMARK_BUDGET_MS = 240.000 ms` DAN deadline internal. Bila entry null / trial di-abort / deadline sudah jatuh sebelum bench: perf = `failedPerfFile(...)` (sentinel, §3.5).

**Langkah 4 — export + done.**
- `finishSuite` menulis pasangan export via `writeExportPair` (**state.json dulu, lalu perf.json** — supaya run yang terpotong di antara keduanya tidak pernah memasangkan perf baru dengan state lama), masing-masing dengan aturan keep-better (§2.4).
- Setelah export tertulis, `GET $MAKEFUN_ENV_URL/done` menjawab `{"done": true}`. Sebelum itu menjawab `{"done": false}` **seketika, tidak pernah di-hold** (batas jawab `DONE_ANSWER_DEADLINE_MS = 1.000 ms`). Method bukan GET: 405. Route lain di env: JSON 404.
- Entry mem-poll `/done` (interval awal `DONE_POLL_INTERVAL_MS = 250 ms`, eksponensial ganda sampai maks `DONE_POLL_MAX_MS = 2.000 ms`; satu request poll tidak boleh di-hold lebih dari `DONE_REQUEST_TIMEOUT_MS = 30.000 ms`); saat `{"done": true}` entry **exit 0** (`ENTRY_EXIT_OK`).

**Langkah 5 — shutdown.**
- Harness SIGTERM env sesudahnya. Handler SIGTERM/SIGINT (`runEnv`): `stop()` → abort trial → tulis/pertahankan export (aturan keep-better) → `done = true` → tutup listener → **exit 0**. Idempotent.
- Bila SIGTERM/SIGINT datang **sebelum** listener siap: tulis boot-failure export lalu `process.exit(0)`.
- `uncaughtException` / `unhandledRejection` / throw fatal: tulis boot-failure export lalu **exit 1**.

### 1.3 Deadline internal dan wall budget

| Konstanta | Nilai |
|---|---|
| `TRIAL_WALL_BUDGET_SEC` (wall budget trial) | **900 detik** |
| `DEADLINE_MARGIN_MS` | **90.000 ms** |
| Deadline internal (`deadlineOf`) | `startedAt + wall*1000 − 90.000` = **810 detik** sejak env start (clock `performance.now()`; `MAKEFUN_TRIAL_WALL_BUDGET_SEC` dapat meng-override wall untuk local run) |
| `BOOT_BUDGET_MS` | 20.000 ms |
| `HEALTHZ_BUDGET_MS` | 10.000 ms |
| `CONFORMANCE_BUDGET_MS` | 240.000 ms |
| `BENCHMARK_BUDGET_MS` | 240.000 ms |
| `EXPORT_BUDGET_MS` | 30.000 ms |
| `READY_WAIT_MS` | 30.000 ms |
| `DEADLINE_EXIT_GRACE_MS` | 5.000 ms |

- Saat deadline internal jatuh: check yang masih pending dicatat 0 `"deadline"`, workload bench yang tersisa **tidak pernah dimulai** (bench.ts juga menerapkan deadline yang sama di dalam workload), export tetap ditulis, `/done` dijawab, dan proses exit setelah grace 5 detik bila harness belum SIGTERM.
- Jam: deadline memakai clock monotonik `performance.now()`; data scenario tidak pernah memakai jam dinding (`Date.now` dilarang untuk data — hanya waits yang memakai `Date.now`).

### 1.4 Kalau entry lambat / crash

| Kejadian | Akibat (persis) |
|---|---|
| Tidak register sebelum boot budget habis (20 dtk, atau sisa deadline) | **Boot failure**: semua check 0, `working = 0`, note tetap `"no entry registered before the boot deadline"` (`BOOT_FAILED_NOTE`), perf = sentinel gagal (0 poin, `perf_p50_us = 1e9`), `/done` langsung `true`. Skor 0. |
| Register tapi `/healthz` tidak 2/2 dalam 10 dtk | `bootOk = false` → `working = 0` (working butuh bootOk DAN ≥1 check lolos, §2.3). Conformance tetap jalan (entry sudah terdaftar); check yang lolos tetap dihitung di `counts.passed`, tapi kolom `working` tetap 0. |
| Entry exit / crash di tengah conformance | Check yang sedang jalan: timeout/abort → 0. Check yang belum jalan: 0 `"deadline"` bila deadline jatuh, atau tetap dicoba selama fase masih punya waktu — env mendial entry yang sudah mati dan call gagal → check gagal. Export tetap ditulis dari hasil yang ada (SIGTERM handler juga menulis export). |
| Entry lambat: satu check > 15 dtk | Check itu 0 `"deadline"`, sisanya tetap jalan. |
| Seluruh fase conformance > 240 dtk | Sisa check 0 `"deadline"`, lanjut ke bench bila deadline internal masih ada. |
| Workload bench > budgetnya | Workload itu 0 poin, `p50_ms = p99_ms = 1e9` (sentinel), round yang sudah selesai tetap tercatat di `rounds`; workload berikutnya tetap dicoba selama fase bench masih punya waktu. |
| Trial masih jalan melewati wall 900 dtk | Dihentikan; skor 0 di semua kolom (competition.yaml: "A trial whose program is still running after 900 seconds is stopped and scores 0 on every column"). Deadline internal 810 dtk dirancang supaya export sempat tertulis sebelum itu. |
| Env di-SIGTERM kapan pun | Export ditulis/dipertahankan (keep-better), exit 0 — trial yang mati di tengah suite meninggalkan export yang bisa dinilai, bukan tidak ada. |
| Throw fatal di env (uncaught/unhandled) | Boot-failure export ditulis, exit 1. |

### 1.5 Skor (dari manifest.ts + competition.yaml — untuk konteks alur)

- Grup check: git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15, protocol 5 → **total 120**.
- `feature = round(600 × passed / total)` (0..600); `agent = round(200 × passedMcp / 15)` (0..200; grup mcp dihitung dua kali: di feature dan sebagai kolom agent); `perf` = jumlah 4 workload, masing-masing `round(clamp(25 − 12,5 × log2(t_ms / T_ref_ms), 0, 50))` (0..200); `score = feature + agent + perf` (0..1000).
- Tie-break: `perf_p50_us` menaik (geometric mean 4 median workload, dalam mikrodetik, dibulatkan), lalu receipt lebih awal. Build cost tidak pernah memutus tie.
- Baseline (house reference forge): hadiah mensyaratkan skor **di atas** baseline secara statistik — interval-t 90% berpasangan dari keunggulan per-instance harus > 0; interval yang menyentuh 0 = seri statistik, tidak mengalahkan.

---

## 2. Format `state.json` dan `perf.json` yang diekspor env

**PENTING — entry TIDAK menulis export.** Entry hanya: bind port, register, melayani request suite, poll `/done`, exit 0. Kedua file di bawah ditulis **oleh env** (`export.ts` `writeExportPair`, dipanggil `main.ts` `finishSuite`/`stop`) ke `<stateDir>/export/` (`<stateDir>` = `MAKEFUN_STATE_DIR`, atau `/state` di container). File ditulis **sinkron dan atomik**: file sementara di samping file target → tulis → `fsync` → `rename`. Byte file = `canonicalJsonLine`: JSON dengan key diurutkan di setiap kedalaman + satu newline akhir — sehingga dua run dari entry yang sama pada seed yang sama menghasilkan byte yang identik.

### 2.1 `export/state.json` — `StateFile`, `version: 1`

```json
{
  "version": 1,
  "working": 0,
  "checks": { "git.<slug>": 0, "repos.<slug>": 1, "...": 0 },
  "counts": {
    "total": 120,
    "passed": 0,
    "byGroup": {
      "git":      { "total": 30, "passed": 0 },
      "repos":    { "total": 15, "passed": 0 },
      "issues":   { "total": 15, "passed": 0 },
      "pulls":    { "total": 20, "passed": 0 },
      "graphql":  { "total": 20, "passed": 0 },
      "mcp":      { "total": 15, "passed": 0 },
      "protocol": { "total": 5,  "passed": 0 }
    }
  },
  "perfTiers": { "push": 0, "clone": 0, "read": 0, "write": 0 },
  "notes": ["no entry registered before the boot deadline"]
}
```

- `version`: `STATE_VERSION = 1`.
- `working`: `Bit` 0|1 — lihat §2.3.
- `checks`: **satu bit 0|1 untuk setiap dari 120 id check** dalam bentuk `<group>.<slug>` (mis. `git.clone-empty`); check yang tidak pernah jalan = 0. Id yang tidak ada di manifest diabaikan saat menghitung counts; id yang hilang dari export dihitung 0. Bila suite mendaftarkan check lebih sedikit dari manifest, export mengisi kekurangannya dengan id `<group>.missing-<n>` bit 0 (padding, §1.2).
- `counts`: diturunkan dari bit (`countsFromChecks`): `total` **selalu 120** (denominator tidak bisa dikecilkan dengan menghilangkan check), `passed` = jumlah bit 1, `byGroup` = total deklarasi + passed per grup.
- `perfTiers`: **di `state.json` SELALU keempat workload bernilai 0** (`STATIC_PERF_TIERS` di export.ts: `{push: 0, clone: 0, read: 0, write: 0}`). Ini keputusan yang dirancang (ruling): `state.json` tidak boleh mengandung nilai yang diturunkan dari waktu ukur, supaya replay dua run dari entry yang sama membandingkan byte-demi-byte tanpa noise waktu. Band ukur yang sebenarnya hidup di `perf.json` (`tiers`) saja; `manifest.ts` `perfTiersOf()` adalah fungsi yang mengubah poin ukur menjadi band, dan ia dipanggil oleh `bench.ts`, **bukan** oleh export state.
- `notes`: opsional, hanya bila tidak kosong; berisi **penyebab tetap saja** (string tetap, tanpa waktu/port/id acak) — dalam praktik hanya `[BOOT_FAILED_NOTE]` = `["no entry registered before the boot deadline"]` pada boot failure; pada run yang ter-register, `notes = []` sehingga field ini **dihilangkan** dari file.
- **Tidak ada** di `state.json`: waktu, port, tanggal, id acak, detail log check (detail hanya masuk log stderr, tidak pernah masuk export).

Validasi scorer (`isStateFile`): `version === 1`, `working` 0|1, semua bit 0|1, semua tier 0..4, `counts.total/passed` integer ≥ 0, tiap grup punya `total/passed` integer ≥ 0, `notes` bila ada harus array string. Bila tidak valid, scorer men-zero-kan kolom.

Boot-failure export (`bootFailureExport` / `bootFailureState`): semua check 0, `working = 0`, counts zeroed (tiap grup total deklarasi, passed 0), `perfTiers: {}` (pada varian `bootFailureState` di wire.ts) atau `{push:0,…}` (pada varian export.ts `stateExportOf` — keduanya valid sebagai `Record<string, PerfTier>`), `notes: ["no entry registered before the boot deadline"]`.

### 2.2 `export/perf.json` — `PerfFile`, `version: 1`

```json
{
  "version": 1,
  "calibrated": true,
  "workloads": [
    {
      "name": "push",
      "rounds": [1640.1, 1590.4, 1702.9],
      "p50_ms": 1640.1,
      "p99_ms": 1702.9,
      "ops": 200,
      "points": 25,
      "error": "deadline: the workload did not finish inside its 60000 ms budget"
    }
  ],
  "tiers":  { "push": 2, "clone": 2, "read": 2, "write": 2 },
  "points": { "push": 25, "clone": 25, "read": 25, "write": 25 },
  "perf_p50_us": 805899,
  "points_total": 100,
  "notes": []
}
```

(contoh angka di atas ilustratif untuk bentuk; `error` hanya ada bila workload gagal/0 poin, dan dihilangkan bila tidak ada.)

- `version`: `PERF_VERSION = 1`.
- `calibrated`: boolean — `true` bila **semua** T_ref > 0 saat run dibuat (`isCalibrated`). Bila ada T_ref = 0, workload itu tetap jalan (ukurannya dibutuhkan kalibrasi) tapi mendapat 0 poin, `error` = `"uncalibrated: T_ref is 0, so the workload earns 0 points until calibration fills it"`, dan ada note `"T_ref is uncalibrated (0) for <nama>: those workloads earn 0 points"`. Pada kit ini semua T_ref terkalibrasi (lihat §3.6), jadi `calibrated: true`.
- `workloads`: array 4 entri (urutan push, clone, read, write), tiap entri:
  - `name`: `"push" | "clone" | "read" | "write"`.
  - `rounds`: `number[]` — wall time tiap round yang **selesai**, dalam ms, sesuai urutan, dibulatkan ke 0,001 ms (`roundMs`). Round yang tidak selesai tidak ada di sini.
  - `p50_ms`: median round (nearest-rank percentile 50, §3.4); bila gagal/dipotong: sentinel `FAILED_P50_MS = 1.000.000.000` (1e9), **bukan 0** — 0 akan menang tie-break secara tidak sah.
  - `p99_ms`: percentile 99 (dengan 3 round = round terbesar); bila gagal: 1e9.
  - `ops`: operasi tetap per round dari manifest (push 200, clone 50, read 2000, write 200).
  - `points`: 0..50, dihitung ulang dari `p50_ms` dan T_ref saat file dirakit (`workloadPoints`); gagal/tidak terkalibrasi = 0.
  - `error` (opsional): alasan 0 poin bila gagal/dipotong/tidak terkalibrasi; dihilangkan bila tidak ada.
- `tiers`: `{push, clone, read, write}` → `PerfTier` 0..4 = `floor(points / 12,5)`, dijepit 0..4. Inilah band ukur yang sebenarnya (berbeda dengan `perfTiers` di `state.json` yang statis 0).
- `points`: `{push, clone, read, write}` → poin 0..50 per workload.
- `perf_p50_us`: tie-break — `round(1000 × geometric mean dari p50_ms workload yang MENGUKUR saja)`; sentinel yang gagal (1e9 ms) **tidak pernah** masuk mean. Bila **tidak ada** workload yang mengukur: `FAILED_PERF_P50_US = 1.000.000.000`. Dijepit maks 1e9.
- `points_total`: 0..200 — kolom perf (jumlah keempat `points`).
- `notes`: array string (selalu ada, bisa kosong) — baris tetap: nama T_ref yang tidak terkalibrasi, kegagalan per workload (`"<nama>: <error>"`), `"no workload measured: perf_p50_us is the sentinel 1000000000"` bila tidak ada yang mengukur, atau `"perf_p50_us is the geometric mean of the <n> workload(s) that measured"` bila hanya sebagian mengukur. Tanpa free text / tanpa waktu.

Perf file untuk trial tanpa bench sama sekali (`failedPerfFile`, dipakai saat boot failure / bench tidak jalan): keempat workload sentinel (`rounds: []`, `p50_ms = p99_ms = 1e9`, `points: 0`, `error` = alasan, mis. `"no entry registered before the boot deadline"`), `points_total = 0`, `perf_p50_us = 1e9`. **Bukan** `emptyPerfFile` dari wire.ts (semua nol, `perf_p50_us = 0`) — 0 akan menempati urutan pertama tie-break; `main.ts` secara eksplisit memilih `failedPerfFile`.

Validasi scorer (`isPerfFile`): `version === 1`, `calibrated` boolean, tiap workload punya `name` non-empty, `rounds` array angka finite, `p50_ms`/`p99_ms` finite, `ops` integer ≥ 0, `points` integer 0..50, `tiers` record tier 0..4, `points` record integer 0..50, `perf_p50_us` integer ≥ 0, `points_total` integer 0..200, `notes` array string.

### 2.3 Working bit

`workingBit(bootOk, passedChecks) = 1` **hanya bila** `bootOk === true` DAN `passedChecks > 0`; selain itu 0. Artinya: entry ter-register dan healthz 2/2, dan minimal satu check lolos. `working` tidak menentukan skor maupun tempat (kolom display saja), tetapi membedakan "forge naik dan menjawab" dari "tidak naik".

### 2.4 Aturan never-worse (keep-better)

`writeStateExport` / `writePerfExport` default `keepBetter: true`:

- **state.json**: file yang sudah ada di disk **dipertahankan** bila export baru lebih buruk: working baru < working lama → tolak; working sama tapi `counts.passed` baru < lama → tolak. Sama atau lebih baik (working lebih tinggi, atau working sama dan passed ≥) → tulis (yang sama ditulis ulang; bytenya sama). Tujuannya: run yang selesai bertahan terhadap boot failure / abort berikutnya di state dir yang sama.
- **perf.json**: file lama dipertahankan bila `points_total` baru < lama; bila baru ≥ lama → tulis.
- `writeExportPair` menulis **state dulu, lalu perf**, masing-masing dengan aturan di atas.
- `keepBetter: false` selalu menulis (dipakai hanya oleh jalur internal tertentu; jalur normal tidak memakainya).

---

## 3. Detail 4 workload bench

Sumber: `bench.ts` + `manifest.ts` `BENCH_WORKLOADS` / `BENCH_ROUNDS` / `BENCH_WARMUP_OPS`.

### 3.1 Kerangka umum (berlaku untuk keempatnya)

- **Jam**: `performance.now()` (monotonik), wall time satu round. Semua waktu dibulatkan ke 0,001 ms saat dicatat.
- **Round**: `BENCH_ROUNDS = 3` round berwaktu per workload. **Warm-up**: `BENCH_WARMUP_OPS = 5` operasi **tanpa waktu** sebelum round pertama.
- **Setup di luar waktu, di dalam budget**: pembuatan repo, histori clone, dan pembuatan issue setup terjadi di dalam budget workload tapi **di luar** round berwaktu mana pun. Semua payload dibangun **sebelum** clock pertama jalan (push: semua blob/tree/commit + pack; write: semua judul issue; clone: seluruh histori 200 commit dalam satu pack), sehingga hashing/deflate objek tidak pernah terukur.
- **Determinisme data**: semua data bench berasal dari `buildScenario()` dan stream RNG berlabel `scenarioRng('bench.push' | 'bench.clone')`; tidak ada `Math.random`, tidak ada `Date.now` untuk data. Commit bench memakai epoch tetap `BENCH_EPOCH_SEC = 1.700.000.000` + indeks.
- **Budget per workload**: `budgetMs = 60.000 ms` per workload (dari manifest), dijepit ke sisa fase bench (`BENCHMARK_BUDGET_MS = 240.000 ms` sejak call pertama) dan ke deadline internal env — yang terkecil yang berlaku. Timer meng-abort request in-flight tepat saat budget habis; setiap operasi dicek ke clock **sebelum** mulai (`run.check()`).
- **Gagal = 0 poin + stop dini**: workload yang throw, setup gagal, operasi ditolak (mis. push ditolak, clone tanpa pack / checksum gagal, create issue bukan 201, GET issue bukan 200), atau tidak menyelesaikan semua round dalam budget → 0 poin dan berhenti dini. **Round yang sudah selesai sebelum gagal tetap tercatat** di `rounds`, tetapi `p50_ms`/`p99_ms` menjadi sentinel 1e9 (bukan angka ukur parsial — pengukuran parsial tidak boleh memenangkan tie-break).
- **Urutan eksekusi**: push → clone → read → write (urutan `BENCH_WORKLOAD_NAMES`). Workload yang tidak sempat dijalankan (fase habis / trial di-abort) mendapat entri sentinel dengan error `"the benchmark phase deadline fell before the workload ran"` / `"the trial was aborted before the workload ran"`.
- **Repo bench**: dibuat baru per workload dan **dihapus dulu** (`DELETE` repo, lalu `POST` create — `GitClient.createRepo` menerima 422 "sudah ada") supaya re-run dalam proses entry yang sama mulai dari repo kosong dan rantai push pertama memakai `oldOid = ZERO_OID` lagi. Owner repo bench = `scenario.viewer.login` (lihat §4).
- `runBenchmark` tidak pernah throw karena perilaku entry (kegagalan workload menjadi `error` di entrinya); ia hanya throw untuk kesalahan pemanggil (tanpa base URL, nama workload tidak dikenal).

### 3.2 push — 200 push sekuensial, perubahan 1 KiB

- **Satu round**: 200 operasi `pushOnce()` **sekuensial**, masing-masing satu pertukaran receive-pack (advertisement + command list + pack) yang membuat satu commit baru di `refs/heads/main` pada repo **`bench-push`**.
- **Satu operasi**: commit yang treenya memegang satu file **`bench-data.txt`** dengan blob segar `PUSH_CHANGE_BYTES = 1.024` byte; pack hanya membawa 3 objek yang belum dimiliki server (blob, tree, commit). Commit pertama: `oldOid = ZERO_OID` (membuat branch); berikutnya: `oldOid` = commit sebelumnya. Pesan commit: `"bench: push <n>\n"`, timestamp `1.700.000.000 + index`, author/committer `CONFORMANCE_IDENTITY`.
- **Jumlah payload yang dibangun di muka**: `warmupOps + rounds × ops = 5 + 3 × 200 = 605` payload (command + pack). Satu round memakai 200 payload berikutnya secara berurutan.
- **Syarat lolos satu operasi**: response report-status ada (`report !== null`), `unpackOk === true`, dan ada baris report untuk `refs/heads/main` dengan `ok === true`. Bila tidak → workload throw → 0 poin.
- `ops = 200`, `budgetMs = 60.000`.

### 3.3 clone — 50 clone dangkal konkuren dari repo 200 commit

- **Setup**: repo **`bench-clone`** dibuat baru; satu push membawa **seluruh histori** `CLONE_HISTORY_COMMITS = 200` commit di `refs/heads/main` (tiap commit mengganti satu file **`history.txt`** dengan blob `CLONE_CHANGE_BYTES = 512` byte; pesan `"bench: history <n>\n"`). Pack histori dibangun sekali di luar waktu.
- **Satu round**: **50 operasi clone konkuren** (`Promise.all` atas 50 `cloneOnce()`), masing-masing **shallow clone depth 1, single-branch**, terhadap repo 200-commit itu.
- **Satu operasi clone**: `git.clone(..., {depth: 1, parse: false, singleBranch: true})` — pack **diverifikasi checksum-nya** tetapi **objek tidak di-parse** (`parse: false`: parsing objek adalah pekerjaan check conformance; bench tidak boleh mengukur client). Gagal bila: `checksumOk !== true`, `packBytes <= 0`, atau `refs.length === 0` → throw → 0 poin.
- Warm-up: 5 clone (sekuensial, sebelum round pertama). `ops = 50`, `budgetMs = 60.000`.
- Perhatian: walau clone konkuren, round diukur sebagai wall time keseluruhan `Promise.all` ke-50 clone itu, bukan jumlah waktu per clone.

### 3.4 read — 2.000 GET issue sekuensial, satu koneksi keep-alive

- **Setup**: repo **`bench-read`** dibuat baru; satu issue dibuat lewat REST (`POST /api/v3/repos/{owner}/bench-read/issues`, judul = `"<scenario.issues[0].title> (bench setup)"`, body = `scenario.issues[0].body`); harus 201 dan mengembalikan `number` integer positif — itu nomor issue yang dibaca.
- **Satu round**: 2.000 operasi `readOnce()` **sekuensial**: `GET /api/v3/repos/{owner}/bench-read/issues/{number}` pada **satu `RestClient` yang sama** (pool undici memakai ulang socket — koneksi keep-alive yang sudah hangat). Harus 200 dengan body objek JSON; bila tidak → throw → 0 poin.
- Warm-up: 5 read. `ops = 2.000`, `budgetMs = 60.000`.

### 3.5 write — 200 pembuatan issue sekuensial

- **Setup**: repo **`bench-write`** dibuat baru. Semua payload dibangun di muka: `5 + 3 × 200 = 605` issue; judul ke-`i` = `"<scenario.issues[i % 60].title> [bench <i+1>]"`, body = template issue scenario yang sama (60 template berputar).
- **Satu round**: 200 operasi `writeOnce()` **sekuensial**: `POST /api/v3/repos/{owner}/bench-write/issues` dengan `{title, body}`. Harus **201** (status create-issue GitHub); bila tidak → throw → 0 poin.
- Warm-up: 5 write. `ops = 200`, `budgetMs = 60.000`.

### 3.6 Cara median & poin dihitung

- **Median (p50)**: `percentileMs(rounds, 50)` — nearest-rank: urutkan round menaik, `rank = ceil(p/100 × n)`, ambil indeks `rank − 1`. Dengan 3 round: **p50 = round tengah**, **p99 = round terbesar**. (p99 juga nearest-rank percentile 99.)
- **Poin per workload**: `workloadPoints(p50_ms, T_ref_ms) = round(clamp(25 − 12,5 × log2(p50_ms / T_ref_ms), 0, 50))`. Waktu = T_ref → 25 poin; setengah T_ref → 38; dua kali → 13; seperempat atau kurang → 50. Waktu hilang/nol/non-finite atau T_ref = 0 → 0 poin. Poin dihitung ulang dari p50 saat `perfFileOf` merakit file, jadi pemanggil tidak bisa menyisipkan poin yang tidak diperoleh.
- **Tier**: `perfTier(points) = floor(points / 12,5)`, dijepit 0..4 (50 poin → tier 4).
- **Kolom perf**: jumlah keempat poin (0..200).
- **Tie-break** `perf_p50_us`: `perfTieBreakUs(p50_ms)` = `round(1000 × exp(mean(ln(max(p50_ms, 0,001))))` atas workload yang mengukur saja; tiap waktu di-floor di 0,001 ms supaya round 0 ms tidak membuat mean 0. Bila tidak ada yang mengukur: 1e9.
- **T_ref terkalibrasi** (`calibration.json`, median dari 3 run dev baseline di klaster produksi, `measured_at: 2026-11-14`):

| Workload | T_ref (p50_ms) | Run-run p50_ms (3 run) |
|---|---|---|
| push | **1640,82** | 1914,548 / 1640,82 / 1415,785 |
| clone | **266,941** | 266,941 / 313,634 / 259,436 |
| read | **2759,715** | 2874,092 / 2759,715 / 2428,118 |
| write | **348,965** | 448,01 / 348,965 / 289,433 |

  Pada T_ref ini, reference forge mendapat 25 poin/workload = 100/200 bila mengukur tepat seperti median 3 run. (Nilai rig lama 2026-11-13 — push 514,838 dst. — hanya histori di file, bukan T_ref lagi.)

### 3.7 Ringkasan tabel workload

| Workload | ops/round | Round | Warm-up | Budget | Repo | Operasi |
|---|---|---|---|---|---|---|
| push | 200 | 3 | 5 | 60 dtk | `bench-push` | push sekuensial, commit 1 KiB (`bench-data.txt`), `refs/heads/main` |
| clone | 50 | 3 | 5 | 60 dtk | `bench-clone` | 50 clone depth-1 konkuren, repo 200 commit, checksum saja |
| read | 2.000 | 3 | 5 | 60 dtk | `bench-read` | GET issue sekuensial, 1 koneksi keep-alive |
| write | 200 | 3 | 5 | 60 dtk | `bench-write` | POST create issue sekuensial, harus 201 |

Fase bench total: maks 240 dtk untuk keempatnya + deadline internal.

---

## 4. Isi Scenario dan pemakaian lintas check

### 4.1 Sumber determinisme

- Satu seed tetap: `SCENARIO_SEED = 0x6a09e667f3bcc909n` (`SCENARIO_SEED_HEX = "6a09e667f3bcc909"`), di `wire.ts`. **Tidak pernah berubah.**
- PRNG: `Rng` = **xorshift64\*** (state 64-bit, tiga shift + satu kali, mask `2^64−1`); seed per stream = `mix64(SCENARIO_SEED ^ fnv1a64(label))` (FNV-1a 64-bit atas label, lalu finalizer splitmix64). `scenarioRng(label)` memberi stream bernama yang independen per label — label sama → angka sama, di proses mana pun dan dalam urutan pemakaian apa pun. Tidak ada `Math.random`, tidak ada jam untuk data.
- `buildScenario()` membangun scenario **sekali** (cache) dari seed itu, lalu `deepFreeze`. Live, replay, dan local practice run melihat objek yang sama, field demi field, byte demi byte.
- **File `practice/trial-{0,1,2}/reference/scenario.json` BUKAN scenario lengkap** — isinya hanya metadata seed (ketiganya identik kecuali `t` dan `seed`):

```json
{ "schema": "github-core-clone-01/scenario/v1", "competition": "github-core-clone-01",
  "scenario_seed": "6a09e667f3bcc909", "purpose": "practice", "k": 0, "t": 0,
  "seed": "371c9c0e0aace432ba4ad68194bada8740441c8bc3b848df49ffee68e7e9a38a" }
```

  - trial-0: `t: 0`, `seed: 371c9c0e…e7e9a38a`; trial-1: `t: 1`, `seed: 00ac170e…ecfe243a92b2b`; trial-2: `t: 2`, `seed: 3abbf036…fbf2e492a8b21`. Struktur ketiganya identik (field yang sama, nilai `seed` berbeda; `scenario_seed`, `k: 0`, `purpose: "practice"` sama). Seed trial itu berasal dari generator instance (drand round 33447412, `k = 0`); seed ini **tidak** mengubah isi `buildScenario()` — scenario env selalu dari `SCENARIO_SEED` tetap di atas. (Trial scored memakai `k = 0`, `t = 0..2`, dari drand round pertama pada/ setelah final dimulai, 2026-11-21T06:40:00Z — lihat `instance.yaml`.)
- Epoch scenario: `SCENARIO_EPOCH_SEC = 1.735.689.600` (2025-01-01T00:00:00Z); setiap timestamp generate = epoch ini + offset seed (maks 90 hari).

### 4.2 Isi `Scenario` (nilai aktual, diverifikasi dengan menjalankan `buildScenario()`)

| Field | Jumlah / nilai |
|---|---|
| `seed` | `"6a09e667f3bcc909"` |
| `viewer` (user pertama, pemilik semua repo bench & repo check) | id **1000**, login **`adaiversen`**, nama `ada iversen`, email `adaiversen@example.invalid` |
| `teammate` (user ke-2) | id 1001, login `quinnkeller`, `quinn keller`, `quinnkeller@example.invalid` |
| `stranger` (user ke-3) | id 1002, login `olgabauer`, `olga bauer`, `olgabauer@example.invalid` |
| `users` | **12** user, id 1000..1011, login unik (`adaiversen, quinnkeller, olgabauer, dmitriquist, adanovak, zanerossi, pavelcosta, wrenkeller, coraquist, elenaulrich, tesssato, svenrossi`); login = nama depan+nama belakang huruf kecil, email `<login>@example.invalid`, nama = `"<depan> <belakang>"` (huruf kecil semua) |
| `org` | **`faint-meadow-org`** |
| `repos` (viewer) | **30**, id 5000..5029, owner `adaiversen`, nama `<adjective>-<noun>` unik (contoh 5 pertama: `amber-thistle`, `happy-willow`, `happy-ember`, `crisp-thistle`, `nimble-delta`), `fullName = "<owner>/<name>"`, `description` dari 8 deskripsi tetap, `private = true` bila `i % 7 === 3`, `defaultBranch = "main"` |
| `orgRepos` | **6**, id 6000..6005, owner `faint-meadow-org` (contoh: `quick-ember`, `mellow-comet`, `happy-kettle`, `amber-raven`, …) |
| `strangerRepos` | **3**, id 7000..7002, owner `olgabauer` (`gentle-comet`, `faint-raven`, `upbeat-orchid`) |
| `labels` | **6**: `bug, enhancement, documentation, question, good first issue, help wanted` |
| `branches` | **11**: `main, develop, release/1.0` + 8 generate unik (aktual: `docs/graphql-cursor-pagination`, `feature/issue-label-validation`, `feature/push-report-status-checks`, `fix/repo-pagination`, `perf/issue-label-validation`, `docs/repo-pagination`, `perf/conditional-requests-2`, `fix/shallow-fetch-support`) |
| `filePaths` | **60** path unik, kedalaman 0–2 dir dari 20 segmen (`src, lib, docs, test, …`) + `<stem>.<ext>` (20 stem, 10 ekstensi: `ts, js, json, md, txt, yml, toml, css, html, sql`) |
| `blobs` | **24** — 24 path pertama dari `filePaths`, konten ASCII `64 + rng.nextInt(4033)` byte (kata-kata NATO + kata sifat, dipisah spasi / newline 14%); tiap blob membawa `path`, `content`, `base64` (base64 standar dari UTF-8). Contoh: `config/token.css` (2023 byte), `server.toml` (1349 byte), `examples/index.json` (3282 byte) |
| `commits` | **60** — `{message, author, epochSec, iso}`; pesan = `<Verb> <Object>` (15 verb × 15 objek) + kadang (35%) satu baris body; author dipilih acak dari 12 user; timestamp epoch + 0..90 hari. Contoh: `"Tidy issue pagination"` (adaiversen, 2025-02-10T08:19:57Z); `"Extract token checks"` (adaiversen, 2025-01-25T10:43:08Z) |
| `issues` | **60** template — `{title, body, labels}`; judul = `<Adjective> <Subject>` (10 adjective × 12 subject, mis. `"Incorrect GraphQL node ids"`); body 1–3 kalimat dari 6 awal × 6 akhir kalimat; `labels` = 50% satu label acak dari 6 label, 50% kosong |
| `pulls` | **30** template — `{title, body, head, base}`; judul = `<Verb> <Subject>` (8 verb × 10 subject, mis. `"Improve MCP tool schemas"`); `head` = nama branch generate (`<kind>/<subject-slug>`, kind ∈ `feature, fix, perf, docs, chore`); `base` selalu `"main"` |
| `DEFAULT_BRANCH` | `"main"` (juga default branch tiap repo scenario) |

Kata-kata pembangun (tetap, di `wire.ts`): 25 nama depan, 26 nama belakang, 28 adjective repo, 28 noun repo, 8 deskripsi, 20 segmen path, 20 stem file, 10 ekstensi, 40 kata blob, 15 verb commit, 15 objek commit, 10 adjective issue, 12 subject issue, 10 subject pull, 6 awal + 6 akhir kalimat, 6 label, 3 branch default.

### 4.3 Bagaimana scenario dipakai lintas check (deterministik)

- Setiap check menerima **satu** `CheckContext` yang memuat `scenario: Scenario` yang sama (objek hasil `buildScenario()` di `main.ts`, diteruskan ke semua 120 check dan ke bench). **Tidak ada check yang membangun datanya sendiri** — semua nama user/repo, path file, konten blob, pesan commit, judul/body issue & PR berasal dari scenario ini.
- Akibatnya: live, replay, dan local run memakai nama/path/isi yang **identik byte-demi-byte**; replay membandingkan `state.json` byte-demi-byte dan bisa lolos hanya karena datanya deterministik. Satu-satunya hal yang boleh berbeda antar run adalah waktu ukur — dan waktu ukur itu sengaja **tidak masuk** `state.json` (§2.1).
- Bench memakai scenario yang sama: owner repo bench = `scenario.viewer.login` (`adaiversen`); issue setup read memakai `scenario.issues[0]`; judul write memakai `scenario.issues[i % 60]`; data push/clone memakai stream `scenarioRng('bench.push' / 'bench.clone')` (label terpisah dari label pembangun scenario, jadi tidak mengganggu urutan stream scenario).
- Token: setiap API call env ke entry membawa `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; repo dimiliki oleh login yang dinamai token — repo yang sama di bawah owner lain adalah 404, bukan 403.

---

## 5. Limits

### 5.1 Limits trial (competition.yaml `limits` + `rules/instance.yaml` `limits` — identik)

| Limit | Nilai |
|---|---|
| CPU (entry) | **2** |
| Memori (entry) | **1024 MB** |
| Proses (entry) | **256 pids** |
| Wall budget | **900 detik** |
| Ukuran entry | maks **16 MiB** total source, **8 MiB** per file (termasuk git library yang di-vendor / binary statis) |
| Submission | maks **5/hari**, **10 total** per entrant; entry terakhir sebelum deadline = entry final |

- **Env sendiri** (dari `calibration.json` `pod.env`, bukan dari competition.yaml): 2 CPU, 256 MiB, 64 pids — env dan entry berbagi pod yang sama pada layout `pod`, sehingga "checks dan workloads berjalan di samping program dan berbagi total itu, jadi sisakan ruang untuk suite" (competition.yaml).
- Layout: `pod` (produksi: entry + env satu sandbox pod; forwarder di lane grader) atau `split` (env pod sendiri, entry pod sendiri). Wire tidak bergantung pada layout: base URL selalu alamat asal request register.
- **/bot read-only** — repo peserta di-mount read-only di `/bot`; entry **hanya boleh menulis di `/tmp`**. Tidak ada network selain ke suite di dalam pod (pod tidak mencapai network di luar suite; satu-satunya pengecualian adalah model gateway bila entry memanggil model — dan bounty ini `model_calls: optional`, entry scripted tanpa model call adalah legal).
- Runtime: Node 22 atau Python 3.13; stdlib + source yang di-commit saja; tidak ada install/paket/native addon; binary statis Linux amd64 yang di-commit boleh jalan sebagai vendored source.
- Entry harus bind port ephemeral sendiri dan **tidak pernah bind 8080** (port env).
- Hadiah: $500 total, 20 tempat ($100 / $70 / $50 / $20×7 / $14×10), USDC di Solana. Deadline: buka 2026-11-14T06:30:00Z, tutup 2026-11-21T06:30:00Z; final 2026-11-21T06:40:00Z–18:40:00Z. Final bertahap: semua entry 1 trial kualifikasi di instance scored pertama (live); 60 terbaik (+ yang seri dengan peringkat 60) + baseline lanjut ke 3 instance, tiap trial live + replay; peringkat contender = mean skor 3 instance.
- Instance: practice 3 (drand quicknet round 33447412, 2026-10-28T00:00:00Z, `k = 0`); scored 3 (`instances: 3`, round 34146612, 2026-11-21T06:40:00Z, pertama yang terbit pada/setelah final dimulai). Seed trial = `sha256("agent-fun/instance/trial/v1" || u32be(k) || u32be(t) || signature 48-byte round drand)`.

### 5.2 Batas lain yang mengikat

- Check: timeout 5–15 dtk (default 15 dtk), satu per satu.
- MCP: tiap request harus dijawab dalam 3 detik (aturan kompetisi).
- Model (bila entry memanggil model): hanya `claude-haiku-5-5`, `gpt-6-luna`; budget $0,02/trial, maks 20 request, maks 1024 output token/request, maks 262.144 byte body/request. Bounty ini tidak mewajibkan model call.
- Transkrip wajib pada tiap submission (gate 8 check; gagal gate = tidak dinilai).

---

## 6. Cara menjalankan local runner (grade-local) dari kit

Jalankan dari **direktori root kit** (`.../github-core-clone-01-kit/github-core-clone-01-kit/`). Prasyarat: **Node 22** (kit's local runner dan entry sama-sama jalan di Node 22, runtime yang dipakai grader; tidak ada yang perlu di-install).

### 6.1 grade-local — perintah persis (dari RULES.txt § Grade locally)

```sh
# Satu trial live (practice trial-0), lalu replay check — driver docker (eksak)
node cli/makefun.mjs grade-local --kit . --bot <repository> --driver docker

# Beberapa practice trial (trial 0 s.d. n-1)
node cli/makefun.mjs grade-local --kit . --bot <repository> --driver docker --instances <n>

# Replay check saja dari cassette yang tersimpan (tanpa biaya)
node cli/makefun.mjs grade-local --kit . --bot <repository> --driver docker --replay <cassette>
```

- `<repository>`: path repo entry (atau URL repo — sesuai CLI; di kit dipakai sebagai path/identifikasi repo entry yang dinilai).
- Yang dilakukan grade-local: memeriksa **semua file** yang terdaftar di `kit.json` (sha256 + ukuran) sebelum membaca satu pun; lalu menjalankan trial seperti server: **tiga container** di satu network sendiri — agent (entry, `/bot` read-only), env (alias `store`, `program/env/`), gateway (alias `llm`, `gateway/gateway.mjs`) — network tanpa rute keluar kecuali gateway ke provider model.
- **Live lalu replay**: live pass menjalankan entry dan gateway meneruskan tiap model call ke provider (dengan `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` sendiri, atau `--gateway <url>`), mengukur, dan merekam jawaban byte-demi-byte ke **cassette**; replay pass menjalankan entry lagi dan gateway menjawab dari cassette tanpa provider. Replay harus membuat request yang persis sama dan meninggalkan `state.json` yang **byte-identik** dengan live pass — bila tidak, trial nondeterministik: terdaftar, tidak pernah di-ranking.
- Output: skor, tiap kolom (feature/agent/perf), spend, replay verdict, dan apakah entry bisa mendapat hadiah; cassette disimpan. Trial live menghabiskan uang key sendiri sampai budget ($0,02/trial); entry yang tidak memanggil model (scripted) tidak butuh provider key dan tidak menghabiskan apa pun.
- Dev phase di server: tiap submission 1 trial live di practice trial-0 saja. Final: tiap trial contender live + replay (grade-local menjalankan replay itu untukmu).

### 6.2 Driver: docker (eksak) vs process (advisory)

| | `--driver docker` | `--driver process` |
|---|---|---|
| Sifat | **Eksak**: tiap trial di container segar di belakang gateway asli, CA sendiri, house launcher, sealed scorer, cassette sendiri sebagai kunci jawaban | **Advisory**: trial berjalan di mesin ini, **tanpa isolasi**, di network sendiri, langsung ke host tanpa gateway |
| Kapan dipakai | Default yang didokumentasikan di RULES.txt; satu-satunya yang mereproduksi verdict grader | Fallback bila Docker tidak jalan / image yang di-pin belum di-pull; pesan CLI: "a node22 bot can also run with --driver process" |
| Batasan | Butuh Docker jalan + pinned images ter-pull | **Hanya entry node22** (entry python3.13 hanya jalan di dalam Docker); verdict-nya "plausibility check", **bukan verdict grader** |
| Perintah | `node cli/makefun.mjs grade-local --kit . --bot <repository> --driver docker` | `node cli/makefun.mjs grade-local --kit . --bot <repository> --driver process` |

- Bila Docker gagal, CLI menyarankan `--driver process` ("--driver process runs the advisory test without Docker"). Sebaliknya, hasil `--driver process` selalu dilabeli `ADVISORY (--driver process)` di output.
- `verify-instance` (re-derive semua practice trial dari drand) juga menerima kedua driver; `--driver process` menjalankan generator node22 di mesin ini, bukan di container:
  ```sh
  node cli/makefun.mjs verify-instance --kit . --driver docker
  node cli/makefun.mjs verify-instance --kit . --driver process
  ```

### 6.3 Local runner ringan: `sdk/run.ts` (BUKAN grade-local)

Untuk iterasi cepat tanpa container/cassette/replay, kit menyediakan runner conformance langsung — file-file `sdk/conformance/` adalah **salinan byte-identik** `program/env/src/` (disalin `sdk/sync.sh`). Runner ini menunjuk ke server yang **sudah kamu jalankan sendiri**:

```sh
# 1. Jalankan entry-mu sendiri di satu port, mis. 3000 (starter: node --experimental-strip-types main.ts)
# 2. Jalankan suite terhadapnya:
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:3000 --token "$TOKEN" [--perf] [--json] [--timeout-ms N]
```

- `--url`: origin server entry (wajib). `--token`: bearer token yang disajikan tiap check (wajib; di trial = `MAKEFUN_SHOP_TOKEN`). `--perf`: jalankan juga 4 workload bench dan tambahkan poinnya (tanpa flag ini, perf = 0 / "not run"). `--json`: cetak hasil sebagai satu objek JSON, bukan tabel. `--timeout-ms N`: timeout terpanjang per check (default 15.000 ms; dijepit 5.000–15.000).
- Perilaku: probe `GET /healthz` **sekali** (timeout 5 dtk; beda dengan env yang memanggil 2x), lalu semua 120 check berurutan dengan timeout masing-masing + drain 1 dtk setelah timeout, lalu kolom `feature/agent/perf/score/working` (working di sini = `passed > 0 ? 1 : 0` — versi sederhana, tanpa syarat bootOk). **Exit 0** bila `/healthz` menjawab (apa pun hasil check-nya); **exit 1** bila healthz tidak menjawab atau ada usage error. Check yang gagal dilaporkan di tabel, **tidak** lewat exit status.
- Runner ini **tidak** menulis `state.json`/`perf.json`, tidak melakukan register/`/done`, dan tidak me-replay — untuk export + replay pakai grade-local (§6.1). Skor lokal di sini adalah bukti, bukan jaminan: final memakai instance scored segar di pod trial.
- Catatan: `--token` di sini adalah token yang kamu pilih untuk server lokalmu sendiri (server starter/lokal harus menerima token itu); jangan memakai token trial orang lain.

### 6.4 Menjalankan starter (entry kerangka)

```sh
cd starter
node --experimental-strip-types main.ts
```

`main.ts` starter: bind port ephemeral (`listen(0)`), `POST $MAKEFUN_ENV_URL/register {"port": …}`, poll `GET $MAKEFUN_ENV_URL/done` dengan backoff eksponensial, exit 0 saat `{"done": true}`; bila `MAKEFUN_ENV_URL` tidak diset, exit 1 langsung. `app.ts` hanya menjawab `GET /healthz` + 2 route REST minimal + JSON 404 — boot dan register lolos, hampir semua check gagal; git smart HTTP, REST v3, GraphQL, dan MCP adalah isi kompetisinya.
