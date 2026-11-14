# Spec REST v3 + GraphQL v4 — github-core-clone-01

Ringkasan spesifikasi PRESISI dari kit env (bukan opini). Sumber, dibaca penuh:

- `program/env/src/checks-rest.ts` (1250 baris) — 55 check REST: `repos` 15, `issues` 15, `pulls` 20, `protocol` 5
- `program/env/src/checks-graphql.ts` (1318 baris) — 20 check GraphQL
- `program/env/src/rest-client.ts` (493 baris) — klien REST + assertion helpers
- `program/env/src/graphql-client.ts` (331 baris) — klien GraphQL
- `program/env/src/wire.ts` — hanya `Scenario` / `buildScenario` dan konstanta seed
- `program/env/src/export.ts` (235 baris) — aturan determinisme export
- `program/env/src/manifest.ts` — hitungan grup (total 120 check, 7 grup)

Total yang dicakup file ini: **55 check REST + 20 check GraphQL = 75 check**.
Sisa 45 check (git 30, mcp 15) TIDAK dicakup — di luar tugas ini.

> Konvensi penulisan di bawah: `{o}` = owner login, `{r}` = nama repo, `{n}` = nomor
> issue/PR (integer ≥ 1), `{path}` = path file relatif repo (boleh mengandung `/`).
> Semua path REST diawali prefix `/api/v3` (`API_PREFIX`, wire.ts:107; harus sama dengan
> `API_PREFIX` di rest-client.ts). GraphQL hanya di `POST /api/graphql`.
> "Shape" = assertion `expectJsonResponse`/`checkShape`: field yang tercantum WAJIB ada
> dengan tipe/nilai yang tercantum; **field ekstra DIIZINKAN** (shape `object` default
> tidak menolak properti tak dikenal — `checkShape` hanya menolak ekstra bila
> `allowExtra === false`, dan tidak satu pun shape check yang menyetel itu — kecuali
> `looseObject` di root yang eksplisit longgar). Jadi server BOLEH mengembalikan field
> tambahan apa pun di semua respons.

---

## 0. Skenario / data uji (wire.ts `Scenario`, `buildScenario`)

Semua nama, path, isi file, judul, dan body yang dikirim check BERASAL dari satu skenario
seeded — tidak ada string yang di-hardcode per check kecuali sufiks slug check.

- `SCENARIO_SEED = 0x6a09e667f3bcc909n`, hex `6a09e667f3bcc909` (wire.ts:752–754).
- `SCENARIO_EPOCH_SEC = 1_735_689_600` (= 2025-01-01T00:00:00Z). Timestamp commit =
  epoch ini + `rng.nextInt(90 hari)`; format ISO via `new Date(epochSec*1000).toISOString()`.
- `SCENARIO_USERS = 12` (id 1000+i, login unik dari nama depan+belakang, email
  `<login>@example.invalid`); `viewer = users[0]` (pemilik token), `teammate = users[1]`,
  `stranger = users[2]` (pemilik asing untuk check foreign-token).
- `SCENARIO_VIEWER_REPOS = 30` (id 5000+i), `SCENARIO_ORG_REPOS = 6` (id 6000+i, org
  `<adj>-<noun>-org`), `SCENARIO_STRANGER_REPOS = 3` (id 7000+i). Nama repo
  `<adjective>-<noun>`, unik per owner, sufiks `-2`, `-3`, … bila bentrok.
  `private = true` bila `i % 7 === 3`; `defaultBranch = 'main'` (`DEFAULT_BRANCH`).
- `SCENARIO_FILE_PATHS = 60` (kedalaman 0–2 dir dari `PATH_SEGMENTS`, stem + ekstensi),
  `SCENARIO_BLOBS = 24` (isi ASCII 64–4096 byte dari `BLOB_WORDS`), `SCENARIO_COMMITS = 60`,
  `SCENARIO_ISSUES = 60` (judul `<adj> <subject>`, body 1–3 kalimat, label 50% satu dari
  daftar), `SCENARIO_PULLS = 30` (head = `<kind>/<subject>` dengan kind
  `feature|fix|perf|docs|chore`).
- Label: `['bug','enhancement','documentation','question','good first issue','help wanted']`.
- Cabang default: `['main','develop','release/1.0']` + 8 nama generated (unik).
- `RestScenario` (checks-rest.ts `restScenarioOf`, diturunkan murni dari `Scenario`):
  `owner = viewer.login`, `otherOwner = stranger.login`,
  `repoPrefix = scenario.repos[0].name`,
  `paginationRepos =` ke-30 nama repo viewer,
  `filePath = blobs[0].path`, `dirPath =` direktori dari blob pertama yang mengandung `/`
  (fallback `'src'`), `fileContent = blobs[0].content`, `fileContentAlt = blobs[1].content`,
  `commitMessage = commits[0].message`, `branchName =` cabang pertama yang bukan
  `defaultBranch` dan tidak berakhir `/`, `issueTitle/body = issues[0]`,
  `commentBody = issues[1].body`, `pullTitle/body = pulls[0]`,
  `label = labels[0]` (`'bug'`), `badLabel = '<label>-not-a-label'`,
  `description = repos[0].description`, `descriptionAlt = description + ' (updated)'`.
- Nama repo per check REST: `` `${repoPrefix}-${slug(checkId)}` ``, dipotong maks 100 karakter
  (batas GitHub). Slug = id check di-lowercase, karakter non `[a-z0-9._-]` → `-`.
- Nama repo fixture GraphQL: `` `${repos[0].name}-graphql` `` (repo utama),
  `` `${repos[0].name}-graphql-pages` `` (repo paginasi), `` `${repos[0].name}-graphql-missing` ``
  (repo yang tidak pernah dibuat). Cabang head GraphQL = `pulls[0..2].head` (harus 3 nama
  berbeda), `filePath = blobs[0].path`, `baseFilePath = blobs[1].path`,
  `titlePrefix = issues[0].title`, `body = issues[0].body`, `comment = issues[1].body`,
  `pageSize = 5`, `pageCount = 7`.

## 1. Transport & header umum (rest-client.ts / graphql-client.ts)

### 1.1 REST (`RestClient`)

- Base URL entry (scheme+host+port, tanpa trailing slash) + path `/api/v3/...`.
  Path dibangun `apiPath(...)`: tiap segmen di-`encodeURIComponent` per komponen `/`
  (jadi path file `docs/readme.md` tetap bersarang, bukan `%2F`).
- Header setiap request: `Accept: application/vnd.github+json` (selalu).
  `Content-Type: application/json` hanya bila request membawa body JSON.
  **Tidak ada header `User-Agent` dari klien REST** (berbeda dengan klien GraphQL).
- Body JSON = `JSON.stringify(body)`; `rawBody` (string/Uint8Array) dikirim verbatim dan
  menang atas `body` (dipakai check malformed-body).
- Query param di-`encodeURIComponent` via `URLSearchParams`; nilai `undefined`/`null` dibuang.
- Timeout default 5000 ms; tiap check REST memakai `clamp(context.timeoutMs, 1000, 5000)`.
  Transport error / timeout / URL di luar origin entry → respons semu `status 0`,
  `error` terisi, `body` undefined. **Klien tidak pernah throw untuk status HTTP apa pun.**
- Redirect (`301,302,303,307,308`) di-`follow` oleh fetch; body JSON TIDAK di-parse untuk
  respons redirect.
- Respons: body di-parse sebagai JSON hanya bila `Content-Type` JSON
  (`application/json`, `application/vnd.github+json`, atau `*+json`, boleh ada charset)
  DAN body tidak kosong DAN tidak terpotong. Batas respons 1 MiB (`MAX_RESPONSE_BYTES`);
  bila terpotong, body tidak di-parse. `parseError` terisi bila klaim JSON tapi gagal parse.
- `expectJsonResponse(resp, status, shape, label)` menegaskan, berurutan: status PERSIS
  (angka tunggal atau daftar eksplisit — tidak pernah rentang), bukan HTML
  (content-type bukan `text/html` dan body tidak diawali `<`), content-type JSON,
  body JSON valid, lalu shape. Gagal → detail string satu baris (body dipotong 240 karakter).
- `parseLinkHeader`: mem-parse `Link: <url>; rel="next", …` untuk rel `next|prev|first|last`.
  URL `rel="next"` yang diikuti HARUS satu origin dengan base URL entry; bila keluar origin
  → check gagal (dan klien menolak fetch off-origin dengan status 0).
- SHA: `SHA40 = /^[0-9a-f]{40}$/i` — hex 40 karakter, case-insensitive; perbandingan SHA
  selalu case-insensitive (`lower()` kedua sisi).

### 1.2 GraphQL (`GraphQLClient`, `GRAPHQL_PATH = '/api/graphql'`)

- `POST {baseUrl}/api/graphql`, body JSON `{query, variables}` (atau array JSON berisi
  objek-operasi untuk batching), header `Accept: application/json`,
  `Content-Type: application/json`, `User-Agent: makefun-github-core-clone-env/1`,
  `Authorization: Bearer <token>` bila token ada.
- Timeout default 10_000 ms; tiap check GraphQL memakai timeout sendiri 8_000–15_000 ms,
  maks `CHECK_TIMEOUT_MAX_MS = 15_000` (wire.ts:320).
- Respons satu operasi harus berupa SATU objek JSON `{data, errors}`; respons batch harus
  berupa array JSON dengan panjang = jumlah operasi, urutan sama dengan request.
  Klien tidak pernah throw untuk status HTTP atau array `errors`.
- Envelope: bila body 2xx TANPA `data` dan TANPA `errors` → `parseError`
  (`response body has neither data nor errors`). `data` boleh `null` (dipakai check
  unknown-repository). `errors` = entri yang punya `message` string; `path`, `locations`
  `{line,column}`, `extensions` diteruskan bila ada.
- `RestSurface` di checks-graphql.ts (klien REST kedua, khusus grup GraphQL): root
  `{baseUrl}/api/v3`, header `Accept: application/vnd.github+json`,
  `User-Agent: makefun-github-core-clone-env/1`, `Authorization: Bearer <token>` (selalu,
  tanpa varian anon), `Content-Type: application/json` bila ada body. Dipakai sebagai
  fixture-creator dan cross-surface verifier.

## 2. Auth

- Satu-satunya kredensial: bearer token dari env `MAKEFUN_SHOP_TOKEN`
  (`TOKEN_ENV`, wire.ts:82). Header: `Authorization: Bearer <token>`.
- Token `null` / tidak ada → TIDAK ADA header `Authorization` (bukan `Bearer null`).
- Tanpa token, `GET /repos/{o}/{r}` (repo private) → **401** dengan body
  `{"message": string non-empty}` (check `repos.unauthorized`, `protocol.error-message`).
  Tanpa token, `POST /api/graphql` (`query ViewerLogin`) → **401** (check
  `graphql.unauthenticated`; hanya status yang dicek, body tidak dicek).
- Token salah pemilik: repo dengan nama sama di bawah login lain (`stranger`) → **404**
  `{"message": string}` — **tidak pernah 403** (check `repos.foreign-token`).
  Kepemilikan repo = login yang dinamai token; tidak ada konsep "token asing" terpisah.
- Tidak ada skema auth lain yang dicek (tidak ada Basic, tidak ada `X-OAuth-Scopes` sebagai
  request header, tidak ada query `?access_token=`).
- Header `X-OAuth-Scopes` hanya dicek sebagai header RESPONS pada `GET /api/v3/`
  (harus ADA; nilainya tidak dicek). **Header `X-RateLimit-*` secara eksplisit TIDAK
  disyaratkan** (checks-rest.ts:54,233).

## 3. Daftar lengkap endpoint REST yang di-check

26 template rute (25 fungsional + 1 rute tak dikenal untuk protocol). Urutan di bawah
mengikuti urutan pendaftaran check; `B` = body request, `R` = respons yang diharapkan.

### 3.1 `repos` (15 check)

| # | Check id | Method + path | Body request | Respons sukses | Error |
|---|----------|---------------|--------------|----------------|-------|
| R1 | `repos.pagination` | `GET /api/v3/user/repos?per_page=10` (+ ikuti `Link: rel="next"`) | — | 200, array `[{name: string non-empty, …}]`; tiap halaman ≤ 10 item; halaman ≥ 3 untuk 30 repo; total halaman ≤ 20; tidak ada nama duplikat antar halaman; ke-30 nama seeded HARUS muncul | — (lihat §5: create 422 ditoleransi) |
| R2 | `repos.root` | `GET /api/v3/` (perhatikan trailing slash) | — | 200, JSON objek bebas (`looseObject`: properti apa pun boleh); header `X-OAuth-Scopes` HARUS ada | — |
| R3 | `repos.meta` | `GET /api/v3/meta` | — | 200, `{installed_version: string non-empty}` | — |
| R4 | `repos.create` | `POST /api/v3/user/repos` | `{name: string, private: true, description: string}` | 201, `{name: == name dikirim, private: boolean}`; lalu `GET /repos/{o}/{r}` 200 `{name: == name, private: true, default_branch: string non-empty}`; `default_branch` HARUS sama pada dua GET berurutan | — |
| R5 | `repos.not-found` | `GET /api/v3/repos/{o}/{r}` | — | — | 404, `{"message": string non-empty}` untuk repo `<repoPrefix>-never-created` yang tidak pernah dibuat |
| R6 | `repos.patch` | `PATCH /api/v3/repos/{o}/{r}` | `{description: string}` (nilai `descriptionAlt`) | 200, `{description: == descriptionAlt}`; GET sesudahnya 200 dengan `description` yang sama (persistensi) | — |
| R7 | `repos.delete` | `DELETE /api/v3/repos/{o}/{r}` | — | **204** (hanya status yang dicek, body tidak dicek); GET sesudahnya 404 `{"message": …}` | — |
| R8 | `repos.branches` | `POST /api/v3/repos/{o}/{r}/git/refs` lalu `GET /api/v3/repos/{o}/{r}/branches` | POST: `{ref: "refs/heads/<branch>", sha: <sha40>}` | POST 201, `{ref: == "refs/heads/<branch>", object: {sha: sha40}}`; GET 200, array `[{name: string non-empty, commit: {sha: sha40}}]`; daftar HARUS memuat cabang baru DAN cabang default; sha cabang baru == sha awal repo | — |
| R9 | `repos.commits` | `GET /api/v3/repos/{o}/{r}/commits?sha=<branch>` dan `GET /api/v3/repos/{o}/{r}/commits` (tanpa query) | — | 200, array `[{sha: sha40, commit: {message: string}}]`; commit di cabang HARUS ada di list `?sha=<branch>` dengan `message` PERSIS `<commitMessage> (commits)`; commit itu TIDAK BOLEH ada di list tanpa `sha` (sebelum merge) | — |
| R10 | `repos.unauthorized` | `GET /api/v3/repos/{o}/{r}` tanpa token | — | — | 401, `{"message": …}` |
| R11 | `repos.foreign-token` | `GET /api/v3/repos/{o}/{r}` (nama sama, owner = stranger) | — | GET atas nama sendiri 200 | 404, `{"message": …}` untuk path stranger (bukan 403) |
| R12 | `repos.contents-create` | `PUT /api/v3/repos/{o}/{r}/contents/{path}` lalu `GET …/contents/{path}` | PUT: `{message: string, content: base64(isi file)}` (tanpa `sha`, tanpa `branch`) | PUT 201, `{content: {sha: sha40, encoding: "base64"}, commit: {sha: sha40}}`; GET 200 file: `{type: "file", encoding: "base64", content: string, sha: sha40, size: integer ≥ 0}`; `b64decode(content)` == isi yang dikirim; `sha` GET == `content.sha` PUT; `size` == panjang byte UTF-8 isi | — |
| R13 | `repos.contents-directory` | `PUT …/contents/{dir}/seed.txt`, `PUT …/contents/{dir}/one.txt`, `PUT …/contents/{dir}/two.txt`, lalu `GET …/contents/{dir}` | PUT sama seperti R12 | GET 200, **array** `[{type: "file"\|"dir", name: string non-empty, path: string non-empty, sha: sha40}]`; HARUS memuat `seed.txt`, `one.txt`, `two.txt` | — |
| R14 | `repos.contents-stale-sha` | `PUT …/contents/{path}` (update, `sha` = sha saat ini) lalu `PUT` lagi dengan sha lama | update: `{message, content: base64(isiAlt), sha: <sha saat ini>}`; stale: `{message, content: base64(isi awal), sha: <sha LAMA>}` | Update: 200 ATAU 201, shape sama seperti R12, dan `content.sha` HARUS BERUBAH | PUT stale-sha → **409**, `{"message": …}` |
| R15 | `repos.contents-delete` | `DELETE /api/v3/repos/{o}/{r}/contents/{path}` lalu `GET` | DELETE: `{message: string, sha: <sha file saat ini>}` | DELETE 200, `{commit: {sha: sha40}}`; GET sesudahnya 404 `{"message": …}` | — |

Catatan R12–R15: `PUT /contents` pada repo yang BARU dibuat (belum ada commit / "unborn")
HARUS diterima sebagai commit pertama (lihat `prepareRepo`, §5).

### 3.2 `issues` (15 check)

Semua check issues memakai fixture `prepareIssueRepo`: repo + `POST /labels` (lihat R16).

| # | Check id | Method + path | Body request | Respons sukses | Error |
|---|----------|---------------|--------------|----------------|-------|
| R16 | (fixture) | `POST /api/v3/repos/{o}/{r}/labels` | `{name: <label>, color: "ededed"}` | 201, `{name: string non-empty}` (hanya `name` yang dicek; `color` tidak dicek di respons) | — |
| R17 | `issues.create` | `POST /api/v3/repos/{o}/{r}/issues` | `{title, body, labels: [<label>]}` | 201, issue shape: `{number: integer ≥ 1, title: string, body: string, state: string "open"\|"closed", labels: [{name: string non-empty}]}`; `state` HARUS `"open"` | — |
| R18 | `issues.create-title-body` | sama | `{title, body}` (tanpa labels) | 201, shape sama; `title` dan `body` HARUS PERSIS sama dengan yang dikirim | — |
| R19 | `issues.create-labels` | sama | `{title, body, labels: [<label>]}` | 201; `labels[].name` HARUS memuat label yang dikirim | — |
| R20 | `issues.numbers-increment` | sama (2x) | `{title: "<title> 1" / " 2", body}` | 201; nomor issue kedua == nomor pertama + 1 (nomor berurutan per repo, mulai dari 1) | — |
| R21 | `issues.list-open` | `GET /api/v3/repos/{o}/{r}/issues?state=open&per_page=100` | — | 200, array issue shape; HARUS memuat issue open; SEMUA item `state == "open"` | — |
| R22 | `issues.list-open-excludes-closed` | sama | — | 200; issue yang sudah di-close TIDAK BOLEH muncul | — |
| R23 | `issues.list-sort-asc` | `GET …/issues?state=open&sort=created&direction=asc&per_page=100` | — | 200; ketiga issue HARUS muncul dalam urutan pembuatan (posisi naik) | — |
| R24 | `issues.list-sort-desc` | `GET …/issues?state=open&sort=created&direction=desc&per_page=100` | — | 200; urutan TERBALIK (posisi turun, terbaru dulu) | — |
| R25 | `issues.list-shape` | `GET …/issues?state=open&per_page=10` | — | 200, array tidak kosong, tiap item lolos issue shape (R17) | — |
| R26 | `issues.get-one` | `GET /api/v3/repos/{o}/{r}/issues/{n}` | — | 200, issue shape; `number`, `title`, `body` PERSIS sama dengan yang dibuat | — |
| R27 | `issues.patch-close` | `PATCH /api/v3/repos/{o}/{r}/issues/{n}` | `{state: "closed"}` | 200, `{number: integer ≥ 1, state: == "closed"}` (hanya 2 field ini yang dicek) | — |
| R28 | `issues.patch-close-persists` | PATCH seperti R27 lalu GET | — | GET sesudahnya 200, issue shape, `state == "closed"` | — |
| R29 | `issues.comment-create` | `POST /api/v3/repos/{o}/{r}/issues/{n}/comments` | `{body: <commentBody>}` | 201, `{id: integer ≥ 1, body: == commentBody}` | — |
| R30 | `issues.comments-list` | POST seperti R29 lalu `GET …/issues/{n}/comments` | — | GET 200, array `[{id: integer ≥ 1, body: string}]`; HARUS memuat komentar dengan `id` dan `body` yang sama seperti POST | — |
| R31 | `issues.bad-label` | `POST /api/v3/repos/{o}/{r}/issues` | `{title, body, labels: ["<label>-not-a-label"]}` | — | **422**, `{"message": …}` |

### 3.3 `pulls` (20 check)

Fixture `preparePull` (lihat §5): repo → cabang head → 1+ commit di head → `POST /pulls`.
Shape pull (`pullShape`): `{number: integer ≥ 1, state: "open"\|"closed", title: string,
body: string, head: {ref: string non-empty, sha: sha40}, base: {ref: string non-empty,
sha: sha40}}`. Perhatikan: `state` pull HANYA `"open"`/`"closed"` (tidak ada `"merged"`
sebagai state; status merged dibaca dari field boolean `merged` + `merged_at`).
Shape pull file: `{filename: string non-empty, status: string non-empty,
additions: integer ≥ 0, deletions: integer ≥ 0, changes: integer ≥ 0}`.

| # | Check id | Method + path | Body request | Respons sukses | Error |
|---|----------|---------------|--------------|----------------|-------|
| R32 | `pulls.create` | `POST /api/v3/repos/{o}/{r}/pulls` (di fixture) lalu `GET …/pulls/{n}` | POST: `{head: <branch>, base: <defaultBranch>, title, body}` | POST 201 pull shape; GET 200 pull shape; `state == "open"`, `head.ref == head`, `base.ref == base` | — |
| R33 | `pulls.create-body` | sama | sama | GET 200; `title` dan `body` PERSIS sama dengan yang dikirim | — |
| R34 | `pulls.create-head-sha` | sama | sama | GET 200; `head.sha` == sha commit tip cabang head | — |
| R35 | `pulls.create-base-sha` | sama | sama | GET 200; `base.sha` == sha commit awal cabang default | — |
| R36 | `pulls.get-one` | `GET /api/v3/repos/{o}/{r}/pulls/{n}` | — | 200 pull shape; `number == n`, `title` sama | — |
| R37 | `pulls.files-list` | `GET /api/v3/repos/{o}/{r}/pulls/{n}/files` | — | 200, array pull-file shape; HARUS memuat `filename` == path yang diubah; `status` ∈ `added\|modified\|changed`; `additions ≥ 1` | — |
| R38 | `pulls.files-shape` | sama | — | 200, array tidak kosong, tiap item lolos pull-file shape | — |
| R39 | `pulls.files-multiple` | sama (PR dengan 2 file diubah) | — | 200; KEDUA path HARUS terdaftar | — |
| R40 | `pulls.merge-status` | `PUT /api/v3/repos/{o}/{r}/pulls/{n}/merge` | `{merge_method: "squash"}` | **200** (hanya status yang dicek di check ini) | — |
| R41 | `pulls.merge-body` | sama | `{merge_method: "squash"}` | 200, `{merged: boolean, sha: sha40, message: string}`; `merged == true`; `sha` HARUS lolos regex SHA40 | — |
| R42 | `pulls.merge-closes` | sama lalu `GET …/pulls/{n}` | `{merge_method: "squash"}` | GET 200, `{state: == "closed", merged: boolean, merged_at: string non-empty}`; `merged == true`. **`merged_at` hanya dicek non-empty string — format waktunya TIDAK dicek.** | — |
| R43 | `pulls.merge-commit-on-default` | sama lalu `GET …/commits?sha=<base>` | `{merge_method: "squash"}` | 200, array `[{sha: sha40}]`; HARUS memuat sha merge | — |
| R44 | `pulls.merge-content-on-default` | sama lalu `GET …/contents/{changedPath}?ref=<base>` | `{merge_method: "squash"}` | 200 file shape (R12); `b64decode(content)` == isi file dari cabang head (squash HARUS memindahkan konten ke default branch) | — |
| R45 | `pulls.merge-commit-sha` | sama lalu `GET …/pulls/{n}` | `{merge_method: "squash"}` | 200, `{merge_commit_sha: sha40}`; HARUS == sha merge dari respons merge | — |
| R46 | `pulls.merge-unknown` | `PUT …/pulls/999999999/merge` | `{merge_method: "squash"}` | — | **404**, `{"message": …}` |
| R47 | `pulls.merge-conflict` | Dua PR dari 2 cabang yang mengubah FILE YANG SAMA dengan isi berbeda; merge PR pertama (200), lalu merge PR kedua | `{merge_method: "squash"}` | Merge pertama 200 | Merge kedua (conflicted) → **405**, `{"message": …}`. Ini mensyaratkan semantik konflik 3-way yang nyata, bukan flag statis. |
| R48 | `pulls.list-state-all` | `GET /api/v3/repos/{o}/{r}/pulls?state=all&per_page=100` | — | 200, array pull shape; HARUS memuat PR yang sudah di-merge DAN PR open kedua | — |
| R49 | `pulls.list-default-open` | `GET /api/v3/repos/{o}/{r}/pulls?per_page=100` (tanpa `state`) | — | 200, array pull shape; PR merged TIDAK BOLEH muncul (default = open saja); PR open HARUS muncul | — |
| R50 | `pulls.list-shape` | `GET …/pulls?state=all&per_page=10` | — | 200, array tidak kosong, tiap item lolos pull shape | — |
| R51 | `pulls.get-unknown` | `GET /api/v3/repos/{o}/{r}/pulls/999999999` | — | — | **404**, `{"message": …}` |

### 3.4 `protocol` (5 check — seluruh grup `protocol` menurut manifest; lihat kejutan §7)

| # | Check id | Yang dicek | Syarat |
|---|----------|-----------|--------|
| R52 | `protocol.content-type-json` | 6 panggilan: `GET /api/v3/`, `GET /api/v3/meta`, `GET /repos/{o}/{r}`, `GET /repos/{o}/{r}/issues`, `GET /api/v3/no-such-route-content-type`, `GET /repos/{o}/{r}` tanpa token | Setiap respons: status ≠ 0 (harus ada respons), `Content-Type` JSON, body bukan HTML |
| R53 | `protocol.unknown-route-json-404` | `GET /api/v3/no-such-route/<repoPrefix>` | 404, `{"message": …}`, bukan HTML |
| R54 | `protocol.malformed-body-400` | `POST /api/v3/user/repos` dengan `rawBody` verbatim `{"name":` dan header `Content-Type: application/json` | **400**, `{"message": …}` (JSON tidak valid → 400, bukan 422/500) |
| R55 | `protocol.request-id` | 4 panggilan: `GET /api/v3/`, `GET /repos/{o}/{r}`, `GET /api/v3/no-such-route-request-id`, `GET /repos/{o}/{r}` tanpa token | Setiap respons HARUS membawa header `X-GitHub-Request-Id` **non-empty** (termasuk rute tak dikenal dan 401) |
| R56 | `protocol.error-message` | `GET` repo tak ada → 404; `GET` repo private tanpa token → 401; `POST /issues` label tak dikenal → 422 | Ketiga body HARUS `{"message": string non-empty}` |

### 3.5 Aturan umum semua respons REST

- Status sukses HARUS persis seperti tabel (201 create, 200 baca/update/merge, 204 delete
  repo, 200 delete contents). Tidak ada rentang 2xx yang diterima.
- Semua respons sukses DAN error HARUS `Content-Type: application/json` dan body JSON
  (bukan HTML). Pengecualian satu-satunya: `DELETE /repos` 204 — hanya status dicek.
- Semua body error: `{"message": string non-empty}`. TIDAK ADA field error lain yang
  disyaratkan (mis. tidak ada `errors[]`, `documentation_url`, `code`).
- Status error yang dicek: 400 (body JSON malformed), 401 (tanpa token), 404 (tidak ada /
  bukan milikmu / PR tak dikenal), 405 (merge conflicted), 409 (stale sha contents),
  422 (label tak dikenal; juga dipakai sebagai "sudah ada" di §5 — lihat toleransi).
- Field yang TIDAK PERNAH dicek di REST: `created_at`, `updated_at`, `pushed_at`,
  `clone_url`, `html_url`, `owner` objek repo, `user`/`assignee`, `milestone`,
  `reactions`, `comments` count, `author`/`committer` commit, `tree`, `parent`,
  `sha` di luar yang disebut, `size` kecuali di GET contents file, `download_url`,
  `url`/`_links`, `node_id`/`id` repo (kecuali `id` komentar issue).

## 4. Daftar lengkap dokumen GraphQL (18 dokumen, `GRAPHQL_DOCUMENTS`)

Semua dikirim sebagai `query` + `variables` ke `POST /api/graphql`. Satu-satunya
penanda operasi adalah `operationName` bila disertakan (klien mendukungnya; check
tidak pernah mengirim `operationName` — hanya `query` + `variables`). Semua check
kecuali `invalid-field` menuntut: HTTP 200, TIDAK ADA array `errors`, `data` objek.

| # | Nama (key) | Operasi | Variabel | Field response yang dicek |
|---|-----------|---------|----------|---------------------------|
| G1 | `viewerLogin` | `query ViewerLogin { viewer { login } }` | — (tidak ada) | `data.viewer.login`: string non-empty DAN == login pemilik token (`harness.viewer`) |
| G2 | `repositoryFields` | `query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }` | `{owner, name}` | `repository.id` == id dari fixture (global id, lihat G19); `databaseId` == id numerik yang sama; `name` == nama repo; `owner.login` == viewer; `defaultBranchRef.name` == cabang default (hanya dicek bila git adapter tersedia); `viewerPermission` ∈ `ADMIN\|MAINTAIN\|WRITE\|TRIAGE\|READ`; `hasIssuesEnabled == true` |
| G3 | `issueFields` | `query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }` | — | `data.Issue.fields[].name`: tidak kosong; HARUS memuat `id, number, title, state, body` |
| G4 | `typeFields` | `query PullRequestAndRepositoryFields { PullRequest: __type(name: "PullRequest") { fields(includeDeprecated: true) { name } } Repository: __type(name: "Repository") { fields(includeDeprecated: true) { name } } }` | — | `PullRequest.fields` HARUS memuat `id, number, headRefName, baseRefName, mergeable, state, merged, files`; `Repository.fields` HARUS memuat `id, databaseId, name, nameWithOwner, owner, defaultBranchRef, viewerPermission, hasIssuesEnabled, issue, issues, pullRequests, pullRequest` |
| G5 | `searchTypeEnumValues` | `query SearchType_enumValues { SearchType: __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } } }` | — | `data.SearchType.enumValues[].name`: tidak kosong; HARUS memuat `ISSUE` |
| G6 | `openIssues` | `query OpenIssues($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number title state id } } } }` | `{owner, name, first: 10}` | `nodes` ≤ 10, tidak kosong; tiap node `state == "OPEN"`, `title` string, `id` non-empty, `number` integer > 0; urutan nomor MENURUN (CREATED_AT DESC); issue closed TIDAK BOLEH muncul; ketiga issue open fixture HARUS muncul |
| G7 | `issueByNumber` | `query IssueByNumber($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { number title state id body } } }` | `{owner, name, number}` | `issue.number == number` yang diminta; `state == "OPEN"`; `title` == `"<titlePrefix> open 1"`; `body` == body seeded; `id` non-empty |
| G8 | `createIssue` | `mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }` | `{input: {repositoryId: <global id repo>, title: "<titlePrefix> created over graphql", body}}` | `createIssue.issue.number` integer > 0, `id` non-empty; lalu verifikasi silang REST `GET /issues/{n}` 200: `number`, `title` sama, `state == "open"` |
| G9 | `closeIssue` | `mutation IssueClose($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number id state } } }` | `{input: {issueId: <global id issue>}}` (id didapat dulu via G7) | `closeIssue.issue.number` sama, `state == "CLOSED"`; lalu REST `GET /issues/{n}` 200: `state == "closed"` |
| G10 | `pullRequests` | `query PullRequests($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { pullRequests(first: $first) { nodes { number headRefName baseRefName mergeable state } } } }` | `{owner, name, first: 5}` | `nodes` ≤ 5; HARUS memuat PR fixture; `headRefName` == cabang head, `baseRefName` == cabang default, `state == "OPEN"`, `mergeable` ∈ `MERGEABLE\|CONFLICTING\|UNKNOWN` |
| G11 | `pullRequestFiles` | `query PullRequestFiles($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { number files(first: 10) { nodes { path } } } } }` | `{owner, name, number}` | `pullRequest.number` sama; `files.nodes[].path` HARUS memuat `blobs[0].path` |
| G12 | `pullRequestId` | `query PullRequestId($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id number } } }` | `{owner, name, number}` | `id` non-empty (dipakai sebagai input merge); `number` sama. Dokumen helper, tidak punya check sendiri. |
| G13 | `createPullRequest` | `mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { number id state headRefName baseRefName } } }` | `{input: {repositoryId, baseRefName: <default>, headRefName: <cabang create>, title: "<titlePrefix> created over graphql"}}` | `number` > 0, `id` non-empty, `state == "OPEN"`, `headRefName`/`baseRefName` sama; lalu REST `GET /pulls/{n}` 200: `head.ref`, `base.ref` sama |
| G14 | `mergePullRequest` | `mutation MergePullRequest($input: MergePullRequestInput!) { mergePullRequest(input: $input) { pullRequest { number merged state } } }` | `{input: {pullRequestId: <global id PR>, mergeMethod: "SQUASH"}}` | `merged == true`; lalu REST `GET /pulls/{n}` 200: `merged == true`, `state == "closed"`. Hanya `SQUASH` yang dikirim (nilai enum lain `MERGE`/`REBASE` tidak pernah diuji). |
| G15 | `addComment` | `mutation AddComment($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id body } } } }` | `{input: {subjectId: <global id issue>, body: <comment = issues[1].body>}}` | `commentEdge.node.body` == body yang dikirim, `id` non-empty; lalu REST `GET /issues/{n}/comments` 200: daftar HARUS memuat komentar dengan body itu |
| G16 | `invalidField` | `query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }` | — | **SATU-SATUNYA check yang mengharapkan `errors`**: HTTP **200** (bukan 400), `errors` tidak kosong, dan ≥ 1 `errors[].message` HARUS mengandung substring `noSuchFieldOnViewer` |
| G17 | `nodeRepository` | `query NodeRepository($id: ID!) { node(id: $id) { id ... on Repository { name nameWithOwner } } }` | `{id: <global id repo>}` | `node.id` == id yang dikirim; `node.name` == nama repo; `node.nameWithOwner == "<viewer>/<repo>"`. Memakai inline fragment `... on Repository`. |
| G18 | `issuesPage` | `query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) { repository(owner: $owner, name: $name) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } } }` | halaman 1: `{owner, name, first: 5, after: null}`; halaman 2: `{…, first: 5, after: <endCursor hal.1>}` | Hal. 1: TEPAT 5 node, `pageInfo.hasNextPage == true`, `endCursor` string non-empty. Hal. 2: TEPAT 2 node (7 − 5), `hasNextPage == false`. Gabungan: 7 nomor berbeda, semuanya nomor issue fixture, tidak ada duplikat antar halaman. |

### 4.1 Tabel 20 check GraphQL (id, dokumen, timeout)

| Check id | Dokumen | Timeout |
|---|---|---|
| `graphql.viewer-login` | G1 | 8_000 ms |
| `graphql.repository-fields` | G2 | 10_000 ms |
| `graphql.introspection-issue` | G3 | 8_000 ms |
| `graphql.introspection-types` | G4 + G5 (dua request) | 10_000 ms |
| `graphql.issues-open-order` | G6 | 12_000 ms |
| `graphql.issue-by-number` | G7 | 10_000 ms |
| `graphql.create-issue` | G8 (+ REST GET verifikasi) | 12_000 ms |
| `graphql.close-issue` | G9 (+ REST POST fixture + REST GET verifikasi) | 12_000 ms |
| `graphql.pull-requests-list` | G10 | 15_000 ms |
| `graphql.pull-request-files` | G11 | 12_000 ms |
| `graphql.create-pull-request` | G13 (+ REST GET verifikasi) | 15_000 ms |
| `graphql.merge-pull-request` | G14 (+ G12 helper + REST GET verifikasi) | 15_000 ms |
| `graphql.add-comment` | G15 (+ REST POST fixture + REST GET verifikasi) | 12_000 ms |
| `graphql.invalid-field` | G16 | 8_000 ms |
| `graphql.unauthenticated` | G1 tanpa token | 8_000 ms |
| `graphql.node-repository` | G17 | 10_000 ms |
| `graphql.unknown-repository` | G2 dengan nama repo tak dikenal | 8_000 ms |
| `graphql.batched-operations` | Batch `[G1, G3]` dalam SATU body array JSON | 10_000 ms |
| `graphql.global-id-stability` | G2 (2x) + G7 (2x) | 12_000 ms |
| `graphql.issues-pagination` | G18 (2 halaman) | 12_000 ms |

### 4.2 Skema minimum yang harus diimplementasikan (dari header checks-graphql.ts)

- `Query.viewer { login }`
- `Query.repository(owner: String!, name: String!)` → `Repository` nullable;
  `Repository { id, databaseId, name, nameWithOwner, owner { login }, defaultBranchRef { name },
  viewerPermission, hasIssuesEnabled, issue(number: Int!), issues(first: Int, states: [IssueState!],
  orderBy: {field: IssueOrderField!, direction: OrderDirection!}, after: String),
  pullRequests(first: Int), pullRequest(number: Int!) }`
- `Issue { id, number, title, state, body }`; `IssueConnection { nodes, pageInfo { hasNextPage, endCursor } }`
- `PullRequest { id, number, state, merged, headRefName, baseRefName, mergeable, files(first: Int) }`;
  `PullRequestConnection { nodes }`; `PullRequestChangedFile { path }`
- `User { login }`; `Query.node(id: ID!)` → `Node` (+ inline fragment `... on Repository`)
- `Query.__type(name: String!)` → `__Type { fields(includeDeprecated: Boolean),
  enumValues(includeDeprecated: Boolean) }`, dengan alias (`Issue: __type(...)` dst.)
- Mutasi: `createIssue(input: CreateIssueInput { repositoryId, title, body })` →
  `{ issue { number, id } }`; `closeIssue(input: CloseIssueInput { issueId })` →
  `{ issue { number, id, state } }`; `createPullRequest(input: CreatePullRequestInput
  { repositoryId, baseRefName, headRefName, title })` → `{ pullRequest { number, id, state,
  headRefName, baseRefName } }`; `mergePullRequest(input: MergePullRequestInput
  { pullRequestId, mergeMethod })` → `{ pullRequest { number, merged, state } }`,
  `mergeMethod: SQUASH` harus diterima; `addComment(input: AddCommentInput { subjectId, body })`
  → `{ commentEdge { node { id, body } } }`
- Enum yang disebut: `IssueState OPEN/CLOSED`, `MergeableState MERGEABLE/CONFLICTING/UNKNOWN`,
  `PullRequestState OPEN/CLOSED/MERGED`, `PullRequestMergeMethod MERGE/SQUASH/REBASE`,
  `RepositoryPermission ADMIN/MAINTAIN/WRITE/TRIAGE/READ`, `SearchType` (enumValues harus
  memuat `ISSUE`), `IssueOrderField CREATED_AT/UPDATED_AT/COMMENTS`, `OrderDirection ASC/DESC`.
- Argumen yang harus didukung: variabel string/int, daftar enum inline (`states: [OPEN]`),
  objek input inline (`orderBy: {field: CREATED_AT, direction: DESC}`), variabel null
  (`after: null`), operation name, dan batching array JSON.
- **Repo tak dikenal → `data.repository = null` DAN `errors` kosong** (check
  `graphql.unknown-repository`; `dataOf` menuntut status 200 + tanpa errors).
  Berbeda dengan field tak dikenal (G16) yang HARUS menghasilkan `errors`.

### 4.3 Global ID (Relay)

- `repository.id` dan `issue.id` HARUS: string non-empty, **stabil di dua pembacaan
  berurutan**, dan **opaque**: `repository.id` TIDAK BOLEH sama dengan `String(databaseId)`;
  `issue.id` TIDAK BOLEH sama dengan `String(number)` (check `graphql.global-id-stability`).
  Format opasitas lain (mis. base64) tidak ditentukan — hanya "bukan angka polos" yang dicek.

## 5. Perilaku error (ringkas, lintas REST + GraphQL)

| Situasi | Yang diharapkan |
|---|---|
| Tanpa token (REST repo private) | 401, `{"message": string non-empty}` |
| Tanpa token (GraphQL) | 401 (status saja) |
| Repo/PR/issue/file tidak ada | 404, `{"message": …}` (REST) |
| Repo nama sama di bawah owner lain | 404, bukan 403 |
| Label tidak dikenal saat create issue | 422, `{"message": …}` |
| PUT contents dengan sha basi | 409, `{"message": …}` |
| Merge PR conflicted | 405, `{"message": …}` |
| Merge PR tak dikenal (999999999) | 404, `{"message": …}` |
| Body JSON malformed (`{"name":`) | 400, `{"message": …}` |
| Rute tak dikenal (`/api/v3/no-such-route/...`) | 404 JSON, `{"message": …}`, bukan HTML |
| Field GraphQL tak dikenal | HTTP 200 + `errors[]` berisi pesan yang menyebut nama field |
| Repo GraphQL tak dikenal | HTTP 200, `data.repository = null`, `errors` kosong |
| Respons HTML apa pun | GAGAL (semua respons harus JSON; `Content-Type` JSON; body tidak diawali `<`) |
| Transport error / timeout | Status semu 0 → check gagal dengan detail transport (bukan crash) |

## 6. Urutan / dependensi antar check

### 6.1 Umum

- Entry adalah server FRESH tiap trial dan tidak menyimpan state sendiri; SETIAP check
  membuat fixture-nya sendiri lewat API. Tidak ada check yang membaca hasil check lain,
  kecuali toleransi duplikat di bawah.
- Tidak ada check yang membaca jam (`Date`) atau `Math.random`; urutan request dalam satu
  check deterministik dari seed. Timing dicatat untuk diagnostik tapi TIDAK PERNAH masuk
  bit pass/fail.
- Timeout REST per check: `clamp(timeoutMs konteks, 1000, 5000)`; GraphQL: timeout per
  check 8–15 detik (tabel §4.1), maks 15_000 ms.

### 6.2 REST — urutan pendaftaran & fixture berantai

- Urutan pendaftaran `restChecks()`: `repos.pagination` **PERTAMA**, lalu `repos.root`,
  `repos.meta`, `repos.create`, `repos.not-found`, `repos.patch`, `repos.delete`,
  `repos.branches`, `repos.commits`, `repos.unauthorized`, `repos.foreign-token`,
  `repos.contents-*` (4), lalu 15 issues, lalu 20 pulls. Alasan pagination pertama
  (komentar di kode): agar repo yang dibuat check lain belum menumpuk saat menghitung
  halaman — check hanya menuntut ke-30 repo seeded terjangkau lewat rantai `Link`.
- `prepareRepo(id, {private?, description?, filePath?, content?})` — dipakai hampir semua
  check repos/issues/pulls:
  1. `POST /user/repos {name: <repoPrefix>-<slug(id)>, private: true (default),
     description}` → 201 `{name: == name, private: boolean}`.
  2. `PUT /contents/{filePath} {message, content: base64}` → 201
     `{content: {sha, encoding: "base64"}, commit: {sha}}` — repo "unborn" HARUS menerima
     ini sebagai commit pertama.
  3. `GET /repos/{o}/{r}` → 200, baca `default_branch` (string non-empty).
  Mengembalikan `{owner, name, path, defaultBranch, initialCommitSha}`.
- `prepareIssueRepo(id)`: `prepareRepo` + `POST /labels {name: <label>, color: "ededed"}`
  → 201. Semua check issues bergantung pada ini.
- `createBranch(repo, branch, sha)`: `POST /git/refs {ref: "refs/heads/<branch>", sha}`
  → 201 `{ref: == ..., object: {sha}}`.
- `commitOnBranch`: bila `update: true`, GET contents dulu (`?ref=<branch>`) untuk sha
  blob; lalu `PUT /contents {message, content: base64, branch, sha?}` → 201 (baru) atau
  200/201 (update).
- `preparePull(id, files?)`: `prepareRepo` → `createBranch(head = <branchName>-<slug(id)>)`
  → commit 1+ file di head (path varian `<stem>-<slug>.<ext>`, isi `fileContentAlt`) →
  `POST /pulls {head, base: defaultBranch, title, body}` → 201 pull shape.
  Semua check pulls (kecuali `merge-unknown`, `merge-conflict`, `get-unknown` yang
  memakai `prepareRepo` langsung) bergantung pada rantai ini.
- `pulls.merge-conflict`: repo → cabang A dan B dari `initialCommitSha` → commit file
  YANG SAMA di kedua cabang dengan isi berbeda (`<isiAlt> (a)` vs `(b)`, `update: true`)
  → 2 PR → merge PR A (200) → merge PR B HARUS 405.
- `repos.pagination`: untuk tiap dari 30 nama: `POST /user/repos` — **status 422
  DITERIMA sebagai "repo sudah dibuat grup/check lain"** (hanya 201 atau 422 yang
  diizinkan; status lain → gagal), lalu `GET` repo itu harus 200. Kemudian mulai dari
  `GET /user/repos?per_page=10`, ikuti `Link rel="next"` sampai habis (maks 20 halaman).
- `repos.delete` / `repos.contents-delete`: DELETE lalu GET harus 404 (verifikasi
  penghapusan persisten, bukan hanya status DELETE).

### 6.3 GraphQL — harness & fixture malas (memoized)

- Satu `Harness` per `(baseUrl, seed)`; fixture dibangun malas (lazy) dan dipakai ulang
  antar check dalam satu run; fixture yang gagal dibangun = detail kegagalan check itu
  (bukan crash).
- Rantai pembangunan: `repoFixture` → `baseBranchFixture` → `branchFixture` →
  `issueFixture` / `pullRequestFixture` / `mergePullRequestFixture` / `pageFixture`.
  - `buildRepo`: `POST /user/repos {name: <repo>-graphql, private: <private repos[0]>,
    description}` — status yang diterima: **201, 200, 422, 409** (lebih longgar dari
    REST!); lalu `GET /repos/{viewer}/{name}` harus 200; lalu `RepositoryFields` (G2)
    untuk membaca `id` (global) + `databaseId` (numerik).
  - `buildBaseBranch`: butuh **git adapter** (`configureGraphQLGit()` dari env main,
    lewat git client env): push 1 commit ke cabang default (path `blobs[1].path`,
    konten `"# <repo>\n\n<body>\n"`, pesan `"fixture: first commit on <branch>"`).
    **Tanpa adapter, 4 check PR gagal** dengan detail eksplisit
    ("no git fixture provider was installed…"); 16 check lain tetap jalan.
    `repository-fields` hanya menegaskan `defaultBranchRef.name` bila adapter ada.
  - `buildBranches`: push 3 cabang head (`pulls[0..2].head`) dari cabang default, masing-masing
    1 commit (path `blobs[0].path`, `blobs[0].path + ".create"`, `blobs[0].path + ".merge"`).
  - `buildIssues`: 3 issue open (`"<titlePrefix> open 1..3"`) + 1 issue lalu
    `PATCH /issues/{n} {state: "closed"}` → 200.
  - `buildPullRequest(branch, title, tag)`: `POST /pulls {title, body, head: branch,
    base}` → 201, atau bila **422** → `GET /pulls?state=all` dan pakai PR open yang
    sudah ada dari cabang itu (toleransi re-run).
  - `buildPages`: repo kedua `<repo>-graphql-pages` (`POST /user/repos`, terima
    201/200/422/409) + 7 issue (`"<titlePrefix> page 1..7"`).
- Verifikasi silang (cross-surface) WAJIB dua arah: mutasi GraphQL HARUS terlihat lewat
  REST (`createIssue`/`closeIssue`/`createPullRequest`/`mergePullRequest`/`addComment`
  semua di-GET ulang via REST), dan sebaliknya fixture GraphQL dibuat lewat REST
  (repo, issue, PR) + git push.
- Check `graphql.repository-fields` memakai `repoFixture` DAN (bila adapter ada)
  `baseBranchFixture` sebelum query.

## 7. Hal deterministik & export

- **Tidak ada waktu/jam acak dalam bit pass/fail**: tidak satu pun check REST/GraphQL
  membaca jam atau `Math.random`; semua string/byte berasal dari `Scenario` seeded.
  Satu-satunya "waktu" yang MUNCUL di respons adalah `merged_at` (pull, REST) — dan itu
  hanya dicek sebagai string non-empty, format/nilai tidak dicek. `created_at` /
  `updated_at` tidak pernah diminta/dicek di REST maupun GraphQL.
- Timestamp fixture commit: `SCENARIO_EPOCH_SEC + rng(0..90 hari)`, deterministik per seed.
  `FIXTURE_EPOCH_SEC = 1_735_689_600` (main.ts:146) — nilai yang sama dengan
  `SCENARIO_EPOCH_SEC`.
- **Export (`export.ts`, `main.ts:40`)**: `state.json` TIDAK BOLEH mengandung nilai turunan
  waktu: "WHAT NEVER ENTERS THE EXPORT: a time, a port or a random id."
  - `state.json`: bit 0/1 per check id (manifest, urutan pendaftaran), `counts` turunan
    dari bit, `perfTiers = {push: 0, clone: 0, read: 0, write: 0}` (STATIS — BUKAN band
    terukur), `working = 1` hanya bila boot sukses DAN ≥ 1 check lolos, `notes` tetap.
    Ditulis sebagai **canonical JSON: key terurut di semua kedalaman, satu trailing
    newline, integer saja**.
  - Nilai terukur (durasi/poin/tier benchmark) HANYA di `perf.json` (dari `bench.ts`),
    tidak pernah di `state.json` — agar dua replay atas entry yang sama menghasilkan
    `state.json` yang identik byte-per-byte.
  - Penulisan atomik (file tmp + fsync + rename); export yang lebih buruk tidak
    menimpa yang lebih baik (`stateNotWorse`: working lebih tinggi menang, lalu jumlah
    passed; `perfNotWorse`: `points_total` ≥); export yang sama ditulis ulang (byte sama).
  - `state.json` ditulis dulu, baru `perf.json`.
- Perilaku yang TIDAK deterministik tapi DIIZINKAN (tidak memengaruhi bit): `elapsedMs`
  tiap respons, urutan field JSON di luar canonical export, nilai `X-GitHub-Request-Id`
  (hanya non-empty yang dicek), nilai `X-OAuth-Scopes` (hanya keberadaan yang dicek),
  nilai `merged_at`, nilai `endCursor` (hanya non-empty yang dicek), dan nilai global ID
  (hanya opasitas + stabilitas yang dicek).

## 8. Hal paling mengejutkan / jebakan implementasi (temuan dari membaca kode)

1. **`protocol` hanya 5 check, bukan 10.** Komentar di checks-rest.ts:233 menyebut
   "5 of the manifest's 10", tetapi `manifest.ts` menyatakan grup `protocol` = 5 check
   dan total 120 check (30+15+15+20+20+15+5). Komentar itu basi; REST menyediakan
   SELURUH grup protocol.
2. **Dua model error GraphQL yang berlawanan**: repo tak dikenal → 200 + `data: null` +
   `errors` KOSONG; field tak dikenal → 200 + `errors` terisi. Implementasi yang
   menyamaratakan keduanya (mis. selalu 404 atau selalu errors) gagal salah satu check.
3. **Global ID harus opaque, bukan sekadar unik**: `id` repo TIDAK BOLEH `== String(databaseId)`,
   `id` issue TIDAK BOLEH `== String(number)`. ID numerik polos yang di-string-kan GAGAL.
4. **Merge conflict 405 butuh konflik 3-way nyata**: dua cabang mengubah file yang sama
   dari base yang sama; setelah PR pertama di-merge, PR kedua HARUS terdeteksi conflicted.
   Flag `mergeable` statis tidak cukup.
5. **`PUT /contents` pada repo "unborn" harus berhasil** sebagai commit pertama — repo
   dibuat tanpa commit awal; tidak ada endpoint commit/branch lain untuk commit pertama
   di jalur REST (jalur GraphQL memakai git push).
6. **Toleransi 422/409 yang tidak simetris**: pagination REST menerima 201 ATAU 422
   (duplikat); fixture GraphQL menerima 201/200/422/409 untuk create repo dan 422 untuk
   create PR (lalu lookup ulang). Server yang mengembalikan 409 untuk repo duplikat di
   jalur REST pagination akan GAGAL, tetapi di jalur GraphQL LULUS.
7. **Shape longgar**: field ekstra di respons selalu diizinkan; yang dicek hanya field
   yang disebut + tipenya. Sebaliknya, `viewerPermission` dan `mergeable` adalah enum
   TERTUTUP yang harus persis salah satu nilainya.
8. **`default_branch` harus stabil antar dua GET berurutan** (check `repos.create`) —
   server yang mengembalikan cabang default acak/berubah per request gagal.
9. **Paginasi REST menuntut ≥ 3 halaman untuk 30 repo pada `per_page=10`** — server yang
   mengabaikan `per_page` dan mengembalikan semua 30 sekaligus GAGAL (juga tiap halaman
   ≤ 10 item, tanpa duplikat).
10. **4 check GraphQL PR bergantung pada git adapter eksternal** (`configureGraphQLGit`,
    env main) — tanpa itu mereka gagal dengan pesan jelas, BUKAN karena server. Saat
    menguji server saja, kegagalan 4 check itu belum tentu salah server.
11. **Root REST memakai trailing slash** (`GET /api/v3/`, bukan `/api/v3`) dan shape-nya
    `looseObject` — respons root boleh berisi apa saja, tetapi header `X-OAuth-Scopes`
    wajib ada.
12. **`DELETE /repos` 204 tanpa body vs `DELETE /contents` 200 + `{commit:{sha}}`** —
    jangan samakan keduanya.
13. **Tidak ada rate-limit yang disyaratkan** dan tidak ada check `X-RateLimit-*`;
    sebaliknya `X-GitHub-Request-Id` non-empty disyaratkan di SEMUA jenis respons
    termasuk 404 rute tak dikenal dan 401 tanpa token.
14. **`merged_at` dan semua `created_at`/`updated_at` tidak dicek formatnya** — server
    bebas memakai waktu apa pun (bahkan statis) di field-field itu; yang deterministik
    adalah export, bukan respons API.
