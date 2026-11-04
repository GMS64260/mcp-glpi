# mcp-glpi

A [Model Context Protocol](https://modelcontextprotocol.io/) server for
[GLPI](https://glpi-project.org/), the open-source IT service management
suite. It gives an AI assistant (Claude Desktop, Claude Code, Cursor, Open
WebUI, any MCP client) 46 tools over the GLPI REST API: tickets and their
timeline, problems, changes, validations, assets and every other common
itemtype, users and groups, the knowledge base, multi-criteria search and
reporting. Outputs are compact JSON built for a model's context window, write
tools are annotated and can be switched off with one variable, and the 50
tool names of v3 keep working as hidden aliases.

Version 4.1.0. See [CHANGELOG.md](./CHANGELOG.md) for the release notes and
[Upgrading from 3.x](#upgrading-from-3x) below.

## Install and configure

Requirements: Node.js 20 or later, a GLPI 10 or 11 instance with the REST API
enabled (**Setup > General > API**), an API client (app token, optional) and a
user API token (**My settings > Remote access keys**) or a login and password.

### stdio: Claude Desktop, Claude Code, Cursor

stdio is the default transport: the client starts the server and talks to it
over stdin/stdout. Claude Desktop (`claude_desktop_config.json`) and Cursor
(`~/.cursor/mcp.json` or `.cursor/mcp.json` in a project) use the same shape:

```json
{
  "mcpServers": {
    "glpi": {
      "command": "npx",
      "args": ["-y", "mcp-glpi"],
      "env": {
        "GLPI_URL": "https://glpi.example.com",
        "GLPI_APP_TOKEN": "your-app-token",
        "GLPI_USER_TOKEN": "your-user-token",
        "GLPI_READ_ONLY": "1"
      }
    }
  }
}
```

Drop `GLPI_READ_ONLY` to allow writes. Claude Code:

```bash
claude mcp add glpi \
  -e GLPI_URL=https://glpi.example.com \
  -e GLPI_APP_TOKEN=your-app-token \
  -e GLPI_USER_TOKEN=your-user-token \
  -- npx -y mcp-glpi
```

The server opens a GLPI session at startup (or on the first call if GLPI is
unreachable then) and closes it when the client disconnects.

### Streamable HTTP: Open WebUI and other web clients

```bash
MCP_TRANSPORT=http GLPI_URL=https://glpi.example.com GLPI_USER_TOKEN=... npx -y mcp-glpi
# same with flags
npx -y mcp-glpi --http --host 127.0.0.1 --port 3000 --path /mcp
```

```
MCP GLPI Server v4.0.0 listening on http://127.0.0.1:3000/mcp
  transport: streamable HTTP (stateless, JSON responses)
  auth: none — bind to loopback or set MCP_HTTP_AUTH_TOKEN before exposing this port
```

| Flag | Description |
|---|---|
| `--http` | Shorthand for `--transport http` |
| `--transport <mode>` | `stdio` (default) or `http` |
| `--host <host>` | Bind address (default `127.0.0.1`) |
| `--port <port>` | Port; `0` picks a free port (default `3000`) |
| `--path <path>` | Endpoint path (default `/mcp`) |
| `-h`, `--help` | Print usage |

CLI flags win over the `MCP_*` variables. Endpoints: `POST /mcp` (JSON-RPC,
one JSON response per request) and `GET /health` (liveness, no auth, no GLPI
call). `GET` and `DELETE /mcp` answer 405: the server is stateless and never
pushes messages. A POST must accept both `application/json` and
`text/event-stream` (or `*/*`), as MCP clients do:

```bash
curl -s http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Open WebUI** (v0.6.31 or later): **Admin Settings > External Tools > +**,
type **MCP (Streamable HTTP)** (not OpenAPI), URL `http://<host>:3000/mcp`
(`http://host.docker.internal:3000/mcp` when Open WebUI runs in Docker and
mcp-glpi on the host with Docker Desktop; on Linux, bind mcp-glpi to an
address the container can reach). Auth: **None**, or **Bearer** with the value of
`MCP_HTTP_AUTH_TOKEN` (Open WebUI rejects Bearer with an empty key). Then
enable the tool per chat under **+ > Integrations > Tools**.

**Docker.** No image is published; the npm package runs in any Node image.
Inside a container the server must bind to `0.0.0.0`, so set a token:

```bash
docker run -d --name mcp-glpi -p 127.0.0.1:3000:3000 \
  -e GLPI_URL=https://glpi.example.com -e GLPI_USER_TOKEN=... \
  -e MCP_HTTP_AUTH_TOKEN=change-me -e GLPI_READ_ONLY=1 \
  node:20-alpine npx -y mcp-glpi --http --host 0.0.0.0
```

See [Security notes](#security-notes) before exposing the port.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GLPI_URL` | required | Base URL of GLPI, without `/apirest.php` |
| `GLPI_APP_TOKEN` | none | API client token (**Setup > General > API**), if the API client has one |
| `GLPI_USER_TOKEN` | none | User API token. Either this or `GLPI_USERNAME` + `GLPI_PASSWORD` is required |
| `GLPI_USERNAME`, `GLPI_PASSWORD` | none | Login and password (basic auth on `initSession`) when no user token is set |
| `GLPI_TIMEOUT_MS` | `15000` | Timeout of one GLPI call, body read included. Positive integer (`0` is refused at startup) |
| `GLPI_MAX_RETRIES` | `2` | Retries per call (see [Retries](#retries)); `0` disables them |
| `GLPI_MAX_CONCURRENCY` | `8` | Maximum GLPI calls in flight for the whole process. Positive integer (`0` is refused at startup) |
| `GLPI_DEBUG` | off | Any value: log retries and re-authentication to stderr, keep raw search options in memory |
| `GLPI_TOOLSETS` | `all` | Comma-separated toolsets to register on top of `core`, which is always registered (see [Tool catalogue](#tool-catalogue)); unknown names are ignored with a warning |
| `GLPI_READ_ONLY` | off | `1`/`true`/`yes`/`on`: register only the 21 read-only tools and the 2 `session` switches, which change the session context, not GLPI data (23) |
| `GLPI_LEGACY_TOOLS` | off | `1`/`true`/`yes`/`on`: also list the 50 v3 aliases in `tools/list` (they are callable either way) |
| `GLPI_UPLOAD_DIR` | none | Directory `glpi_upload_document` may read `file_path` from. Unset: uploads by path are refused, `content_base64` still works |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind address |
| `MCP_HTTP_PORT` | `3000` | HTTP port; falls back to `PORT` |
| `MCP_HTTP_PATH` | `/mcp` | HTTP endpoint path |
| `MCP_HTTP_AUTH_TOKEN` | none | When set, every MCP request needs `Authorization: Bearer <token>` (401 otherwise) |
| `MCP_HTTP_ALLOWED_HOSTS` | loopback names | Comma-separated `Host` header allowlist (DNS-rebinding protection). Default when bound to loopback: `localhost`, `127.0.0.1`, `[::1]`, `host.docker.internal`; off when bound elsewhere |

### Retries

GET calls are retried after a network error, a timeout or a 5xx. POST, PUT
and DELETE are retried only when the connection failed before the request was
sent (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`), never after a timeout or a
5xx, because the write may have been applied. A 429 is retried for every
method and honours `Retry-After`. Delays grow exponentially from 300 ms, are
capped at 30 s and get ±20 % jitter. An expired session (401) is re-opened
once and the call replayed.

GLPI computes a session's entities when it opens, so an entity created later
stays out of reach (`403 ERROR_RIGHT_MISSING`) until a new session. A read
refused that way is replayed once on a new session when the current one is
older than a minute; a younger session keeps the 403 (a real missing right
does not open a session per call), and writes are never replayed. Every new
session, after a 401 or this renewal, gets back the profile and entity chosen
with `glpi_set_active_profile` / `glpi_set_active_entity`.

A configuration error (missing `GLPI_URL`, non-numeric `GLPI_TIMEOUT_MS`,
unknown option...) prints one `Configuration error:` line and exits with
status 2; set `GLPI_DEBUG` for the stack trace of other startup failures.

## Tool catalogue

46 tools in 9 toolsets: `core`, `tickets`, `itil`, `assets`, `users`,
`admin`, `session`, `kb`, `stats`. **`core`** (`glpi_list_items`,
`glpi_get_item`, `glpi_search_v2`, `glpi_count`, `glpi_list_search_options`,
`glpi_get_session_info`) is always registered, whatever `GLPI_TOOLSETS` says:
`GLPI_TOOLSETS=tickets` lists the 18 ticket tools and these 6. **W** marks
write tools (removed by `GLPI_READ_ONLY=1`); the others carry
`readOnlyHint: true`. The two `session` switches are kept in read-only mode
and carry `destructiveHint: false`. Updates, status changes, assignments and
deletes carry `destructiveHint: true`. Every tool rejects unknown arguments.

### `tickets` (18)

| Tool | | Main parameters | What it does |
|---|---|---|---|
| `glpi_search_tickets` | | `status`, `open_only`, `assigned_user_id`, `assigned_group_id`, `requester_user_id`, `observer_user_id`, `category_id`, `entity_id`, `priority`, `urgency`, `date_from`, `date_to`, `text_search`, paging | Find tickets; newest update first. The three `*_user_id` filters take a User id or `"me"` |
| `glpi_get_ticket` | | `id`, `with_logs`, `verbose` | One ticket with labels, plain-text content and followup/task/solution `counts` |
| `glpi_get_ticket_timeline` | | `id`, `itemtype`, `kinds` | Followups, tasks, solutions, validations, documents of a Ticket, Change or Problem, oldest first |
| `glpi_list_overdue_tickets` | | `entity_id`, `start`, `limit` | Open tickets past `time_to_resolve`, oldest deadline first |
| `glpi_get_ticket_satisfaction` | | `ticket_id` | Satisfaction survey (score, comment, dates) |
| `glpi_create_ticket` | W | `name`, `content`, `type`, `urgency`, `impact`, `priority`, `category_id`, `entity_id`, `requester_user_id`, `requester_group_id`, `user_id_assign`, `group_id_assign`, `time_to_resolve` | Create a ticket (defaults: type 1 Incident, urgency 3) |
| `glpi_update_ticket` | W | `id`, `name`, `content`, `status`, `urgency`, `impact`, `priority`, `itilcategories_id`, `type`, `time_to_resolve` | Change the given fields |
| `glpi_set_ticket_status` | W | `id`, `status` (1-6) | Change only the status |
| `glpi_delete_ticket` | W | `id`, `purge`, `confirm_id` | Move to the trash; `purge: true` + `confirm_id` = `id` deletes for good |
| `glpi_add_followup` | W | `ticket_id`, `itemtype`, `content`, `is_private` | Comment on a Ticket, Change or Problem |
| `glpi_add_task` | W | `ticket_id`, `itemtype`, `content`, `actiontime` (s), `state`, `is_private`, `users_id_tech`, `groups_id_tech`, `begin`, `end` | Work log / planned task |
| `glpi_add_solution` | W | `ticket_id`, `itemtype`, `content`, `solutiontypes_id` | Add a solution; GLPI marks the item solved |
| `glpi_assign_ticket` | W | `ticket_id`, `user_id`, `group_id`, `type` (actor role, default 2) | Add a user and/or group as requester, assignee or observer |
| `glpi_link_tickets` | W | `ticket_id`, `other_ticket_id`, `relation` | Link two tickets (see [Link relations](#link-relations)) |
| `glpi_add_ticket_validation` | W | `ticket_id`, `users_id_validate`, `comment_submission` | Ask a user to approve a ticket |
| `glpi_set_validation_status` | W | `validation_id`, `status` (2/3), `comment_validation` | Approve or refuse a validation |
| `glpi_upload_document` | W | `content_base64` + `filename`, or `file_path`; `name`, `ticket_id` | Upload a Document (max 20 MB), optionally attached to a ticket |
| `glpi_attach_document_to_ticket` | W | `ticket_id`, `document_id` | Link an existing Document to a ticket |

`"me"` is the connected account: its id is read once from the GLPI session
(`glpiID`) and cached for the life of the process. The actor filters use the
standard search-option ids 4 (requester), 5 (technician) and 66 (observer):
the three options share one uid and column, so unlike the other filters they
cannot be resolved through `listSearchOptions`. On a GLPI where they were
renumbered, filter with `glpi_search_v2`.

`itemtype` on the timeline and on followup/task/solution is `Ticket`
(default), `Change` or `Problem`; `ticket_id` / `id` is then the id of that
item. Problems have no validations.

### `itil` (8)

| Tool | | Main parameters | What it does |
|---|---|---|---|
| `glpi_list_problems` | | paging, `sort`, `order`, `is_deleted`, `verbose` | Problems, newest first, with labels |
| `glpi_get_problem` | | `id`, `verbose` | One problem with `counts` |
| `glpi_create_problem` | W | `name`, `content`, `urgency`, `impact`, `priority`, `category_id`, `entity_id` | Create a problem |
| `glpi_update_problem` | W | `id`, `name`, `content`, `status`, `urgency`, `impact`, `priority`, `itilcategories_id` | Change the given fields |
| `glpi_list_changes` | | paging, `sort`, `order`, `is_deleted`, `verbose` | Changes, newest first, with labels |
| `glpi_get_change` | | `id`, `verbose` | One change with `counts` (validations included) |
| `glpi_create_change` | W | same as `glpi_create_problem` | Create a change |
| `glpi_update_change` | W | same as `glpi_update_problem` | Change the given fields |

To filter problems or changes, use `glpi_search_v2`. Their followups, tasks
and solutions go through the ticket tools with `itemtype`.

### `core` (2) and `assets` (3): generic item tools

These work on 26 itemtypes: `Computer`, `Software`, `NetworkEquipment`,
`Printer`, `Monitor`, `Phone`, `Peripheral`, `Rack`, `Enclosure`, `PDU`,
`KnowbaseItem`, `Contract`, `Supplier`, `Location`, `Entity`, `Project`,
`Document`, `Group`, `ITILCategory`, `Ticket`, `Problem`, `Change`, `User`,
`Profile`, `ProjectTask`, `ProjectState`. The write tools also take the
project links `ProjectTeam`, `ProjectTaskTeam`, `Itil_Project` and
`ProjectTask_Ticket` (create and delete; read them with `glpi_get_item`
`with`).

| Tool | | Main parameters | What it does |
|---|---|---|---|
| `glpi_list_items` | core | `itemtype`, paging, `sort`, `order`, `search_text`, `is_deleted`, `expand_dropdowns`, `fields`, `verbose` | Compact rows of one itemtype; `search_text` = `{column: "substring"}`, `"^x$"` for exact |
| `glpi_get_item` | core | `itemtype`, `id`, `with`, `verbose` | One item; `with` embeds `softwares`, `networkports`, `connections`, `disks`, `documents`, `infocoms`, `contracts`, `tickets`, `problems`, `changes`, `logs`, and the project sections below |
| `glpi_create_item` | W | `itemtype`, `input` | Create from GLPI column values, e.g. `{"name":"PC-42","locations_id":3}`. Without `entities_id` the item lands in the active entity, and the result names it (`entities_id`) |
| `glpi_update_item` | W | `itemtype`, `id`, `input` | Change the given columns; `Computer`, `Project` and `ProjectTask` accept only their usual fields, `Ticket` / `Problem` / `Change` exactly those of `glpi_update_ticket` / `glpi_update_problem` / `glpi_update_change`; links cannot be updated (delete, then create) |
| `glpi_delete_item` | W | `itemtype`, `id`, `purge`, `confirm_id` | Trash, or purge with `confirm_id` = `id` |

`input` never accepts `password` / `password2` for `User`.

**Projects.** `Project` and `ProjectTask` rows carry `state` (the
`ProjectState` name) and `state_is_finished`, so open projects can be told
from finished ones (`glpi_list_items {itemtype: "ProjectState"}` lists the
states). On a `Project`, `glpi_get_item` always adds `counts` (`tasks`,
`team`, `itil`, plus `open_tasks` when the tasks are read) and `with` takes:

| `with` | Key | Content |
|---|---|---|
| `tasks` | `_tasks` | Tasks: state, parent task (`projecttasks_id`), percent done, planned and real dates, durations (seconds), milestone, plain-text content |
| `task_details` | `_tasks` | The tasks, each with its `team` and `tickets` (first 50 tasks, two GLPI calls per task) |
| `team` | `_team` | Team members: `itemtype` (`User`, `Group`, `Supplier`, `Contact`), `items_id`, name |
| `tickets`, `changes`, `problems` | `_tickets`... | Linked ITIL items (`Itil_Project`) with name, `status`, `status_label` |
| `costs` | `_costs` | Costs |
| `items` | `_items` | Linked assets (`Item_Project`) with name |
| `subprojects` | `_subprojects` | Child projects with their state |
| `documents` | `_documents` | GLPI's own `with_documents` |

On a `ProjectTask`, `with` takes `team` and `tickets`. A section GLPI
refuses (`403 ERROR_RIGHT_MISSING`, e.g. a profile that only sees its own
tasks) is reported in `_errors` instead of coming back as an empty list.

Writes: `glpi_create_item {itemtype: "ProjectTask", input: {projects_id, name,
...}}` (GLPI puts the task in its project's entity); team members with
`ProjectTeam` / `ProjectTaskTeam` (`{projects_id or projecttasks_id,
itemtype: "User", items_id}`); links with `Itil_Project`
(`{projects_id, itemtype: "Ticket", items_id}`) and `ProjectTask_Ticket`
(`{projecttasks_id, tickets_id}`). `glpi_update_item` on a `Project` accepts
`name`, `code`, `content`, `comment`, `priority`, `projectstates_id`,
`projecttypes_id`, `projects_id`, `percent_done`, `auto_percent_done`,
`plan_start_date`, `plan_end_date`, `real_start_date`, `real_end_date`,
`users_id`, `groups_id`, `entities_id`, `is_recursive`; with
`auto_percent_done = 1`, GLPI computes `percent_done` from the tasks and
overwrites a manual value. On a `ProjectTask`: `name`, `content`, `comment`,
`projectstates_id`, `projecttasktypes_id`, `projecttasks_id`,
`percent_done`, the four dates, `planned_duration`, `effective_duration`,
`is_milestone`, `users_id`.

### `users` (3), `admin` (2), `session` (2)

| Tool | | Main parameters | What it does |
|---|---|---|---|
| `glpi_list_users` | | paging, `sort`, `order`, `active_only` (default true), `verbose` | Users |
| `glpi_get_user` | | `id`, `verbose` | One user |
| `glpi_find_user` | | `query`, `exact`, `limit` (default 10, max 50) | Match login, last name or first name; exact login first. `exact: true` returns that login or `null` |
| `glpi_create_user` | W (admin) | `name` (login), `realname`, `firstname`, `email`, `phone`, `profiles_id`, `entities_id` | Create an account, without password; `email` becomes a GLPI user e-mail (`_useremails`) |
| `glpi_add_user_to_group` | W (admin) | `user_id`, `group_id`, `is_manager` | Group membership |
| `glpi_get_session_info` | core | `verbose` | `me` (connected user id and names), active profile and entity, available profiles and entities |
| `glpi_set_active_entity` | session | `entity_id` (id or `"all"`), `is_recursive` | Switch the active entity of the shared session |
| `glpi_set_active_profile` | session | `profile_id` | Switch the active profile of the shared session |

### `core` search (3), `kb` (2), `stats` (2)

| Tool | | Main parameters | What it does |
|---|---|---|---|
| `glpi_search_v2` | core | `itemtype`, `criteria`, `forcedisplay`, paging, `sort`, `order`, `fetch_all`, `max_rows`, `expand_dropdowns`, `is_deleted` | Search any itemtype; rows with readable keys |
| `glpi_count` | core | `itemtype`, `criteria` | `{itemtype, totalcount}` without rows |
| `glpi_list_search_options` | core | `itemtype`, `query` | Searchable fields (id, uid, column, datatype, searchtypes) |
| `glpi_search_knowbase` | | `query`, `start`, `limit` | KB articles whose title contains `query` |
| `glpi_create_knowbase_item` | W | `name`, `answer`, `is_faq`, `knowbaseitemcategories_id` | Create a KB article |
| `glpi_tickets_stats_by` | | `dimension` (`status`, `category`, `technician`, `entity`, `month`), `date_from`, `date_to`, `entity_id` | Ticket counts per dimension and `total`; `month` covers the last 6 months by default, 36 at most |
| `glpi_get_asset_stats` | | none | Counts of computers, monitors, printers, network equipment, phones, software |

`criteria` is `[{field, searchtype, value, link}]`. `field` is a search-option
id, uid, column or label (an unknown name is rejected with the 5 closest
options); `searchtype` is `contains`, `notcontains`, `equals`, `notequals`,
`lessthan`, `morethan`, `under`, `notunder`, `empty` or `notempty`; `link`
(`AND`, `OR`, `AND NOT`, `OR NOT`) joins it to the previous criterion. For a
status, use `equals` with a code, `notold` (open), `old` (solved or closed) or
`all`: GLPI's status option is not ordered, so `lessthan 5` also matches
Solved.

```json
{"itemtype": "Computer", "criteria": [{"field": "name", "searchtype": "contains", "value": "PC-"},
 {"link": "AND", "field": "Computer.Location.completename", "searchtype": "contains", "value": "Paris"}]}
```

## Output conventions

- **Compact JSON**: every result is one text block of unindented JSON. GLPI
  HATEOAS `links` are removed.
- **List envelope**: list and search tools return
  `{totalcount, start, count, next_start, items}`. Default page 25 rows,
  `limit` up to 500. Pass `start: next_start` for the next page;
  `next_start: null` means last page. Search tools also take `fetch_all: true`
  (follows pages up to `max_rows`, default 1000). The legacy `range: "0-49"`
  is still accepted on list tools.
- **Readable search keys**: `search/` rows (`glpi_search_tickets`,
  `glpi_search_v2`, `glpi_list_overdue_tickets`, `glpi_search_knowbase`) use
  names instead of option ids. Ticket rows have `name`, `status`, `priority`,
  `urgency`, `category`, `entity`, `requester_name`, `requester_group`,
  `technician_name`, `technician_group`, `observer_name`, `observer_group`,
  `date`, `date_mod`, `solvedate`, `closedate`, `time_to_resolve`,
  `content`; Change and Problem rows `category`, `entity`, `status`, `date`,
  `date_mod`. Other options: own column -> column name, joined column -> last
  two uid segments (`itilcategory_completename`), clashes suffixed with the
  option id. `expand_dropdowns: false` returns ids instead of labels.
- **Labels**: tickets, problems and changes carry `status_label`,
  `urgency_label` and `priority_label` next to the codes; validations carry
  `status_label`.
- **Text fields** (`content`, `answer`, `comment`, `comment_submission`,
  `comment_validation`) are converted from GLPI's HTML (often entity-encoded
  twice) to plain text and cut at `max_content_chars` (default 2000, `0` = no
  cap) with a `…[truncated, N chars]` marker. `raw_html: true` returns the
  stored HTML uncut.
- **Compact projections**: detail and list tools keep the useful fields of
  each itemtype (asset: name, serial, inventory number, state, location,
  users, groups, manufacturer, type/model...). `fields: [...]` on
  `glpi_list_items` picks the keys; `verbose: true` returns every GLPI field.
- **Writes** return `{"success": true, ...}` with the new or changed id
  (`id`, `followup_id`, `task_id`, `solution_id`, `validation_id`,
  `document_id`, `link_id`...).
- **Dates** are `YYYY-MM-DD HH:MM:SS` or `YYYY-MM-DD` in GLPI server time.

## Errors

Two kinds of failure, so a model can tell what to fix:

- **Protocol errors** (JSON-RPC), only when the call does not match the
  listed tool: arguments that fail the advertised schema (unknown key, wrong
  type, missing required argument) give `InvalidParams`, e.g.
  `Invalid arguments for glpi_get_ticket: id: Expected number, received string`;
  an unknown tool gives `MethodNotFound`; a disabled one `InvalidRequest`
  with the reason (`Tool glpi_create_ticket is disabled: the server runs read-only (GLPI_READ_ONLY=1)`).
- **`isError` results** for everything else, with a text the model can act
  on. Argument problems found while running the tool start with
  `Invalid arguments for <tool>:` and say how to fix them: `purge` without
  `confirm_id`, `file_path` outside `GLPI_UPLOAD_DIR`, `"me"` that cannot be
  resolved, a bad link relation, a search field or sort that is not a search
  option of the itemtype, a field `glpi_update_item` does not allow, the
  removed `include_deleted`, nothing to update. GLPI and network failures
  give the GLPI call and a hint:

```
GLPI POST ITILFollowup -> 403 ERROR_RIGHT_MISSING: You don't have permission to perform this action.
Hint: the active GLPI profile lacks the right for this action (or the item is outside the active entities). Check glpi_get_session_info; glpi_set_active_profile / glpi_set_active_entity (session toolset, kept by GLPI_READ_ONLY) can switch.
```

Hints cover expired or missing sessions, missing rights, `ERROR_GLPI_ADD` /
`UPDATE` / `DELETE` / `PURGE`, unknown items or itemtypes, bad request bodies,
wrong app token, IP not allowed, timeouts (`raise GLPI_TIMEOUT_MS`) and an
unreachable GLPI (`check GLPI_URL`).

## Prompts and resources

**Prompts** spell out the tool sequence for common jobs. They only read and
then propose write calls, which the model must confirm with the user. A
prompt is registered only when every tool it names is listed: with
`GLPI_READ_ONLY=1` only `daily_report` and `my_open_tickets` remain, and
`GLPI_TOOLSETS` can drop more. The server names the skipped prompts in one
stderr line at startup.

| Prompt | Arguments | Workflow |
|---|---|---|
| `triage_ticket` | `id` | Read the ticket and its timeline, classify it (type, category, urgency, impact), propose an assignee, a first response and the calls to apply them |
| `daily_report` | `entity_id`, `date` (optional, default today) | New, solved and closed counts, backlog, overdue tickets, top categories, 10-line summary |
| `draft_solution` | `id` | Read the ticket, search the knowledge base and similar solved tickets, draft a solution, propose `glpi_add_solution` |
| `kb_from_ticket` | `id` | Turn a solved ticket into a generic KB article, propose `glpi_create_knowbase_item` (or an update of an existing article) |
| `my_open_tickets` | none | Open tickets assigned to the connected account (`assigned_user_id: "me"`), overdue first, with the three to handle next |

**Resources** (read-only, `application/json`, same conventions as the tools).
Each follows the toolset of the matching tools (`GLPI_TOOLSETS`):
`glpi://tickets/*` and `glpi://ticket/{id}` need `tickets`,
`glpi://problems/open` and `glpi://changes/pending` need `itil`,
`glpi://kb/{id}` needs `kb` and `glpi://user/{id}` needs `users`; the others
are always there:

| URI | Content |
|---|---|
| `glpi://tickets/open` | Open tickets (status `notold`), 100 most recently updated |
| `glpi://tickets/recent` | 20 most recently opened tickets |
| `glpi://problems/open` | Problems with status 1, 2, 3, 4, 7, 8; 50 most recently updated |
| `glpi://changes/pending` | Changes with status 1, 2, 3, 4, 7, 9, 10, 11, 12; 50 most recently updated |
| `glpi://computers` | First 100 computers not in the trash |
| `glpi://groups` | First 100 groups |
| `glpi://categories` | First 100 ITIL categories |
| `glpi://stats/tickets` | Ticket counts: total, new, processing, pending, solved, closed |
| `glpi://stats/assets` | Asset counts per type |
| `glpi://ticket/{id}` | Template: one ticket with labels and its last 10 timeline entries (800 chars each) |
| `glpi://kb/{id}` | Template: one KB article, answer as plain text (10,000 chars max) |
| `glpi://user/{id}` | Template: one user (login, names, phones, entity, profile, location, last login) |

## Reference

The server sends these tables once per session in its `instructions`, so
parameter descriptions stay short.

### Ticket, problem and change status

Ids are GLPI's `CommonITILObject` constants; they are not in workflow order.

| Id | Ticket | Problem | Change |
|---|---|---|---|
| 1 | New | New | New |
| 2 | Processing (assigned) | Processing (assigned) | Processing (assigned) |
| 3 | Processing (planned) | Processing (planned) | Processing (planned) |
| 4 | Pending | Pending | Pending |
| 5 | Solved | Solved | Applied (solved) |
| 6 | Closed | Closed | Closed |
| 7 | | Accepted | Accepted |
| 8 | | Under observation | Review (under observation) |
| 9 | | | Evaluation |
| 10 | | | Approval |
| 11 | | | Testing |
| 12 | | | Qualification |
| 13 | | | Refused |
| 14 | | | Cancelled |

Change workflow order: 1, 9, 10, 7, 4, 11, 12, 5, 8, 6 (13 and 14 end it).
Search values: `notold` = open (1-4 for tickets), `old` = 5-6, `all`.

### Urgency, impact, priority

| Code | Urgency / impact | Priority |
|---|---|---|
| 1 | Very low | Very low |
| 2 | Low | Low |
| 3 | Medium | Medium |
| 4 | High | High |
| 5 | Very high | Very high |
| 6 | | Major (set by hand) |

GLPI computes the priority from urgency and impact when it is not given.

### Other codes

| Field | Values |
|---|---|
| Ticket `type` | 1 Incident, 2 Request |
| Actor role (`glpi_assign_ticket` `type`) | 1 Requester, 2 Assigned, 3 Observer |
| Task `state` | 0 Information, 1 To do, 2 Done |
| Validation status | 1 Waiting, 2 Granted, 3 Refused |
| Timeline `kinds` | `followup`, `task`, `solution`, `validation`, `document` |

### Link relations

`glpi_link_tickets` reads as "`ticket_id` *relation* `other_ticket_id`":

| `relation` | Meaning | GLPI `link` |
|---|---|---|
| `link` (default) | Related | 1 |
| `duplicate` | `ticket_id` duplicates `other_ticket_id` | 2 |
| `child_of` | `ticket_id` is a child of `other_ticket_id` | 3 (SON_OF) |
| `parent_of` | `ticket_id` is the parent of `other_ticket_id` | 4 (PARENT_OF) |

The v3 form `parent_id` + `child_id` (+ numeric `link_type`) is still
accepted; there, 3 and 4 both mean "`parent_id` is the parent of `child_id`".

## Upgrading from 3.x

The configuration is unchanged: same variables, same `npx mcp-glpi`. What
changes is the tool list and the shape of the results. Node.js 20 or later is
now required (v3: 18).

### Renamed tools

v4 lists 46 tools instead of 87. The 50 removed names still work: they are
hidden aliases that translate their arguments and call the v4 tool, so they
return v4 output. `GLPI_LEGACY_TOOLS=1` lists them again (without schemas).
They disappear with their target when a toolset or read-only mode removes it.
Each alias accepts every argument its v3 tool listed (a test calls each one
with its full v3 argument set); `include_deleted` gets an `isError` result
that explains its removal.

| v3 tool | v4 call |
|---|---|
| `glpi_list_tickets` | `glpi_search_tickets` (`range` -> `start`/`limit`, `expand_dropdowns` dropped) |
| `glpi_get_ticket_followups`, `_tasks`, `_solutions`, `_validations`, `_documents` `{ticket_id}` | `glpi_get_ticket_timeline {id, kinds: ["followup" / "task" / "solution" / "validation" / "document"]}` |
| `glpi_get_change_tasks {change_id}` | `glpi_get_ticket_timeline {itemtype: "Change", id, kinds: ["task"]}` |
| `glpi_get_problem_tasks {problem_id}` | `glpi_get_ticket_timeline {itemtype: "Problem", id, kinds: ["task"]}` |
| `glpi_list_computers`, `_softwares`, `_network_equipments`, `_printers`, `_monitors`, `_phones` | `glpi_list_items {itemtype: Computer / Software / NetworkEquipment / Printer / Monitor / Phone}` (`range` -> `start`/`limit`) |
| `glpi_get_computer`, `_software`, `_network_equipment`, `_printer`, `_monitor`, `_phone` | `glpi_get_item {itemtype, id, with}` (`with_softwares`, `with_networkports`, `with_connections`, `with_documents` -> `with`) |
| `glpi_create_computer`, `glpi_create_software` | `glpi_create_item {itemtype, input: <all arguments>}` (booleans -> 0/1) |
| `glpi_update_computer` | `glpi_update_item {itemtype: "Computer", id, input: <other arguments>}` |
| `glpi_delete_computer {id, force}` | `glpi_delete_item {itemtype: "Computer", id, purge: force, confirm_id: id}` (v3 behaviour kept) |
| `glpi_list_knowbase`, `glpi_get_knowbase_item` | `glpi_list_items` / `glpi_get_item {itemtype: "KnowbaseItem"}` |
| `glpi_list_contracts`, `glpi_get_contract`, `glpi_create_contract` | `glpi_list_items` / `glpi_get_item` / `glpi_create_item {itemtype: "Contract"}` |
| `glpi_list_suppliers`, `glpi_get_supplier`, `glpi_create_supplier` | same with `itemtype: "Supplier"` |
| `glpi_list_locations`, `glpi_get_location`, `glpi_create_location` | same with `itemtype: "Location"` |
| `glpi_list_projects`, `glpi_get_project`, `glpi_create_project`, `glpi_update_project` | `glpi_list_items` / `glpi_get_item` / `glpi_create_item` / `glpi_update_item {itemtype: "Project"}` |
| `glpi_list_groups`, `glpi_get_group`, `glpi_create_group` | `glpi_list_items` / `glpi_get_item` / `glpi_create_item {itemtype: "Group"}` |
| `glpi_list_categories` | `glpi_list_items {itemtype: "ITILCategory"}` |
| `glpi_list_entities`, `glpi_get_entity` | `glpi_list_items` / `glpi_get_item {itemtype: "Entity"}` |
| `glpi_list_documents`, `glpi_get_document` | `glpi_list_items` / `glpi_get_item {itemtype: "Document"}` |
| `glpi_search_user {name}` | `glpi_find_user {query: name, exact: true}` |
| `glpi_get_ticket_stats` | `glpi_tickets_stats_by {dimension: "status", ...}` |
| `glpi_search {itemtype, field, searchtype, value}` | `glpi_search_v2 {itemtype, criteria: [{field, searchtype, value}]}` (`range` -> `start`/`limit`; `limit`, `expand_dropdowns` kept) |

The 37 other v3 names are unchanged v4 tools.

### Behaviour changes

- **Output shapes.** Compact JSON; lists are the
  `{totalcount, start, count, next_start, items}` envelope; detail tools
  return a compact projection (`verbose: true` for every field); text is plain
  and capped at 2000 characters (`max_content_chars`, `raw_html`); ITIL items
  carry `status_label`, `urgency_label`, `priority_label`. Timeline aliases
  return `{itemtype, id, count, timeline: [{kind, date, ...}]}`, not a bare
  array.
- **Default limit 25** rows per page (max 500) on every list and search tool.
- **Strict arguments.** Unknown keys are a protocol error instead of being
  ignored. `include_deleted` is gone (an `isError` result says why):
  `is_deleted: true` lists only trashed rows. Ids must be positive integers (numeric strings are accepted).
- **Status filters run in GLPI.** `glpi_list_tickets {status}` used to filter
  one page client-side and miss most matches; it now searches server-side.
- **Open tickets use `notold`.** `open_only`, `glpi_list_overdue_tickets`
  and `glpi://tickets/open` select status `notold`; the v3 `lessthan 5`
  matched Solved tickets.
- **Purge needs `confirm_id`.** `glpi_delete_ticket` and `glpi_delete_item`
  move to the trash; `purge: true` (or the legacy `force: true` on
  `glpi_delete_ticket`) also needs `confirm_id` equal to `id`. Only the
  `glpi_delete_computer` alias keeps the v3 behaviour.
- **Uploads by path need `GLPI_UPLOAD_DIR`.** Without it, send
  `content_base64` + `filename`.
- **`glpi_create_user` has no `password`.** Set it in GLPI, by invitation, or
  rely on LDAP/SSO.
- **Search rows have readable keys** instead of numeric option ids, so code
  that read `row["12"]` must read `row.status`.
- **`glpi_search_user`** matches the login exactly and fails when several
  accounts share it.
- **`glpi_link_tickets`**: v3 inverted `link_type` 3; see
  [Link relations](#link-relations).
- **`glpi_create_user` `email`** is sent as `_useremails`, so GLPI actually
  stores it (v3 sent a plain `email` field, which GLPI ignores).
- **Package entry.** `main`, `types` and `exports` now point to the library
  (`dist/lib.js`); importing `mcp-glpi` no longer starts a server. The
  `mcp-glpi` command (`dist/index.js`) is unchanged.

## Security notes

- **Writes change production data.** `GLPI_READ_ONLY=1` registers only the 21
  read-only tools and the 2 session switches (`glpi_set_active_entity`,
  `glpi_set_active_profile`: they change the session context, not GLPI
  data); write calls then fail at protocol level. Without it, every
  write tool is annotated so clients can ask for confirmation, and the server
  instructions tell the model to confirm with the user first.
- **The GLPI account sets the ceiling.** The server can do what the configured
  user and profile can do. Use a dedicated account with the narrowest profile
  and entities that fit, and `GLPI_TOOLSETS` to drop what you do not need.
- **One GLPI session per process.** In HTTP mode every client shares the
  configured account and session: `glpi_set_active_entity` and
  `glpi_set_active_profile` switch it for all of them. Run one process per
  team or permission level if that matters.
- **HTTP exposure.** The endpoint binds to `127.0.0.1` and has no auth by
  default. Before binding to another interface, set `MCP_HTTP_AUTH_TOKEN`,
  keep the port on a private network or behind TLS, and set
  `MCP_HTTP_ALLOWED_HOSTS`; host validation is off when not bound to
  loopback. The server warns at startup when HTTP runs without
  `GLPI_READ_ONLY`.
- **Uploads.** `file_path` is read only inside `GLPI_UPLOAD_DIR` (real path,
  symlinks resolved, regular files only, 20 MB max). Point it at a dedicated
  directory, never at a home directory.
- **Purge** needs `confirm_id`; **writes are never replayed** after a timeout
  or a 5xx.
- **Secrets** stay in the client configuration or the environment; the server
  never returns them, and the passwords of `User` items cannot be written.

## Development

```bash
git clone https://github.com/GMS64260/mcp-glpi.git
cd mcp-glpi
npm install
npm run build        # tsc -> dist/
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint 9 + typescript-eslint (npm run lint:fix)
npm test             # node:test through tsx, fetch mocked, no GLPI needed
npm run measure      # size of tools/list (full and read-only) and instructions
npm run dev          # run src/index.ts with tsx
npm start            # node dist/index.js (stdio); npm start -- --http for HTTP
```

`npm run measure` builds the catalogue in-process and prints its size, the
largest tools and where the characters go. Today: 46 tools, 25,572
characters (about 7.1k tokens); 23 tools and 12,995 characters with
`GLPI_READ_ONLY=1`; instructions 2,458 characters. `test/server.test.ts` pins
the ceilings.

CI (`.github/workflows/ci.yml`) builds, lints and tests on Node 20 and 22,
and checks the catalogue ceilings. Publishing (`publish.yml`) runs when a
GitHub release is published and uses npm trusted publishing (OIDC, no token
stored in GitHub; provenance is automatic): the package owner registers the
workflow once on npmjs.com (package **Settings > Trusted Publisher > GitHub
Actions**, repository `GMS64260/mcp-glpi`, workflow `publish.yml`). The job
fails when the release tag does not match the `package.json` version, and
stops, successfully, when that version is already on npm (published by hand
with `npm publish`). `prepublishOnly` runs build, lint and tests. The tarball holds `dist/` (no source maps),
`README.md`, `CHANGELOG.md` and `LICENSE`.

`npm run smoke` runs read-only checks against a real GLPI, reading
`GLPI_URL` and the credentials from the environment or a `.env` file at the
repository root (never commit it). `npm run smoke -- --write` adds a write
cycle: it creates a test ticket and moves it to the trash.

### Library use

The package entry (`dist/lib.js`, typed) has no side effects: it reads no
environment variable and opens no session. It exports `GlpiClient`,
`GlpiHttp`, `GlpiSearch`, `SearchOptionsCache`, `createMcpServer` and the
tool catalogue (`ALL_TOOLS`, `ALL_ALIASES`, `INSTRUCTIONS`), the ITIL code
tables (`TICKET_STATUS`, `CHANGE_STATUS`, `TICKET_PRIORITY`...), the error
helpers and the output helpers (`compactItem`, `htmlToText`,
`listEnvelope`...).

```ts
import { GlpiClient, createMcpServer } from 'mcp-glpi';

const client = new GlpiClient({ url: 'https://glpi.example.com', userToken: process.env.GLPI_USER_TOKEN });
const server = createMcpServer({ client, options: { readOnly: true } });
// connect `server` to any MCP transport
```

Layout: `src/index.ts` (CLI, configuration, transports), `src/lib.ts`
(library entry), `src/server.ts` (server factory and instructions),
`src/tools/` (one module per domain, the registry and the v3 aliases),
`src/output.ts` (output conventions), `src/errors.ts` (error text and hints),
`src/prompts.ts`, `src/resources.ts`, `src/glpi-client.ts` and `src/http.ts`
(GLPI API).

## License and links

MIT, see [LICENSE](./LICENSE).

- [npm package](https://www.npmjs.com/package/mcp-glpi)
- [Issues](https://github.com/GMS64260/mcp-glpi/issues)
- [GLPI](https://glpi-project.org/) and its
  [REST API documentation](https://github.com/glpi-project/glpi/blob/main/apirest.md)
- [Model Context Protocol](https://modelcontextprotocol.io/)
