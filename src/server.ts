/**
 * MCP server factory: one McpServer per connection (stdio: one; HTTP: one
 * per request), all sharing the process-wide GlpiClient.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GlpiClient } from './glpi-client.js';
import { registerPrompts, skippedPromptsNote } from './prompts.js';
import { registerResources } from './resources.js';
import { ALIASES } from './tools/aliases.js';
import { ITEM_TOOLS } from './tools/items.js';
import { ITIL_TOOLS } from './tools/itil.js';
import { type AliasDef, type RegistryOptions, type ToolDef, parseRegistryOptions, registerAll, selectTools } from './tools/registry.js';
import { SEARCH_TOOLS } from './tools/search.js';
import { STATS_TOOLS } from './tools/stats.js';
import { TICKET_TOOLS } from './tools/tickets.js';
import { USER_TOOLS } from './tools/users.js';

/** Keep in sync with package.json (a test checks it). */
export const SERVER_VERSION = '4.1.0';

export type ServerOptions = RegistryOptions;
export const parseServerOptions = parseRegistryOptions;

export const ALL_TOOLS: readonly ToolDef[] = [
  ...TICKET_TOOLS,
  ...ITIL_TOOLS,
  ...ITEM_TOOLS,
  ...USER_TOOLS,
  ...SEARCH_TOOLS,
  ...STATS_TOOLS,
];
export const ALL_ALIASES: readonly AliasDef[] = ALIASES;

/**
 * Sent once per session. Holds the reference text that parameter
 * descriptions point to ("see instructions"), so it is not repeated in
 * every tool of tools/list. Keep under 2,500 characters (a test checks it).
 */
export const INSTRUCTIONS = `GLPI IT service management (tickets, problems, changes, assets, users, knowledge base) through the GLPI REST API.
Choosing tools: glpi_search_tickets for tickets by status, actor, category, entity, dates or title; glpi_search_v2 for any itemtype with criteria, glpi_count for totals; glpi_list_items / glpi_get_item for other itemtypes (assets, KB, contracts, groups, entities...); glpi_get_ticket_timeline for followups, tasks, solutions and validations of a ticket, change or problem.
Ids are per itemtype: Ticket 12 and Change 12 are unrelated, so pass the itemtype. Followup/task/solution/timeline tools default to Ticket.
Codes:
- Ticket status: 1 New, 2 Processing (assigned), 3 Processing (planned), 4 Pending, 5 Solved, 6 Closed. Problem: same plus 7 Accepted, 8 Under observation. Change: 1 New, 9 Evaluation, 10 Approval, 7 Accepted, 4 Pending, 11 Testing, 12 Qualification, 5 Applied, 8 Review, 6 Closed, 13 Refused, 14 Cancelled.
- Urgency and impact: 1 Very low, 2 Low, 3 Medium, 4 High, 5 Very high. Priority: same plus 6 Major.
- Ticket type: 1 Incident, 2 Request. Actor role: 1 Requester, 2 Assigned, 3 Observer. Task state: 0 Information, 1 To do, 2 Done. Validation: 1 Waiting, 2 Granted, 3 Refused.
Dates: 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DD', GLPI server time.
Search criteria: [{field, searchtype, value, link}]; field is a search-option id, uid or column (glpi_list_search_options), link joins it to the previous one. Status takes a code, notold (open), old (solved/closed) or all, with equals; never lessthan/morethan. Example: {"itemtype":"Computer","criteria":[{"field":"name","searchtype":"contains","value":"PC-"}]}.
Lists return {totalcount,start,count,next_start,items}, 25 rows by default (limit max 500); pass start=next_start for the next page (null: last). sort: column name or search-option id; order: ASC/DESC. is_deleted=true lists only trashed rows. expand_dropdowns=false gives ids, not labels. fetch_all follows pages up to max_rows (default 1000).
Text fields come as plain text cut at max_content_chars (default 2000, 0 = no cap) with a "…[truncated, N chars]" marker; raw_html=true returns the stored HTML uncut. Rows are a compact projection: fields picks the keys, verbose=true returns every raw GLPI field.
Write tools (create, update, delete, add, assign, link, set, upload) change production data: confirm with the user first. Deletes go to the trash; purge=true is permanent and needs confirm_id equal to id.`;

/**
 * Startup note naming the prompts that `options` leaves without one of their
 * tools (printed once by the CLI; createMcpServer runs per HTTP request).
 */
export function promptStartupNote(options: ServerOptions = {}, tools: readonly ToolDef[] = ALL_TOOLS): string | undefined {
  return skippedPromptsNote(new Set(selectTools(tools, [], options).tools.map((t) => t.name)));
}

export interface CreateMcpServerOptions {
  client: GlpiClient;
  options?: ServerOptions;
  tools?: readonly ToolDef[];
  aliases?: readonly AliasDef[];
}

export function createMcpServer({ client, options = {}, tools = ALL_TOOLS, aliases = ALL_ALIASES }: CreateMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: 'mcp-glpi', version: SERVER_VERSION },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, resources: {} } }
  );
  const selection = registerAll(server, { client, options }, tools, aliases, options);
  registerResources(server, client, options);
  registerPrompts(server, { client, options }, new Set(selection.tools.map((t) => t.name)));
  return server;
}
