# Changelog

## 4.1.0 — 2026-11-04

Projects become readable and writable below the header, a stale entity scope
no longer needs a restart, and a few loose ends of 4.0.0 are tied. No new
tool: the listed catalogue stays at 46 tools (25,572 characters; 12,995 with
`GLPI_READ_ONLY=1`).

### Added

- **Projects (#14).** `glpi_get_item` on a `Project` takes the `with` values
  `tasks`, `task_details` (each task with its team and tickets), `team`,
  `tickets` / `changes` / `problems` (linked through `Itil_Project`, with
  name and `status_label`), `costs`, `items`, `subprojects`, and always
  returns `counts` (`tasks`, `team`, `itil`, `open_tasks` when the tasks are
  read). On a `ProjectTask`, `with` takes `team` and `tickets`. A section
  GLPI refuses is reported under `_errors` instead of an empty list, so "no
  tasks" and "not allowed to see them" no longer look the same.
- **Project states.** `Project` and `ProjectTask` rows (list and detail)
  carry `state` (the `ProjectState` name) and `state_is_finished`.
- **New itemtypes.** `ProjectTask` and `ProjectState` in the generic item
  tools; the write tools also take the links `ProjectTeam`,
  `ProjectTaskTeam`, `Itil_Project` and `ProjectTask_Ticket` (create,
  delete). `glpi_create_item` checks the fields GLPI needs for them
  (`projects_id` for a task, the two ends of a link).
- **Created where?** `glpi_create_item` without `entities_id` returns the
  entity the item landed in (`entities_id`), since GLPI silently uses the
  active entity.

### Changed

- `glpi_update_item` on a `Project` also accepts `code`, `comment`,
  `priority`, `projectstates_id`, `projecttypes_id`, `projects_id`,
  `auto_percent_done`, `plan_start_date`, `plan_end_date`, `users_id`,
  `groups_id`, `entities_id`, `is_recursive`; on a `ProjectTask`, the task
  fields (state, type, parent, percent done, dates, durations, milestone).
  Links cannot be updated: delete and create again.
- Resource templates follow `GLPI_TOOLSETS` like the fixed resources:
  `glpi://ticket/{id}` needs `tickets`, `glpi://kb/{id}` `kb`,
  `glpi://user/{id}` `users`.
- `publish.yml` uses npm trusted publishing (OIDC) instead of an
  `NPM_TOKEN` secret, checks the release tag against `package.json`, and
  succeeds without publishing when the version is already on npm.

### Fixed

- **Entities created after startup (#13).** GLPI computes a session's
  entities at login, so a newer entity answered `403 ERROR_RIGHT_MISSING`
  until the process restarted. A read refused that way is now replayed once
  on a new session when the current one is older than a minute (the old one
  is closed); writes are never replayed, and a younger session keeps the 403.
- The active profile and entity chosen with `glpi_set_active_profile` /
  `glpi_set_active_entity` were lost when the session was re-opened after a
  401; every new session now gets them back.
- An invalid environment value or option prints one `Configuration error:`
  line and exits with status 2, without a stack trace (set `GLPI_DEBUG` for
  the trace of other startup failures).

## 4.0.0 — 2026-10-21

A smaller, stricter tool catalogue with compact outputs, prompts and resource
templates. The configuration is unchanged; the 50 removed tool names keep
working as hidden aliases. 3.5.0 was prepared but never published: its fixes
ship here, under **Fixed**. Upgrade guide: README, "Upgrading from 3.x".

### Breaking changes

- **46 listed tools instead of 87.** Asset, KB, contract, supplier, location,
  entity, project, document, group and category CRUD folds into
  `glpi_list_items` / `glpi_get_item` / `glpi_create_item` /
  `glpi_update_item` / `glpi_delete_item`; ticket followups, tasks,
  solutions, validations and documents, and change/problem tasks, into
  `glpi_get_ticket_timeline`; `glpi_list_tickets` into `glpi_search_tickets`;
  `glpi_get_ticket_stats` into `glpi_tickets_stats_by`; `glpi_search_user`
  into `glpi_find_user`; `glpi_search` into `glpi_search_v2`. The 50 removed
  names stay callable as hidden aliases that map their arguments (listed
  again with `GLPI_LEGACY_TOOLS=1`); the full table is in the README,
  "Upgrading from 3.x". Aliases return the v4 output of their target and
  accept every argument their v3 tool listed (`range`, `include_deleted`
  answered with an explanatory `isError`, `with_*`, `force`...).
- **Output shapes.** Compact JSON. Lists return
  `{totalcount, start, count, next_start, items}`. Detail and list tools
  return a per-itemtype compact projection (`verbose: true` for every field,
  `fields` on `glpi_list_items`). HATEOAS `links` are gone. Text fields
  (`content`, `answer`, `comment`, validation comments) are plain text capped
  at `max_content_chars` (default 2000, `0` = no cap; `raw_html: true` keeps
  the stored HTML). ITIL items carry `status_label`, `urgency_label`,
  `priority_label`. Search rows use readable keys instead of option ids
  (`requester_name`, `technician_name`, `category`, `entity`, `status`...).
  The timeline returns `{itemtype, id, count, timeline: [{kind, date, ...}]}`.
- **Strict arguments.** Unknown keys are rejected with a JSON-RPC
  `InvalidParams` error instead of being ignored; ids must be positive
  integers (numeric strings accepted). `include_deleted` is refused with an
  `isError` result that explains it: it meant `is_deleted=1`, which lists
  only trashed rows. Legacy parameters
  (`range`, `force`, `parent_id` / `child_id` / `link_type`) are still
  accepted but no longer listed.
- **Defaults.** 25 rows per page on every list and search tool (max 500).
  Open tickets (`open_only`, `glpi_list_overdue_tickets`,
  `glpi://tickets/open`) are selected with status `notold`: `lessthan 5`
  matched Solved tickets, because GLPI's status option is not ordered.
- **Purge needs confirmation.** `purge: true` (or the legacy `force: true`)
  on `glpi_delete_ticket` and `glpi_delete_item` needs `confirm_id` equal to
  `id`; without `purge` the item goes to the trash. The
  `glpi_delete_computer` alias keeps the v3 behaviour.
- `glpi_create_user` has no `password` parameter, and `glpi_create_item` /
  `glpi_update_item` refuse `password` / `password2` on `User`.
- `glpi_upload_document` reads `file_path` only inside `GLPI_UPLOAD_DIR`
  (see Security).
- **Node.js 20 or later** (`engines.node >= 20`; v3: 18).
- **Package entry.** `main`, `types` and `exports` point to the library
  entry `dist/lib.js` instead of the CLI: importing `mcp-glpi` no longer
  starts a server. The `mcp-glpi` bin (`dist/index.js`) is unchanged.

### Added

- Generic item tools `glpi_list_items`, `glpi_get_item` (`with`: softwares,
  networkports, connections, disks, documents, infocoms, contracts, tickets,
  problems, changes, logs), `glpi_create_item`, `glpi_update_item`,
  `glpi_delete_item` over 24 itemtypes, including `Peripheral`, `Rack`,
  `Enclosure`, `PDU` and `Profile`, which had no list or get tool in v3.
  `glpi_update_item` restricts `Computer` and `Project` to their usual
  fields, and `Ticket` / `Problem` / `Change` to the fields of
  `glpi_update_ticket` / `glpi_update_problem` / `glpi_update_change` (same
  lists in the code).
- `glpi_get_ticket_timeline`: `kinds` (`followup`, `task`, `solution`,
  `validation`, `document`; attached documents are new), `verbose`,
  `max_content_chars`, `raw_html`.
- ITIL-generic writes: `itemtype` (`Ticket`, `Change`, `Problem`) on
  `glpi_add_followup`, `glpi_add_task` and `glpi_add_solution`.
- `glpi_set_ticket_status`; `glpi_find_user` (login, last name or first
  name, exact login first); `me` (connected user id and names) in
  `glpi_get_session_info`.
- `glpi_search_tickets`: `"me"` for `assigned_user_id`, `requester_user_id`
  and the new `observer_user_id`, resolved once from the session's `glpiID`
  and cached; the `my_open_tickets` prompt uses it. The actor filters use
  GLPI's standard search-option ids (requester 4, technician 5, observer
  66): the three options share one uid, so they cannot be resolved by name.
- Entity and profile switching: `glpi_set_active_entity` (id or `"all"`,
  `is_recursive`) and `glpi_set_active_profile`.
- New parameters: `type` and `time_to_resolve` on `glpi_update_ticket`;
  `begin` and `end` on `glpi_add_task`; `query` on
  `glpi_list_search_options`; `is_deleted` on `glpi_search_tickets`; `start`
  on `glpi_list_overdue_tickets`; `max_content_chars` / `raw_html` on the
  tools that return text.
- Five MCP prompts that spell out the tool sequence and ask the user before
  any write: `triage_ticket`, `daily_report`, `draft_solution`,
  `kb_from_ticket`, `my_open_tickets`. A prompt is registered only when
  every tool it names is listed (one stderr note at startup names the
  skipped ones); `glpi://tickets/*` need the `tickets` toolset,
  `glpi://problems/open` and `glpi://changes/pending` the `itil` toolset.
- Resource templates `glpi://ticket/{id}` (ticket and its last 10 timeline
  entries, in the `glpi_get_ticket_timeline` shape), `glpi://kb/{id}` (article as plain text), `glpi://user/{id}`. The
  fixed resources return list envelopes with compact rows.
- `GLPI_TOOLSETS` (`tickets`, `itil`, `assets`, `users`, `kb`, `stats`,
  `session`, `admin`; `core` = `glpi_list_items`, `glpi_get_item`,
  `glpi_search_v2`, `glpi_count`, `glpi_list_search_options`,
  `glpi_get_session_info` is always registered) and `GLPI_READ_ONLY=1`
  (21 read-only tools plus the 2 session switches, which change the session
  context, not GLPI data);
  a disabled tool answers with the reason. `GLPI_LEGACY_TOOLS=1` lists the
  aliases. HTTP mode warns at startup when `GLPI_READ_ONLY` is unset.
- Server `instructions` (sent once per session): when to use which tool,
  status / urgency / priority / type / role / task / validation codes, date
  format, search criteria, paging and text rules.
- GLPI and network failures come back as `isError` results with a hint line
  per GLPI error code (rights, session, unknown item or itemtype, app token,
  IP, timeout, unreachable GLPI). Argument problems found by a handler
  (`purge` without `confirm_id`, upload outside `GLPI_UPLOAD_DIR`, `"me"`
  unresolved, link relation, unknown search field or sort, refused update
  field, `include_deleted`) are `isError` results too, starting with
  `Invalid arguments for <tool>:`. Only arguments that fail the advertised
  schema and unknown or disabled tools are protocol errors.
- Global in-flight limit `GLPI_MAX_CONCURRENCY` (default 8).
- Stricter numeric settings: `GLPI_TIMEOUT_MS` and `GLPI_MAX_CONCURRENCY`
  must be positive integers and `GLPI_MAX_RETRIES` a non-negative one
  (`0` = no retry); `0` timeout or concurrency, negative or non-numeric
  values (`15s`) stop the server at startup with the variable name.
- Library entry `src/lib.ts` (package `main` / `types` / `exports`), free of
  side effects: `GlpiClient`, `GlpiHttp`, `GlpiSearch`, `SearchOptionsCache`,
  `createMcpServer`, the tool catalogue, the ITIL code tables, error and
  output helpers.
- Tooling: `npm run lint` (ESLint 9 + typescript-eslint), `npm run
  typecheck`, `npm run measure` (size of `tools/list`, full and read-only,
  and of the instructions; a test pins the ceilings). CI on Node 20 and 22
  (build, lint, test, catalogue ceilings); `publish.yml` publishes to npm
  with provenance when a GitHub release is published (`NPM_TOKEN` secret).
  `prepublishOnly` runs build, lint and tests. The tarball ships `dist/`
  without source maps, `README.md`, `CHANGELOG.md` and `LICENSE` (54 files,
  112 kB).
- Internals: one `McpServer` with a typed tool registry and one module per
  domain (`src/tools/`), name-derived safety annotations, an in-memory
  client/server test harness (`test/server.test.ts`).

### Fixed

HTTP layer:

- Writes are no longer replayed after an ambiguous failure: GET is retried
  after a network error, a timeout or a 5xx; POST/PUT/DELETE only after
  `ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN` (request never sent). 429 is
  retried for every method.
- `Retry-After` and exponential backoff are capped at 30 s with ±20 % jitter;
  `Retry-After` also accepts an HTTP date.
- The response body is read inside the timeout window, so a stalled body
  aborts instead of hanging.
- `initSession` fails clearly when GLPI returns no `session_token`;
  concurrent 401s refresh the session only if it is still the token the
  failing request used; `killSession` uses the current token and never
  re-authenticates.
- An unreachable GLPI gives "Cannot reach GLPI (ECONNREFUSED)" and a hint
  instead of "fetch failed".

Search and data:

- Search rows (`glpi_search_v2`, `glpi_search_tickets`,
  `glpi_list_overdue_tickets`, `glpi_search_knowbase`, resources) have
  readable keys: own column -> column name, joined column -> last two uid
  segments (`itilcategory_completename`), clashes suffixed with the option
  id. GLPI's `uid_cols` is not used: it merges requester and technician
  under one key.
- The search-options cache makes one fetch per itemtype at a time, does not
  cache failures, and keeps raw entries only with `GLPI_DEBUG`.
- `glpi_list_users` with the active filter returns the same shape as the
  plain list and honours sort and order; this also fixes
  `glpi_tickets_stats_by dimension=technician`.
- User lookup by login is exact, including logins stored with trailing
  spaces, and fails when several accounts share it (v3 returned the first
  partial match).
- The ticket status filter runs in GLPI (v3 `glpi_list_tickets` filtered one
  page client-side and missed most matches).
- `glpi://problems/open` (statuses 1, 2, 3, 4, 7, 8) and
  `glpi://changes/pending` (1, 2, 3, 4, 7, 9, 10, 11, 12) use server-side
  status criteria, newest update first; the v3 `status < 5` / `< 8` filters
  dropped Accepted and Observed problems and misclassified changes.
- `glpi_tickets_stats_by dimension=month`: month boundaries in local time
  (UTC shifted them), tickets created at 00:00:00 on the 1st are counted, at
  most 36 months.
- `glpi_list_overdue_tickets` compares with local time and resolves
  `time_to_resolve` dynamically; `glpi_search_tickets` resolves its Ticket
  fields the same way.
- Criteria with an unknown field name are rejected with the 5 closest option
  names (they silently searched on field 0).
- Ticket priority labels use the priority scale (6 = Major), not urgency.
- `counts` on `glpi_get_ticket` / `glpi_get_change` / `glpi_get_problem` use
  `range=0-0` and `Content-Range` instead of downloading every child.

Writes and validation:

- `glpi_link_tickets`: GLPI's `Ticket_Ticket` constants are 3 = SON_OF and
  4 = PARENT_OF with `tickets_id_1` as the subject; v3 sent `link_type` 3
  ("parent") as SON_OF and inverted the relation. New arguments `ticket_id`,
  `other_ticket_id`, `relation` (`link`, `duplicate`, `child_of`,
  `parent_of`); with the legacy `parent_id` / `child_id`, 3 and 4 both mean
  "`parent_id` is the parent of `child_id`".
- `glpi_assign_ticket` with both `user_id` and `group_id` creates both links
  (the group was ignored) and returns both ids.
- Required arguments and ids are checked before calling GLPI: a missing id
  is `InvalidParams`, not `PUT Problem/undefined`.
- Update tools reject unknown fields; the Computer update no longer forwards
  arbitrary arguments.
- `glpi_set_validation_status` accepts `"2"` / `"3"`.
- `glpi_create_user` sends the e-mail as `_useremails`, GLPI's mechanism for
  user addresses; the plain `email` field v3 sent was ignored.

Other:

- stdio: the server closes its GLPI session and exits when stdin ends or the
  transport closes, instead of lingering as an orphan.

### Performance

- `tools/list` shrinks from 41.9k characters for 87 tools (v3) to 25.3k for
  46 tools, 12.8k with `GLPI_READ_ONLY=1` (23 tools). Code tables, the date
  format and the paging and text rules moved to the instructions (2.5k,
  sent once); descriptions are at most 160 characters; listed schemas drop
  `$schema`, `additionalProperties: false`, redundant minimums, defaults and
  annotations equal to the MCP defaults. Validation is unaffected.
- Default page of 25 rows and capped text fields keep results small.

### Security

- `glpi_upload_document`: `file_path` is read only when `GLPI_UPLOAD_DIR` is
  set, and only for a regular file whose real path (symlinks resolved) is
  inside it; 20 MB max. New inline alternative `content_base64` +
  `filename` (bare file name only).
- Purge needs `confirm_id` equal to `id`.
- No password through this server: `glpi_create_user` has no `password`
  parameter, and `password` / `password2` are refused on `User` items.
- Writes are never retried after a timeout or a 5xx (see Fixed).
- `GLPI_READ_ONLY=1` removes every write tool (the session switches stay);
  HTTP mode warns when it is unset.

### Credits

- @Emanoel-Eijtec reported issue #9 (Change and Problem coverage), fixed in
  3.4.0 and extended here to followups, tasks and solutions on changes and
  problems.
- @silenceroom contributed the Streamable HTTP transport (PR #10, shipped in
  3.4.0) that Open WebUI uses.
- @PatrickC09 contributed `glpi_upload_document` (PR #7, 3.3.0), hardened in
  this release.

## 3.4.0 — 2026-10-21

### Fixed (issue #9 — Change / Problem coverage)

- **Change and Problem tasks are now readable**: new `glpi_get_change_tasks`
  (`GET /Change/{id}/ChangeTask`) and `glpi_get_problem_tasks`
  (`GET /Problem/{id}/ProblemTask`). Previously only `TicketTask` was reachable,
  and passing a change id to `glpi_get_ticket_tasks` silently returned the
  tasks of the unrelated *ticket* with the same number. The ticket tool's
  description now says so.
- **`glpi_get_ticket_timeline` accepts `itemtype`** (`Ticket` default,
  `Change`, `Problem`): followups, tasks, solutions and validations are read
  from the right sub-resources (`ChangeTask`, `ChangeValidation`, ...;
  problems have no validation object in GLPI).
- `glpi_get_change` / `glpi_get_problem` now return `counts` of followups,
  tasks, solutions (and validations for changes), like `glpi_get_ticket`.
- **Change status labels were wrong**: the map assumed a 1..12 sequence, but
  GLPI uses `CommonITILObject` constants (Applied=5, Closed=6, Accepted=7,
  Review=8, Evaluation=9, Approval=10, Testing=11, Qualification=12,
  Refused=13, Cancelled=14). A solved change (5) was labelled "Pending".
- **Problem status labels**: 2 is "Processing (assigned)" (was "Accepted"),
  7 "Accepted" and 8 "Under observation" were missing.
- **`sort` on `glpi_list_*` returned HTTP 400** (`sort param is not a field of
  glpi_changes`): `GET /{itemtype}` sorts by column name, not by search-option
  id. `sort` now accepts a column name (`"date_mod"`) or a search-option id,
  which is resolved to its column through the SearchOptions catalogue (own
  table only; joined fields return a clear error). The zod schema also
  accepted only strings while the JSON schema advertised numbers, so numeric
  sorts on `glpi_list_tickets` failed validation.
- Status labels and ITIL itemtype helpers moved to `src/itil.ts` and are unit
  tested (`test/itil.test.ts`).

### Added

- **Streamable HTTP transport** (`MCP_TRANSPORT=http`, or `--http`): the
  server can now serve MCP over HTTP at `http://<host>:<port>/mcp` (JSON-RPC,
  stateless, JSON responses) in addition to stdio. This is the only transport
  Open WebUI supports ("MCP (Streamable HTTP)" under Admin Settings → External
  Tools), so `mcp-glpi` can now be attached to it directly. The endpoint also
  answers `GET /health` for liveness probes. stdio stays the default, so
  existing Claude Desktop / Claude Code configs are unaffected.
- CLI flags: `--http`, `--transport <stdio|http>`, `--host`, `--port`
  (`0` picks a free port), `--path`, `--help`.
- HTTP environment variables: `MCP_HTTP_HOST` (default `127.0.0.1`),
  `MCP_HTTP_PORT` (falls back to `PORT`), `MCP_HTTP_PATH` (default `/mcp`),
  `MCP_HTTP_AUTH_TOKEN` (optional `Authorization: Bearer` requirement),
  `MCP_HTTP_ALLOWED_HOSTS` (Host-header allowlist).
- Tests: `test/http-server.test.ts` covers transport configuration, the
  JSON-RPC endpoint (initialize / tools/list / tools/call), HTTP edge cases
  (405 on GET/DELETE, 404, malformed and oversize bodies), bearer auth and
  Host-header validation.

### Fixed

- Concurrent requests no longer open duplicate GLPI sessions: `initSession()`
  is now single-flight, so parallel calls share one session instead of each
  opening — and leaking — their own. Matters as soon as several HTTP clients
  (or one client issuing parallel tool calls) hit the server at once.

### Changed

- The MCP `serverInfo` version now reports the package version instead of the
  stale hard-coded `3.0.0`.

## 3.3.0 — 2026-08-05

### Added

- **`glpi_upload_document`** (PR #7 by @PatrickC09): upload a local file
  as a GLPI Document via multipart `POST /Document` (`uploadManifest` + `filename[0]`), with an
  optional `ticket_id` that links the document to the ticket in the same
  call. The link is declared inside the manifest (`itemtype`/`items_id`) so
  it also works for restricted profiles (e.g. Self-Service requesters) that
  cannot `POST Document_Item` directly. MIME type is derived from the file
  extension.
- `form` option in the HTTP layer (`GlpiHttp.request`) for multipart bodies:
  the JSON `Content-Type` is omitted so `fetch` can set the boundary. Note
  the manifest must be appended as a plain string field — parts carrying a
  filename land in PHP's `$_FILES` and GLPI reads the manifest from `$_POST`.
- Tests: multipart header handling, manifest/file pair building, manifest
  item linking, and default document naming (`test/upload.test.ts`).

## 3.2.0 — 2026-07-04

### Added

- **MCP tool safety annotations** on all 84 tools (fixes #3, AgentSeal findings):
  - `readOnlyHint: true` on every list/get/search/count/stats tool (56 tools).
  - `destructiveHint: true` on delete/update/set/assign tools (9 tools) —
    agents now get an explicit signal before invoking `glpi_delete_ticket`,
    `glpi_delete_computer`, `glpi_update_*`, etc.
  - `idempotentHint` and `openWorldHint: false` everywhere (tools only reach
    the configured GLPI instance).
  - Annotations are derived from the tool name, so future tools are
    annotated automatically.
- **Live smoke test** (`npm run smoke`, `npm run smoke -- --write`):
  23 checks against a real instance — session, SearchOptions cache, field
  resolution, count/search/stats, timeline, users/computers/groups/entities,
  and an optional write cycle (create test ticket → followup → rename →
  soft delete → verify trash). Reads credentials from env or `.env`
  (gitignored). Validated against GLPI 11 (French locale).

### Fixed

- **Search off-by-one**: `search()` passed `limit` as the range end, but GLPI
  ranges are inclusive — `limit: 5` returned 6 rows. Affected `glpi_search_v2`,
  `glpi_search_tickets`, `glpi_count`-adjacent paths and the active-users
  filter. Found by the live smoke test.
- **`resolveField` failed on localized instances**: friendly-name resolution
  only matched the translated label ("Statut" on a French GLPI), so
  `resolveField('Ticket', 'status')` returned undefined. Resolution now tries,
  in order: explicit uid → canonical own-table uid (`Ticket.status`) →
  localized label → raw SQL column name, with own-table priority on column
  collisions (e.g. `name` exists on both glpi_tickets and joined glpi_users).

## 3.1.0 — 2026-07-04

Reliability hardening after the v3.0.0 audit.

### Added

- **Request timeouts**: every HTTP call (including `initSession`) is wrapped in
  an `AbortController` with a configurable timeout (`GLPI_TIMEOUT_MS`, default
  15 s). A hung GLPI backend can no longer block the MCP server indefinitely.
- **Retry on `429` and network errors**: rate-limited responses honour the
  `Retry-After` header; transient network failures (ECONNRESET, timeouts) are
  retried with the same exponential backoff as `5xx`.
- **Runtime input validation (zod)** on ticket tools (`glpi_list_tickets`,
  `glpi_get_ticket`, `glpi_search_tickets`): invalid arguments now return a
  clear `InvalidParams` MCP error instead of failing downstream in GLPI.
- **Differentiated MCP errors**: zod validation → `InvalidParams`;
  `GlpiError` → message with HTTP status + GLPI code; everything else →
  `InternalError`.
- **Config validation at startup**: `GLPI_URL` must be a valid URL and an
  authentication method must be configured — fail fast with a clear message.
- **Debug logging** (`GLPI_DEBUG=1`): retries, re-authentication and
  rate-limiting events are logged to stderr (stdout stays reserved for the MCP
  stdio transport).
- **Resilient startup**: if GLPI is unreachable when the server starts, a
  warning is logged and the session is established lazily on the first request
  (previously the server exited immediately).
- New env vars: `GLPI_TIMEOUT_MS`, `GLPI_MAX_RETRIES`, `GLPI_DEBUG`.
- 3 new HTTP-layer tests (timeout abort, 429 retry, network-error retry) — 7 total.

## 3.0.0 — 2026-06-08

Major overhaul focused on the foundations and on ITSM/reporting coverage.

### Added

- **Unified HTTP layer** (`src/http.ts`) with:
  - Automatic re-authentication on `401` (expired `session_token`).
  - Exponential-backoff retry on `5xx`.
  - Structured `GlpiError` exposing HTTP status + GLPI error code/message + body.
- **Multi-criteria search** via the new high-level `GlpiSearch` (`src/search.ts`):
  - Array of criteria with `link` operator (`AND` / `OR` / `AND NOT` / `OR NOT`).
  - `forcedisplay` to choose returned columns.
  - Pagination via `start`/`limit`, `fetch_all` with `max_rows` safety cap (default 1000).
  - Reads `totalcount` and `Content-Range` header.
- **`SearchOptionsCache`** (`src/search-options.ts`): caches
  `/listSearchOptions/{itemtype}` (TTL 1h) so high-level tools translate
  friendly names ↔ `field_id` resilient to GLPI version drift.
- **New MCP tools**:
  - `glpi_count` — cheap totalcount probe (range=0-0) with criteria.
  - `glpi_search_v2` — multi-criteria search; `glpi_search` kept as deprecated alias.
  - `glpi_list_search_options` — discover field ids of an itemtype.
  - `glpi_search_tickets` — friendly params (status, assigned_user/group,
    requester, category, entity, priority, urgency, date_from/to, text_search,
    open_only) translated to criteria internally.
  - `glpi_get_ticket_timeline` — merged followups + tasks + solutions +
    validations, sorted chronologically.
  - `glpi_tickets_stats_by(dimension, period)` — counts ventilated by
    status / category / technician / entity / month.
  - `glpi_link_tickets` — Ticket_Ticket relations (link / duplicate / parent).
  - `glpi_add_ticket_validation`, `glpi_set_validation_status`,
    `glpi_get_ticket_validations`.
  - `glpi_attach_document_to_ticket`, `glpi_get_ticket_documents`.
  - `glpi_get_ticket_satisfaction`, `glpi_list_overdue_tickets`.
  - `glpi_get_ticket_solutions`.
  - Symmetric `update`/`delete` on Monitor, Phone, Printer, Software,
    NetworkEquipment (parity with Computer).
- **`expand_dropdowns=true` by default** on all detail reads — foreign-key IDs
  come back resolved (technician name, category label, entity, etc.) while raw
  IDs remain available alongside.
- **Tests**: minimal integration tests using `node --test` + `tsx` (HTTP layer,
  re-auth, retry, error parsing).

### Fixed

- **F9** — Ticket and asset stats no longer fetch up to 9999 rows just to count
  them: they now use criteria + `range=0-0` totalcount probes. Accurate beyond
  10 k tickets, much faster.
- **F10** — `glpi_list_users` `active_only` filter previously used `searchText`
  (LIKE on a label column), which silently mismatched. Now uses the search
  endpoint with `criteria=is_active equals 1`.
- **F12** — `glpi_assign_ticket` ignored `group_id`. It now routes to
  `Group_Ticket` when a group is provided, and `Ticket_User` for a user.
- `glpi_search_knowbase` no longer hard-codes `field=6` for the title; the
  field id is resolved via `listSearchOptions/KnowbaseItem`.

### Changed (breaking)

- **`GlpiClient` constructor**: same shape (`GlpiConfig`) but the internal
  fetch/session/error layer is now `GlpiHttp`. Public domain methods keep
  their v2 names; their behaviour is hardened (see Fixed).
- **`glpi_list_*` tools**: now accept `start`, `range`, `sort`, `order`,
  `expand_dropdowns`. The previous `limit`-only form still works.
- **`glpi_search`**: marked deprecated. Prefer `glpi_search_v2`.
- **Build target**: `strict` TypeScript already, with `tsx` instead of
  `jest`/`ts-node` for test execution.

### Removed

- `eslint` was referenced in `package.json` scripts but never installed; the
  unused script is removed to avoid confusion. Linting can be reintroduced
  alongside tests if needed.
