# MCP Spec — github-core-clone-01 (spec-reader)

Sumber: `program/env/src/checks-mcp.ts` (1002 baris, 15 checks grup `mcp`) dan
`program/env/src/mcp-client.ts` (795 baris, client hand-rolled atas `fetch`, tanpa SDK),
plus `wire.ts` untuk token/path/timeout. Ringkasan PRESISI dari apa yang di-check —
bukan opini, bukan rekomendasi implementasi di luar yang tersirat dari checker.

---

## 1. Transport MCP persis

- **Endpoint:** `<entry base URL>/mcp` — satu-satunya path (`MCP_ENDPOINT_PATH = '/mcp'`,
  `wire.ts` `MCP_PATH = '/mcp'`, `mcpUrl(baseUrl)` = `joinUrl(baseUrl, '/mcp')`).
  Semua request MCP adalah **POST** ke path ini. Satu-satunya request non-POST adalah
  `close()` legacy: **DELETE** ke endpoint yang sama (best-effort, timeout
  `min(timeoutMs, 1000)` ms) untuk menutup session legacy.
- **Transport:** Streamable HTTP (JSON-RPC 2.0 di atas HTTP POST, tanpa GET stream
  dan tanpa protocol-level session di era modern).
- **Method HTTP:** `POST`, `redirect: 'manual'` pada semua fetch.
- **Header yang dikirim setiap POST** (`headersFor`):
  | Header | Nilai |
  |---|---|
  | `Accept` | `application/json, text/event-stream` (konstanta `MCP_ACCEPT`) |
  | `Content-Type` | `application/json` |
  | `MCP-Protocol-Version` | revisi yang dinegosiasikan (mis. `2026-07-28`); **tidak** dikirim untuk `initialize` legacy (`omitProtocolVersionHeader: true`) |
  | `Mcp-Method` | nama method JSON-RPC yang dicerminkan (mis. `tools/call`, `tools/list`, `server/discover`) |
  | `Mcp-Name` | nama tool, hanya untuk `tools/call`; di-encode per aturan value-encoding (lihat §6) |
  | `Mcp-Session-Id` | hanya bila server pernah mengeluarkannya (dari header respons `mcp-session-id`); tidak ada di era modern |
  | `Authorization` | `Bearer <token>` bila token non-empty; dihilangkan bila `omitAuth: true` |
  | `Mcp-Param-<header>` | hanya bila inputSchema tool menganotasi parameter dengan `x-mcp-header` (lihat §6) |
- **Format request JSON-RPC 2.0** (body POST):
  ```json
  { "jsonrpc": "2.0", "id": <number|string>, "method": "<method>", "params": { ...params, "_meta": { ... } } }
  ```
  Notification (tanpa `id`): `{ "jsonrpc": "2.0", "method": "...", "params": { "_meta": {...} } }`.
  `_meta` selalu ada di setiap request (lihat §3).
- **Format respons — single response vs SSE stream:**
  - Bila `Content-Type` respons mengandung `text/event-stream` → **SSE stream
    request-scoped**. Client membaca stream baris demi baris, mengumpulkan `data:`
    lines per event (blank line = dispatch), mem-parse JSON tiap event, dan berhenti
    begitu menemukan JSON-RPC response yang `id`-nya sama dengan `expectedId`
    (lalu `reader.cancel()`). Notification dan comment line sebelum respons di-skip.
    Respons adalah **data frame terakhir** per transport. `json` di `McpHttpResponse`
    adalah `null` untuk SSE (body bukan JSON utuh); `bodyText` menyimpan teks SSE
    mentah lengkap dengan framing.
  - Bila bukan SSE → **single JSON body**. Client mem-parse body; bila body adalah
    array JSON, diambil elemen pertama yang tampak sebagai JSON-RPC response
    (punya `id` + `result`/`error`).
  - Client **tidak pernah throw untuk HTTP status**: setiap jawaban dikembalikan
    sebagai `McpHttpResponse` utuh (`status`, `ok` = 2xx, `headers`, `contentType`,
    `bodyText`, `json`, `rpc`, `sse`) dan check yang menilai. Throw hanya bila:
    entry tidak menjawab (connection refused → `McpError`), tidak menjawab dalam
    timeout per-call (`McpTimeoutError`), atau abort signal check menyala (`McpError`).
- **Timeout:** default per-request MCP **`MCP_DEFAULT_TIMEOUT_MS = 3_000` ms**.
  Check memakai budget-nya sendiri, di-cap ke 3.000 ms
  (`requestTimeoutOf`: `max(1, min(ctx.timeoutMs, 3000))`).
  Untuk perbandingan: timeout check umum di `wire.ts` adalah `CHECK_TIMEOUT_MS = 15_000`
  (min 5.000, max 15.000) — MCP jauh lebih ketat (3 detik per request).
- **ID JSON-RPC:** client mengalokasikan id numerik berurutan mulai 1 (`nextId`),
  kecuali id eksplisit: `discover-1` (string) untuk `server/discover`,
  `initialize-1` untuk `initialize` legacy, dan id string kustom di check
  concurrent-calls (`concurrent-left-<tag>`, `concurrent-right-<tag>`).

---

## 2. Daftar lengkap tools MCP yang di-check

### 2.1 Syarat `tools/list` (check `tools-list`, `tool-schemas`, `tools-list-idempotent`)

- Minimal **6 tools** terdaftar.
- Keenam tool wajib ada — dicocokkan **by name atau alias yang jelas**, dengan
  normalisasi: lowercase + buang semua karakter non-alphanumeric; cocok persis dulu,
  lalu cocok **suffix** (prefix server diizinkan, mis. `github__create_issue`).
  Case-insensitive.
- Setiap tool wajib punya `description` non-empty (string, trim ≠ "") dan
  `inputSchema` bertipe `object` (`inputSchema.type === 'object'`).
- `tools/list` mengikuti paginasi `nextCursor` (maks 10 halaman); dua pemanggilan
  `tools/list` berurutan harus menghasilkan array tools yang **identik byte per byte**
  (`JSON.stringify` sama) — check `tools-list-idempotent`.
- Client hanya menyimpan tool yang `name`-nya string non-empty.

### 2.2 Keenam tool wajib + alias + argumen

Kontrak argumen menurut rules (nama github-mcp-server). Suite memetakan nama
dokumentasi ke property inputSchema server **berdasarkan nama yang dinormalisasi**,
jadi server boleh memakai nama property lain (lihat sinonim di §2.3).

| # | Tool kanonik | Alias yang diterima | Argumen (semantic) | Required / optional |
|---|---|---|---|---|
| 1 | `create_repo` | `create_repository`, `repo_create`, `repos_create`, `repository_create` | `name`, `description?`, `private?` | `name` required; `description`, `private` optional |
| 2 | `get_repo` | `get_repository`, `repo_get`, `repos_get`, `repository_get` | `owner`, `repo` | keduanya required |
| 3 | `create_issue` | `issue_create`, `issues_create` | `owner`, `repo`, `title`, `body?` | `owner`, `repo`, `title` required; `body` optional |
| 4 | `list_issues` | `issues_list`, `issue_list` | `owner`, `repo`, `state?` | `owner`, `repo` required; `state` optional |
| 5 | `create_pull_request` | `pull_request_create`, `pulls_create`, `create_pr`, `pr_create` | `owner`, `repo`, `title`, `head`, `base` (+ `body?` — suite mengirim `body` bila ada di skenario) | `owner`, `repo`, `title`, `head`, `base` required |
| 6 | `merge_pull_request` | `pull_request_merge`, `pulls_merge`, `merge_pr`, `pr_merge` | `owner`, `repo`, `pull_number` | ketiganya required |

Catatan penting pemetaan argumen (`mapArguments`):
- Bila inputSchema punya **required property yang suite tidak bisa isi**, check
  **gagal dengan property itu disebut namanya** — tool tidak dipanggil dengan
  argumen karangan.
- Bila tool tidak ditemukan di `tools/list`, check gagal `tools/list lists no <canonical> tool`.
- Suite mengirim `private: true` saat membuat repo setup dan `state: 'open'`
  saat list_issues; `description` repo setup = deskripsi skenario
  (`ctx.scenario.repos[0].description`).

### 2.3 Sinonim nama property inputSchema (ARGUMENT_SYNONYMS)

| Semantic | Property yang diterima (dinormalisasi, dicoba berurutan) |
|---|---|
| `owner` | `owner`, `owner_login`, `org`, `organization`, `organisation`, `user`, `user_login`, `login`, `account`, `namespace`, `owner_name` |
| `repo` | `repo`, `repository`, `repository_name`, `repo_name`, `repo_slug`, `project`, `project_name` |
| `repo_full_name` | `full_name`, `repo_full_name`, `repository_full_name`, `fullName` |
| `title` | `title`, `issue_title`, `pr_title`, `pull_request_title`, `subject` |
| `body` | `body`, `issue_body`, `description`, `content`, `text`, `comment` |
| `head` | `head`, `head_ref`, `head_branch`, `pull_request_head`, `pr_head`, `source`, `source_ref`, `source_branch`, `from`, `from_branch`, `branch` |
| `base` | `base`, `base_ref`, `base_branch`, `pull_request_base`, `pr_base`, `target`, `target_ref`, `target_branch`, `into`, `into_branch` |
| `pull_number` | `pull_number`, `pull_request_number`, `pr_number`, `number`, `issue_number`, `index` |
| `name` | `name`, `repo`, `repository`, `repository_name`, `repo_name` |
| `description` | `description`, `about`, `summary`, `body` |
| `private` | `private`, `is_private` |
| `state` | `state`, `status` |

Kasus khusus: bila schema **tidak punya** property `repo` tapi punya property
`full_name` (atau sinonimnya), suite mengirim `"owner/repo"` sebagai satu nilai
`full_name` (mis. `"login/mcp-<tag>-issue-create"`).

### 2.4 Perilaku yang diharapkan per tool (lalu dicek lewat REST)

Semua nama/title/branch/path/byte berasal dari **skenario satu seed tetap**
(`wire.ts buildScenario()`); tidak ada `Math.random`/jam di pass bit. Pola nama:
repo `mcp-<tag8hex>-<slug>`, branch `mcp-head-<tag>-<slug>`, file
`mcp-<tag>-<slug>-<which>.txt`, dengan `tag` = 8 karakter hex pertama seed.

| Check | Tool | Efek yang harus terjadi & cara verifikasi |
|---|---|---|
| `create-issue` | `create_issue` | Issue tercipta; `GET /api/v3/repos/{owner}/{repo}/issues?state=all&per_page=100` harus me-list issue dengan **title yang sama persis**. Setup: repo dibuat via REST (`POST /api/v3/user/repos`, `private: true`). |
| `list-issues` | `list_issues` | Issue yang dibuat via REST (`POST .../issues`) harus muncul di hasil tool — dikenali **by title** (teks hasil mengandung title) **atau by number** (teks mengandung `"number": <N>`). Argumen: `state: 'open'`. Hasil dibaca dari `content[]` blok `type: 'text'` + `structuredContent` (lihat §2.5). |
| `create-pull-request` | `create_pull_request` | PR terbuka; REST `GET /pulls/{number}` (atau list `?state=all&per_page=100`, cocok by title/head) harus membaca **head dan base yang sama persis** dengan yang dikirim. Setup PR via REST: repo + commit file di default branch, buat head branch via `POST /git/refs` (`refs/heads/<head>`, sha base) atau fallback `PUT contents` dengan `branch=<head>`, lalu commit file di head branch. |
| `merge-pull-request` | `merge_pull_request` | PR yang dibuat via REST (`POST .../pulls`) harus ter-merge; REST `GET /pulls/{number}` harus membaca **`merged: true`** (dan `state` dilaporkan). |
| `rest-parity` | `create_repo` + `create_issue` | Repo yang dibuat via MCP harus bisa dibaca via REST (`GET /repos/{owner}/{repo}`) dan **id-nya stabil** di dua pembacaan berurutan; issue yang dibuat via MCP harus bisa dibaca via REST (`GET .../issues/{number}`), **id stabil** dan **title sama**. Nomor issue diambil dari hasil tool (`number` di `structuredContent`/JSON teks) atau fallback dari list REST by title. `full_name` dari hasil tool (bila ada, format `owner/repo`) dipakai untuk owner/repo REST. |
| `concurrent-calls` | `get_repo` (2×) | Dua `tools/call` **bersamaan** (`Promise.all`) dengan id berbeda (`concurrent-left-<tag>`, `concurrent-right-<tag>`) dan repo berbeda harus menjawab dengan **id masing-masing yang cocok** (`matchedId`) dan **objek masing-masing** (teks hasil kiri mengandung nama repo kiri, kanan mengandung repo kanan). |

### 2.5 Format hasil `tools/call` yang diterima checker

- `tools/call` dikirim sebagai `params: { name, arguments: {...} }`.
- Hasil sukses dibaca dari: `result.content[]` blok `{type: 'text', text}` (digabung
  `\n`) **dan/atau** `result.structuredContent` (di-`JSON.stringify` lalu digabung).
  `resultJson` memakai `structuredContent` dulu; bila tidak ada, parse JSON dari
  teks; bila teks dibungkus prosa, ambil substring `{...}` atau `[...]` terluar.
- Nomor (`number`/`pull_number`/`id`) dibaca dari field JSON (number integer, atau
  string digit saja).
- `isError: true` pada result = tool execution error (bukan JSON-RPC error).
- Check `create-pull-request`/`merge-pull-request`/`rest-parity` gagal bila hasil
  tool membawa JSON-RPC error **atau** `isError: true`.

---

## 3. Alur initialize

Dua era protokol diterima; client menegosiasikan keduanya (`connect()`).

### 3.1 Era modern — revisi `2026-07-28` (preferred)

- **Tidak ada handshake.** Langkah pertama `connect()` adalah probe
  `server/discover` (id `discover-1`, params `{}` + `_meta`).
- `server/discover` **wajib** di revisi ini; hasilnya (`DiscoverResult`):
  - `supportedVersions`: array revisi `YYYY-MM-DD` (non-empty — check gagal bila kosong).
  - `capabilities`: record (harus ada `capabilities.tools` agar check `initialize` lolos).
  - `serverInfo`: identitas server — dibaca dari
    `_meta['io.modelcontextprotocol/serverInfo']` **dulu**, lalu fallback
    `result.serverInfo` (top-level).
  - Opsional: `instructions`, `resultType`, `_meta`.
- Negosiasi versi: bila `supportedVersions` mengandung `2026-07-28` → pakai itu;
  bila tidak → pakai `supportedVersions[0]`. Bila `supportedVersions` tidak
  mengandung revisi client dan client belum menyesuaikan, `probeDiscover()`
  menyesuaikan `this.revision` ke versi pertama yang didukung.
- Bila `server/discover` menjawab **UnsupportedProtocolVersionError (`-32022`)**,
  client membaca versi dari `error.data.supported` (berurutan) dan **retry sekali**
  dengan versi itu (prefer `2026-07-28` bila ada di daftar). Bila retry tetap
  gagal → `McpError`. Bila error tidak menyebut versi yang bisa dipakai → `McpError`.
- **Tidak ada session** di era modern: tidak ada `Mcp-Session-Id` yang dipakai,
  tidak ada GET stream; tiap POST dijawab satu JSON body atau satu SSE stream
  request-scoped yang data frame terakhirnya adalah JSON-RPC response.
- **Tidak ada `notifications/initialized`** di era modern.

### 3.2 Era legacy — revisi `2025-11-25` dan sebelumnya

Dipakai bila `server/discover` dijawab dengan **method-not-found (`-32601`)**,
**HTTP 404**, atau **HTTP 405** (endpoint tidak ada / method tidak dikenal).
- `initialize` (id `initialize-1`, **tanpa** header `MCP-Protocol-Version`):
  ```json
  { "protocolVersion": "<salah satu dari legacy revisions>", "capabilities": {}, "clientInfo": { "name": "makefun-github-core-clone-env", "version": "1.0.0" } }
  ```
  Revisi legacy yang dicoba, **berurutan dari terbaru** (`MCP_LEGACY_REVISIONS`):
  `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`.
  Brief menyebut `2025-06-18` sebagai salah satu yang **tidak boleh di-fail**.
  Server menjawab dengan revisi yang dipilihnya; client menerima echo itu sebagai
  revisi yang dinegosiasikan (bila `result.protocolVersion` valid `YYYY-MM-DD`,
  kalau tidak pakai revisi yang dikirim). Bila `initialize` menjawab
  `-32602` (invalid params), client mencoba revisi legacy berikutnya; error lain
  → berhenti, `McpError`.
- Lalu **`notifications/initialized`** (notification tanpa id, params `{}` +
  `_meta`, tanpa header `MCP-Protocol-Version`); kegagalannya diabaikan
  (`.catch(() => null)`).
- **Session (opsional):** bila respons membawa header `mcp-session-id`, client
  menyimpannya dan mengirimkannya sebagai header `Mcp-Session-Id` di semua request
  berikutnya. `close()` mengirim DELETE dengan header itu.
- Di era legacy **tidak ada** `server/discover` — check `server-discover` lolos
  dengan detail `"pre-discover revision"`.

### 3.3 `_meta` di setiap request (kedua era)

Setiap `params` selalu ditambah `_meta` (tanpa menimpa key `_meta` eksplisit
yang sudah diberikan):
```json
"_meta": {
  "io.modelcontextprotocol/protocolVersion": "<revisi yang dinegosiasikan>",
  "io.modelcontextprotocol/clientInfo": { "name": "makefun-github-core-clone-env", "version": "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
  "protocolVersion": "<revisi yang sama>"
}
```
Catatan: ada **dua** spelling versi — key namespaced
`io.modelcontextprotocol/protocolVersion` dan key polos `protocolVersion`
(kontrak suite: `_meta` harus punya field `protocolVersion` di setiap request;
server lama mungkin mencari spelling itu). Client capabilities selalu `{}` (kosong).

### 3.4 Check `initialize` (yang dinilai)

Server harus menamai dirinya dan mendeklarasikan kapabilitas tools — lewat era
mana pun yang dinegosiasikan:
- `serverInfo.name` string non-empty.
- `serverInfo.version` string non-empty.
- `capabilities.tools` **present** (harus berupa record/objek; isinya tidak dicek
  di check ini, tapi `tools/list` lalu membuktikan isinya).
- Detail pass menyebut era (`server/discover` atau `initialize`), nama + versi,
  dan protocol version.

### 3.5 Kapan `connect()` throw (server "tidak berbicara MCP sama sekali")

`connect()` throw `McpError` (check gagal dengan pesannya) bila:
- `server/discover` tidak dijawab sama sekali (transport error: connection refused/timeout).
- Penolakan modern yang **bukan** method-not-found: auth refusal (401/403),
  5xx, atau kode JSON-RPC `-32020` (HeaderMismatch), `-32022`, `-32021`,
  `-32600`, `-32602` — dilaporkan apa adanya, **tidak pernah** di-fallback ke legacy.
- Setelah fallback legacy, `initialize` gagal di semua revisi legacy.
- Pesan error menyertakan bukti dari kedua probe (status discover + kode initialize).

---

## 4. Error yang dicek

| Check | Trigger | Yang harus dijawab server | Yang membuat FAIL |
|---|---|---|---|
| `unknown-tool` | `tools/call` nama `mcp_no_such_tool_<tag>` (nama yang pasti tidak ada), `arguments: {}` | JSON-RPC error **`-32602`** (invalid params) atau **`-32601`** (method not found) | **HTTP 500** (fail eksplisit, apa pun isinya); JSON-RPC error dengan kode lain; atau menjawab `result` (sukses) |
| `parse-error` | POST body mentah yang **bukan JSON**: `{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"` (kurung kurawal tidak ditutup; dikirim via `postRaw`, header `Mcp-Method: tools/list`, expectedId `424242`) | **HTTP 400 + JSON-RPC `-32700`** (parse error) | Kombinasi lain. **Pengecualian legacy:** HTTP 200 + `-32700` tetap PASS bila era legacy ("the pre-2026-07-28 transport status"). |
| `missing-arguments` | `tools/call create_issue` dengan `arguments: {}` (tanpa argumen wajib; `allowMissing: true` agar tetap dipanggil walau schema required tidak terisi) | **`isError: true`** pada tool result **atau** JSON-RPC **`-32602`** | JSON-RPC error kode lain; atau call **diterima** (sukses, `isError` falsy) |
| `auth-required` | `tools/call create_issue` **tanpa header `Authorization`** (`omitAuth: true`) — nama tool diambil dari `tools/list` bila ada (termasuk nama ber-prefix), kalau tidak pakai nama kanonik `create_issue`; argumen dummy `owner: 'no-auth'`, `repo: 'no-auth-<tag>'` | **HTTP 401** | Status HTTP apa pun selain 401 (pesan fail menyebut status + kode JSON-RPC bila ada). Auth diputuskan **sebelum** tool ada — 401 wajib walau nama tool tidak dikenal. |
| (implisit, via `connect()`) | `server/discover` dengan versi tak didukung | `-32022` dengan `data.supported` berisi versi yang didukung (lalu client retry) | — |
| (implisit) | Header mismatch (2026-07-28) | JSON-RPC `-32020` (`MCP_HEADER_MISMATCH`) | — |

Kode JSON-RPC yang dipakai di client:
- `-32700` parse error (`JSON_RPC_PARSE_ERROR`)
- `-32601` method not found (`JSON_RPC_METHOD_NOT_FOUND`)
- `-32602` invalid params (`JSON_RPC_INVALID_PARAMS`)
- `-32600` (invalid request — termasuk daftar penolakan modern yang tidak di-fallback)
- `-32022` UnsupportedProtocolVersionError (`MCP_UNSUPPORTED_VERSION`)
- `-32021` (termasuk daftar penolakan modern yang tidak di-fallback)
- `-32020` HeaderMismatch (`MCP_HEADER_MISMATCH`)

Aturan umum: client tidak pernah throw untuk HTTP status; check yang menilai
status/kode. Satu-satunya status HTTP yang di-check secara eksplisit:
**401** (auth), **400** (parse error), **500** (dilarang untuk unknown-tool),
**404/405** (diperlakukan sebagai "endpoint tidak ada" → memicu fallback legacy,
bukan kegagalan).

---

## 5. Aturan auth token untuk `/mcp`

- Token berasal dari `wire.ts`: **`MAKEFUN_SHOP_TOKEN`** (`TOKEN_ENV`), bearer token
  yang sama dipakai untuk semua API call ke entry.
- Setiap request MCP membawa `Authorization: Bearer <token>` **bila token
  non-empty** (`headersFor`: `if (options.omitAuth !== true && this.token !== '')`).
  Bila token string kosong → header tidak dikirim sama sekali (bukan `Bearer ` kosong).
- Check `auth-required` membuktikan: request **tanpa** header itu ke `tools/call`
  harus dijawab **HTTP 401**.
- Token **tidak pernah di-log** ("Nothing here logs the token" — header file
  checks-mcp.ts). Detail fail hanya menyebut status/kode, tidak pernah isi token.
- Auth berlaku untuk semua method MCP (discover/initialize/tools/list/tools/call):
  `connect()` menganggap 401/403 pada `server/discover` sebagai penolakan modern
  yang fatal (throw, tanpa fallback legacy).

---

## 6. Hal deterministik / batasan lain yang relevan

- **Determinisme penuh:** semua nama, title, branch, path, dan byte yang dikirim
  grup ini berasal dari skenario (`wire.ts buildScenario()`, satu fixed seed);
  tidak ada `Math.random` dan tidak ada clock di pass bit. Entry dan skenario yang
  sama → request yang sama dalam urutan yang sama → bit `state.json` replay
  byte-per-byte.
- **Satu client per check:** setiap check membuat `McpClient` baru
  (`baseUrl`, `token`, `timeoutMs` = budget check di-cap 3.000 ms, `signal` check),
  lalu `connect()` → pakai → `close()` di `finally`. `connect()` idempotent.
- **`x-mcp-header` (mirroring parameter ke header):** bila suatu property
  inputSchema tool menganotasi `"x-mcp-header": "<nama>"`, maka nilai argumen itu
  ikut dikirim sebagai header `Mcp-Param-<nama>` pada `tools/call` tersebut.
  Konversi nilai ke string: string apa adanya; number finite → `String(n)`;
  boolean → `"true"`/`"false"`; tipe lain di-skip. Encoding nilai header:
  bila nilai berupa plain ASCII terlihat (tanpa whitespace di ujung) → apa adanya;
  bila tidak → sentinel base64 `=?base64?<base64 UTF-8>?=`. Berlaku juga untuk
  header `Mcp-Name` (nama tool).
- **Check yang throw gagal dengan pesannya, tidak pernah crash suite.**
- **REST yang dipakai sebagai oracle** (grup ini menilai MCP lewat REST; REST yang
  rusak membuat check MCP gagal dengan route + status disebut):
  `GET /api/v3/user` (login token = owner repo; fallback `ctx.scenario.viewer.login`
  bila route menolak), `POST /api/v3/user/repos`, `GET /api/v3/repos/{owner}/{repo}`,
  `PUT /api/v3/repos/{owner}/{repo}/contents/{path}` (dengan/tanpa `branch`),
  `POST /api/v3/repos/{owner}/{repo}/git/refs`,
  `GET /api/v3/repos/{owner}/{repo}/git/refs/heads/{branch}` (atau `/branches/{branch}`),
  `GET/POST /api/v3/repos/{owner}/{repo}/issues`,
  `GET/POST /api/v3/repos/{owner}/{repo}/pulls`,
  `GET /api/v3/repos/{owner}/{repo}/pulls/{number}`.
  REST memakai header `accept: application/json`,
  `user-agent: makefun-github-core-clone-env`, `content-type: application/json`
  bila ada body, `Authorization: Bearer <token>` bila token non-empty, dan timeout
  yang sama (di-cap 3.000 ms). Path segment di-`encodeURIComponent` per segmen;
  path contents di-encode per segmen dengan slash dipertahankan.
- **Pembacaan hasil tool yang longgar tapi tegas:** list issues/pulls REST
  diterima dalam bentuk array langsung, `{issues: [...]}`, `{pulls: [...]}`, atau
  `{items: [...]}`. Ref PR dibaca dari `head.ref`, `head.branch`, atau segmen
  terakhir `head.label` (`owner:branch` → `branch`).
- **Urutan 15 check grup `mcp`** (id `checkId('mcp', slug)`; masing-masing 1 bit):
  `initialize`, `server-discover`, `tools-list`, `tool-schemas`, `create-issue`,
  `list-issues`, `create-pull-request`, `merge-pull-request`, `unknown-tool`,
  `parse-error`, `missing-arguments`, `concurrent-calls`, `tools-list-idempotent`,
  `rest-parity`, `auth-required`.

---

## Ringkasan angka kunci

| Item | Nilai |
|---|---|
| Endpoint | `<base>/mcp`, POST (DELETE hanya untuk close session legacy) |
| Revisi preferred | `2026-07-28` (modern, `server/discover`, tanpa handshake/session) |
| Revisi legacy | `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` (`initialize` + `notifications/initialized` + opsional `Mcp-Session-Id`) |
| Tools wajib | **6**: `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` |
| Checks grup `mcp` | **15** |
| Timeout per-request MCP | **3.000 ms** (default; di-cap dari budget check) |
| Accept | `application/json, text/event-stream` |
| Auth | `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; tanpa header → HTTP 401 |
| Client identity | `makefun-github-core-clone-env` v`1.0.0` |
