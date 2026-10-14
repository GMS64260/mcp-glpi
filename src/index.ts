#!/usr/bin/env node

/**
 * MCP Server for GLPI v3.0
 *
 * Major changes vs v2:
 *   - Unified HTTP layer with auto-reauth, structured errors, retries.
 *   - List tools accept start/limit/fetch_all/forcedisplay/criteria/sort/order
 *     (backward-compatible: `limit` alone still works).
 *   - New `glpi_count` and `glpi_search_v2` (multi-criteria, forcedisplay).
 *   - High-level `glpi_search_tickets` with friendly params (status/assigned/...).
 *   - `glpi_get_ticket_timeline` merges followups+tasks+solutions+validations.
 *   - `glpi_tickets_stats_by` ventilation by status/category/technician/entity/month.
 *   - Link, validation, document, SLA, satisfaction tools.
 *   - Field-id mapping via /listSearchOptions for resilience across GLPI versions.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  CallToolRequest,
  CallToolResult,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceRequest,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import { GlpiClient, GlpiConfig, ListOptions } from './glpi-client.js';
import { GlpiError } from './http.js';
import {
  ConfigError,
  HttpTransportConfig,
  USAGE,
  parseTransportConfig,
  startHttpMcpServer,
} from './http-server.js';
import { SearchCriterion, SearchType, SearchLink } from './search.js';

/** Keep in sync with package.json (see CLAUDE.md). */
const SERVER_VERSION = '3.4.0';

// ---------------------------------------------------------------------------
// Validation Schemas
// ---------------------------------------------------------------------------

const listArgsSchema = z.object({
  start: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
  range: z.string().optional(),
  sort: z.string().optional(),
  order: z.enum(['ASC', 'DESC']).optional(),
  expand_dropdowns: z.boolean().optional(),
  criteria: z.array(z.unknown()).optional(),
  fetch_all: z.boolean().optional(),
}).passthrough();

const ticketReadSchema = z.object({
  id: z.number().int().min(1),
  with_logs: z.boolean().optional(),
}).passthrough();

const ticketSearchSchema = z.object({
  status: z.number().optional(),
  assigned_user_id: z.number().optional(),
  assigned_group_id: z.number().optional(),
  requester_user_id: z.number().optional(),
  category_id: z.number().optional(),
  entity_id: z.number().optional(),
  priority: z.number().optional(),
  urgency: z.number().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  text_search: z.string().optional(),
  open_only: z.boolean().optional(),
  start: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TICKET_STATUS: Record<number, string> = {
  1: 'New',
  2: 'Processing (assigned)',
  3: 'Processing (planned)',
  4: 'Pending',
  5: 'Solved',
  6: 'Closed',
};

const TICKET_URGENCY: Record<number, string> = {
  1: 'Very low',
  2: 'Low',
  3: 'Medium',
  4: 'High',
  5: 'Very high',
};

const PROBLEM_STATUS: Record<number, string> = {
  1: 'New', 2: 'Accepted', 3: 'Planned', 4: 'Pending', 5: 'Solved', 6: 'Closed',
};

const CHANGE_STATUS: Record<number, string> = {
  1: 'New', 2: 'Evaluation', 3: 'Approval', 4: 'Accepted', 5: 'Pending',
  6: 'Test', 7: 'Qualification', 8: 'Applied', 9: 'Review', 10: 'Closed',
  11: 'Refused', 12: 'Canceled',
};

const VALIDATION_STATUS: Record<number, string> = {
  1: 'Waiting', 2: 'Granted', 3: 'Refused',
};

// Standard Ticket search-option field ids (GLPI ≥ 9.5). Fallbacks; the
// SearchOptions cache is used to resolve friendly names dynamically.
const TICKET_FIELDS = {
  id: 2,
  name: 1,
  status: 12,
  date: 15,
  date_mod: 19,
  solvedate: 17,
  closedate: 16,
  priority: 3,
  urgency: 10,
  impact: 11,
  category: 7,
  entity: 80,
  requester_user: 4,
  technician_user: 5,
  technician_group: 8,
  type: 14,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

function getConfig(): GlpiConfig {
  const url = process.env.GLPI_URL;
  if (!url) throw new Error('GLPI_URL environment variable is required');
  try {
    new URL(url);
  } catch {
    throw new Error(`GLPI_URL is not a valid URL: "${url}"`);
  }

  const userToken = process.env.GLPI_USER_TOKEN;
  const username = process.env.GLPI_USERNAME;
  const password = process.env.GLPI_PASSWORD;
  if (!userToken && !(username && password)) {
    throw new Error(
      'No authentication configured. Set GLPI_USER_TOKEN, or GLPI_USERNAME + GLPI_PASSWORD.'
    );
  }

  return {
    url,
    appToken: process.env.GLPI_APP_TOKEN,
    userToken,
    username,
    password,
    timeoutMs: envInt('GLPI_TIMEOUT_MS'),
    maxRetries: envInt('GLPI_MAX_RETRIES'),
  };
}

/**
 * Parse common list-tool arguments into a ListOptions.
 *
 * Accepts (in order of precedence):
 *   - `range`: "START-END" string passed through as-is
 *   - `start` + `limit`: assembled into range
 *   - `limit` alone: range = "0-{limit-1}" (backward-compat with v2)
 */
function parseListArgs(args: Record<string, unknown> | undefined): ListOptions {
  const opts: ListOptions = {};
  if (!args) return { range: '0-49', expand_dropdowns: true };

  if (typeof args.range === 'string') {
    opts.range = args.range;
  } else if (args.start !== undefined || args.limit !== undefined) {
    const start = (args.start as number) ?? 0;
    const limit = (args.limit as number) ?? 50;
    opts.range = `${start}-${start + limit - 1}`;
  } else {
    opts.range = '0-49';
  }

  if (args.sort !== undefined) opts.sort = args.sort as number;
  if (args.order) opts.order = args.order as 'ASC' | 'DESC';
  if (args.is_deleted !== undefined) opts.is_deleted = args.is_deleted as boolean;
  if (args.include_deleted !== undefined) opts.is_deleted = args.include_deleted as boolean;
  // Default expand_dropdowns to true for human-readable output.
  opts.expand_dropdowns =
    args.expand_dropdowns === false ? false : true;
  return opts;
}

interface CriteriaArg {
  field: number | string;
  searchtype: SearchType;
  value: string | number | boolean;
  link?: SearchLink;
}

async function resolveCriteria(
  client: GlpiClient,
  itemtype: string,
  raw: CriteriaArg[]
): Promise<SearchCriterion[]> {
  return Promise.all(
    raw.map(async (c) => ({
      field: (await client.searchOptions.resolveField(itemtype, c.field)) ??
        (typeof c.field === 'number' ? c.field : 0),
      searchtype: c.searchtype,
      value: c.value,
      link: c.link,
    }))
  );
}

function text(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

function formatTicketSummary(t: any) {
  return {
    id: t.id,
    name: t.name,
    status: TICKET_STATUS[t.status] ?? t.status,
    urgency: TICKET_URGENCY[t.urgency] ?? t.urgency,
    priority: TICKET_URGENCY[t.priority] ?? t.priority,
    date: t.date,
    date_mod: t.date_mod,
    entities_id: t.entities_id,
    itilcategories_id: t.itilcategories_id,
  };
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

/**
 * The GLPI client is process-wide: one GLPI session shared by every MCP
 * connection (one stdio client, or every request to the HTTP endpoint).
 */
let client: GlpiClient;

/**
 * Build an MCP server with every handler registered.
 *
 * A `Server` can be attached to exactly one transport — `Protocol.connect()`
 * throws on the second — so stdio gets one instance and each HTTP POST gets its
 * own. Building an instance is cheap: the handlers below are module-level
 * functions and the tool catalogue is a constant.
 */
function createMcpServer(): Server {
  const server = new Server(
    { name: 'mcp-glpi', version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, handleListTools);
  server.setRequestHandler(CallToolRequestSchema, handleCallTool);
  server.setRequestHandler(ListResourcesRequestSchema, handleListResources);
  server.setRequestHandler(ReadResourceRequestSchema, handleReadResource);

  return server;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const LIST_TOOL_COMMON_PROPS = {
  start: { type: 'number', description: 'Offset (default 0)' },
  limit: { type: 'number', description: 'Max rows in this call (default 50)' },
  range: { type: 'string', description: 'Explicit "START-END" range; overrides start/limit' },
  sort: { type: 'number', description: 'Sort by field id (search option id)' },
  order: { type: 'string', enum: ['ASC', 'DESC'] },
  expand_dropdowns: { type: 'boolean', description: 'Resolve FK ids to labels (default true)' },
};

/** MIME types for glpi_upload_document, keyed by lowercase file extension. */
const UPLOAD_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
};

// ---------------------------------------------------------------------------
// Tool safety annotations (MCP ToolAnnotations)
//
// Derived from the tool name so every current and future tool gets hints:
//   - list/get/search/count/stats  -> readOnlyHint
//   - delete                       -> destructiveHint (data loss possible)
//   - update/set/assign            -> destructiveHint (overwrites existing data)
//   - create/add/link/attach       -> additive write (non-destructive, non-idempotent)
// openWorldHint is false everywhere: tools only reach the configured GLPI.
// ---------------------------------------------------------------------------

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

function toolAnnotations(name: string): ToolAnnotations {
  if (/^glpi_(list_|get_|search|count$|tickets_stats)/.test(name)) {
    return { readOnlyHint: true, openWorldHint: false };
  }
  if (/^glpi_delete_/.test(name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
  if (/^glpi_(update_|set_|assign_)/.test(name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
  // create / add / link / attach: additive writes. Re-running duplicates data.
  return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
}

function annotate<T extends { name: string }>(tool: T): T & { annotations: ToolAnnotations } {
  return { ...tool, annotations: toolAnnotations(tool.name) };
}

/** One entry of the tool catalogue, as `tools/list` reports it. */
type ToolDefinition = ListToolsResult['tools'][number];

const handleListTools = async (): Promise<ListToolsResult> => {
  // Annotating the array keeps `type: 'object'` literal instead of widening to
  // `string`, which the tools/list result type requires.
  const tools: ToolDefinition[] = [
    // ============== READ — TICKETS ==============
    {
      name: 'glpi_list_tickets',
      description: 'List tickets. Supports start/limit/range/sort/order/status filter.',
      inputSchema: {
        type: 'object',
        properties: {
          ...LIST_TOOL_COMMON_PROPS,
          status: { type: 'number', description: '1=New 2=Assigned 3=Planned 4=Pending 5=Solved 6=Closed' },
        },
      },
    },
    {
      name: 'glpi_get_ticket',
      description: 'Get a ticket with status/urgency labels and counts of linked items.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          with_logs: { type: 'boolean' },
        },
        required: ['id'],
      },
    },
    {
      name: 'glpi_get_ticket_timeline',
      description: 'Full chronological timeline of a ticket: followups + tasks + solutions + validations, sorted by date.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
    {
      name: 'glpi_search_tickets',
      description: 'High-level ticket search with friendly params. Use this instead of glpi_search_v2 for tickets.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'number', description: '1..6 (see status reference)' },
          assigned_user_id: { type: 'number' },
          assigned_group_id: { type: 'number' },
          requester_user_id: { type: 'number' },
          category_id: { type: 'number' },
          entity_id: { type: 'number' },
          priority: { type: 'number', description: '1=Very low .. 5=Very high' },
          urgency: { type: 'number', description: '1..5' },
          date_from: { type: 'string', description: 'YYYY-MM-DD HH:MM:SS' },
          date_to: { type: 'string', description: 'YYYY-MM-DD HH:MM:SS' },
          text_search: { type: 'string', description: 'Free text in title' },
          open_only: { type: 'boolean', description: 'Status < 5 only' },
          start: { type: 'number' },
          limit: { type: 'number' },
          fetch_all: { type: 'boolean', description: 'Paginate until totalcount; capped by max_rows (default 1000).' },
          max_rows: { type: 'number' },
          order: { type: 'string', enum: ['ASC', 'DESC'] },
          sort: { type: 'number' },
        },
      },
    },
    {
      name: 'glpi_get_ticket_followups',
      description: 'List followups of a ticket.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number' } }, required: ['ticket_id'] },
    },
    {
      name: 'glpi_get_ticket_tasks',
      description: 'List tasks of a ticket.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number' } }, required: ['ticket_id'] },
    },
    {
      name: 'glpi_get_ticket_solutions',
      description: 'List solutions of a ticket.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number' } }, required: ['ticket_id'] },
    },
    {
      name: 'glpi_get_ticket_validations',
      description: 'List validations (approvals) of a ticket.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number' } }, required: ['ticket_id'] },
    },
    {
      name: 'glpi_get_ticket_documents',
      description: 'List documents (attachments) of a ticket.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number' } }, required: ['ticket_id'] },
    },

    // ============== WRITE — TICKETS ==============
    {
      name: 'glpi_create_ticket',
      description: 'Create a new ticket.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          content: { type: 'string' },
          urgency: { type: 'number' },
          impact: { type: 'number' },
          priority: { type: 'number' },
          type: { type: 'number', description: '1=Incident, 2=Request' },
          category_id: { type: 'number' },
          entity_id: { type: 'number' },
          user_id_assign: { type: 'number' },
          group_id_assign: { type: 'number' },
          requester_user_id: { type: 'number' },
          requester_group_id: { type: 'number' },
          time_to_resolve: { type: 'string' },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'glpi_update_ticket',
      description: 'Update fields of a ticket.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          content: { type: 'string' },
          status: { type: 'number' },
          urgency: { type: 'number' },
          priority: { type: 'number' },
          impact: { type: 'number' },
          itilcategories_id: { type: 'number' },
        },
        required: ['id'],
      },
    },
    {
      name: 'glpi_delete_ticket',
      description: '⚠️ DESTRUCTIVE: delete a ticket. force=true purges (irrecoverable).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' }, force: { type: 'boolean' } },
        required: ['id'],
      },
    },
    {
      name: 'glpi_add_followup',
      description: 'Add a followup comment to a ticket.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number' },
          content: { type: 'string' },
          is_private: { type: 'boolean' },
        },
        required: ['ticket_id', 'content'],
      },
    },
    {
      name: 'glpi_add_task',
      description: 'Add a task (with time tracking) to a ticket.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number' },
          content: { type: 'string' },
          actiontime: { type: 'number' },
          is_private: { type: 'boolean' },
          state: { type: 'number', description: '0=Info 1=Todo 2=Done' },
          users_id_tech: { type: 'number' },
          groups_id_tech: { type: 'number' },
        },
        required: ['ticket_id', 'content'],
      },
    },
    {
      name: 'glpi_add_solution',
      description: 'Add a solution to a ticket.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number' },
          content: { type: 'string' },
          solutiontypes_id: { type: 'number' },
        },
        required: ['ticket_id', 'content'],
      },
    },
    {
      name: 'glpi_assign_ticket',
      description: 'Assign a ticket to a user OR a group. type: 1=requester, 2=assigned, 3=observer.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number' },
          user_id: { type: 'number' },
          group_id: { type: 'number' },
          type: { type: 'number' },
        },
        required: ['ticket_id'],
      },
    },
    {
      name: 'glpi_link_tickets',
      description: 'Link two tickets. link_type: 1=link 2=duplicate 3=parent.',
      inputSchema: {
        type: 'object',
        properties: {
          parent_id: { type: 'number' },
          child_id: { type: 'number' },
          link_type: { type: 'number' },
        },
        required: ['parent_id', 'child_id'],
      },
    },
    {
      name: 'glpi_add_ticket_validation',
      description: 'Request a validation (approval) on a ticket. The chosen user receives the approval request.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number' },
          users_id_validate: { type: 'number', description: 'User asked to validate' },
          comment_submission: { type: 'string' },
        },
        required: ['ticket_id', 'users_id_validate'],
      },
    },
    {
      name: 'glpi_set_validation_status',
      description: 'Approve (2) or refuse (3) an existing TicketValidation. Provide optional comment.',
      inputSchema: {
        type: 'object',
        properties: {
          validation_id: { type: 'number' },
          status: { type: 'number', enum: [2, 3], description: '2=granted, 3=refused' },
          comment_validation: { type: 'string' },
        },
        required: ['validation_id', 'status'],
      },
    },
    {
      name: 'glpi_upload_document',
      description:
        'Upload a local file (by path) as a GLPI Document. If ticket_id is set, the document is also attached to that ticket.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path of the file on the machine running this server',
          },
          name: { type: 'string', description: 'Document title (default: file name)' },
          ticket_id: {
            type: 'number',
            description: 'If set, attach the uploaded document to this ticket',
          },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'glpi_attach_document_to_ticket',
      description: 'Link an existing document (uploaded separately) to a ticket via Document_Item.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number' },
          document_id: { type: 'number' },
        },
        required: ['ticket_id', 'document_id'],
      },
    },
    {
      name: 'glpi_get_ticket_satisfaction',
      description: 'Get satisfaction survey data (score, comment) for a ticket.',
      inputSchema: {
        type: 'object',
        properties: { ticket_id: { type: 'number' } },
        required: ['ticket_id'],
      },
    },
    {
      name: 'glpi_list_overdue_tickets',
      description: 'List tickets whose SLA resolution deadline (time_to_resolve) is in the past and status < 5.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_id: { type: 'number' },
          limit: { type: 'number' },
        },
      },
    },

    // ============== PROBLEMS / CHANGES ==============
    {
      name: 'glpi_list_problems',
      description: 'List problems.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_problem',
      description: 'Get a problem with status label.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_problem',
      description: 'Create a problem.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, content: { type: 'string' },
          urgency: { type: 'number' }, impact: { type: 'number' }, priority: { type: 'number' },
          category_id: { type: 'number' },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'glpi_update_problem',
      description: 'Update a problem.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' }, name: { type: 'string' }, content: { type: 'string' },
          status: { type: 'number' }, urgency: { type: 'number' },
        },
        required: ['id'],
      },
    },
    {
      name: 'glpi_list_changes',
      description: 'List changes.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_change',
      description: 'Get a change with status label.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_change',
      description: 'Create a change.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, content: { type: 'string' },
          urgency: { type: 'number' }, impact: { type: 'number' }, priority: { type: 'number' },
          category_id: { type: 'number' },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'glpi_update_change',
      description: 'Update a change.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' }, name: { type: 'string' }, content: { type: 'string' },
          status: { type: 'number' },
        },
        required: ['id'],
      },
    },

    // ============== ASSETS ==============
    ...[
      'computers', 'softwares', 'network_equipments', 'printers', 'monitors', 'phones',
    ].flatMap((asset): ToolDefinition[] => {
      const singular = asset.replace(/s$/, '');
      return [
        {
          name: `glpi_list_${asset}`,
          description: `List ${asset.replace('_', ' ')}.`,
          inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
        },
        {
          name: `glpi_get_${singular}`,
          description: `Get a ${singular.replace('_', ' ')} by id.`,
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              with_softwares: { type: 'boolean' },
              with_networkports: { type: 'boolean' },
              with_connections: { type: 'boolean' },
              with_documents: { type: 'boolean' },
            },
            required: ['id'],
          },
        },
      ];
    }),
    {
      name: 'glpi_create_computer',
      description: 'Add a computer to inventory.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          serial: { type: 'string' }, otherserial: { type: 'string' },
          contact: { type: 'string' }, comment: { type: 'string' },
          locations_id: { type: 'number' }, states_id: { type: 'number' },
          computertypes_id: { type: 'number' }, manufacturers_id: { type: 'number' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_update_computer',
      description: 'Update a computer.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' }, name: { type: 'string' }, serial: { type: 'string' },
          comment: { type: 'string' }, locations_id: { type: 'number' }, states_id: { type: 'number' },
        },
        required: ['id'],
      },
    },
    {
      name: 'glpi_delete_computer',
      description: '⚠️ DESTRUCTIVE: delete a computer. force=true purges.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' }, force: { type: 'boolean' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_software',
      description: 'Add software.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, comment: { type: 'string' },
          manufacturers_id: { type: 'number' }, softwarecategories_id: { type: 'number' },
        },
        required: ['name'],
      },
    },

    // ============== KB / CONTRACTS / SUPPLIERS / LOCATIONS / PROJECTS ==============
    {
      name: 'glpi_list_knowbase',
      description: 'List KB articles.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_knowbase_item',
      description: 'Get a KB article.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_search_knowbase',
      description: 'Search KB articles by free text in title (field id resolved dynamically).',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      },
    },
    {
      name: 'glpi_create_knowbase_item',
      description: 'Create a KB article.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, answer: { type: 'string' },
          is_faq: { type: 'boolean' }, knowbaseitemcategories_id: { type: 'number' },
        },
        required: ['name', 'answer'],
      },
    },
    {
      name: 'glpi_list_contracts',
      description: 'List contracts.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_contract',
      description: 'Get a contract.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_contract',
      description: 'Create a contract.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, num: { type: 'string' },
          begin_date: { type: 'string' }, duration: { type: 'number' },
          notice: { type: 'number' }, comment: { type: 'string' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_list_suppliers',
      description: 'List suppliers.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_supplier',
      description: 'Get a supplier.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_supplier',
      description: 'Create a supplier.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, address: { type: 'string' }, postcode: { type: 'string' },
          town: { type: 'string' }, country: { type: 'string' }, website: { type: 'string' },
          phonenumber: { type: 'string' }, email: { type: 'string' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_list_locations',
      description: 'List locations.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_location',
      description: 'Get a location.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_location',
      description: 'Create a location.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, address: { type: 'string' }, postcode: { type: 'string' },
          town: { type: 'string' }, building: { type: 'string' }, room: { type: 'string' },
          locations_id: { type: 'number' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_list_projects',
      description: 'List projects.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_project',
      description: 'Get a project.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_project',
      description: 'Create a project.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, code: { type: 'string' }, content: { type: 'string' },
          priority: { type: 'number' }, plan_start_date: { type: 'string' },
          plan_end_date: { type: 'string' }, users_id: { type: 'number' }, groups_id: { type: 'number' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_update_project',
      description: 'Update a project (progress, dates, content).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' }, name: { type: 'string' }, content: { type: 'string' },
          percent_done: { type: 'number' },
          real_start_date: { type: 'string' }, real_end_date: { type: 'string' },
        },
        required: ['id'],
      },
    },

    // ============== USERS / GROUPS / CATEGORIES / ENTITIES / DOCUMENTS ==============
    {
      name: 'glpi_list_users',
      description: 'List users. active_only defaults to true (uses search criteria, not searchText).',
      inputSchema: {
        type: 'object',
        properties: { ...LIST_TOOL_COMMON_PROPS, active_only: { type: 'boolean' } },
      },
    },
    {
      name: 'glpi_get_user',
      description: 'Get a user.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_search_user',
      description: 'Search a user by login name (exact "contains" on name field).',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    {
      name: 'glpi_create_user',
      description: 'Create a user.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, password: { type: 'string' },
          realname: { type: 'string' }, firstname: { type: 'string' },
          email: { type: 'string' }, phone: { type: 'string' }, profiles_id: { type: 'number' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_list_groups',
      description: 'List groups.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_group',
      description: 'Get a group.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_group',
      description: 'Create a group.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, comment: { type: 'string' },
          is_requester: { type: 'boolean' }, is_assign: { type: 'boolean' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_add_user_to_group',
      description: 'Add a user to a group.',
      inputSchema: {
        type: 'object',
        properties: { user_id: { type: 'number' }, group_id: { type: 'number' }, is_manager: { type: 'boolean' } },
        required: ['user_id', 'group_id'],
      },
    },
    {
      name: 'glpi_list_categories',
      description: 'List ticket categories.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_list_entities',
      description: 'List entities.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_entity',
      description: 'Get an entity.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_list_documents',
      description: 'List documents.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_document',
      description: 'Get a document.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },

    // ============== STATS ==============
    {
      name: 'glpi_get_ticket_stats',
      description: 'Ticket counts by status. Optional filters: entity, date_from, date_to.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_id: { type: 'number' },
          date_from: { type: 'string', description: 'YYYY-MM-DD' },
          date_to: { type: 'string', description: 'YYYY-MM-DD' },
        },
      },
    },
    {
      name: 'glpi_get_asset_stats',
      description: 'Total counts per asset type (Computer/Monitor/Printer/NetworkEquipment/Phone/Software).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'glpi_tickets_stats_by',
      description: 'Ticket count broken down by a dimension (status / category / technician / entity / month). Optional period filter.',
      inputSchema: {
        type: 'object',
        properties: {
          dimension: {
            type: 'string',
            enum: ['status', 'category', 'technician', 'entity', 'month'],
          },
          date_from: { type: 'string' },
          date_to: { type: 'string' },
          entity_id: { type: 'number' },
        },
        required: ['dimension'],
      },
    },

    // ============== SESSION ==============
    {
      name: 'glpi_get_session_info',
      description: 'Active profile + available profiles + entities.',
      inputSchema: { type: 'object', properties: {} },
    },

    // ============== GENERIC SEARCH / COUNT ==============
    {
      name: 'glpi_search_v2',
      description: 'Multi-criteria search. Use criteria[]: {field, searchtype, value, link}. Supports forcedisplay, sort, order, start/limit, fetch_all.',
      inputSchema: {
        type: 'object',
        properties: {
          itemtype: { type: 'string' },
          criteria: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { description: 'field_id (number) OR friendly name resolved via listSearchOptions' },
                searchtype: {
                  type: 'string',
                  enum: ['contains', 'notcontains', 'equals', 'notequals', 'lessthan', 'morethan', 'under', 'notunder', 'empty', 'notempty'],
                },
                value: {},
                link: { type: 'string', enum: ['AND', 'OR', 'AND NOT', 'OR NOT'] },
              },
              required: ['field', 'searchtype', 'value'],
            },
          },
          forcedisplay: { type: 'array', items: { type: 'number' } },
          start: { type: 'number' },
          limit: { type: 'number' },
          sort: { type: 'number' },
          order: { type: 'string', enum: ['ASC', 'DESC'] },
          fetch_all: { type: 'boolean' },
          max_rows: { type: 'number' },
          expand_dropdowns: { type: 'boolean' },
        },
        required: ['itemtype'],
      },
    },
    {
      name: 'glpi_count',
      description: 'Return totalcount for an itemtype + criteria (cheap range=0-0 probe).',
      inputSchema: {
        type: 'object',
        properties: {
          itemtype: { type: 'string' },
          criteria: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: {},
                searchtype: { type: 'string' },
                value: {},
                link: { type: 'string' },
              },
              required: ['field', 'searchtype', 'value'],
            },
          },
        },
        required: ['itemtype'],
      },
    },
    {
      name: 'glpi_list_search_options',
      description: 'Discover the searchable fields of an itemtype (returns field_id → name/uid/datatype). Useful to build criteria for glpi_search_v2.',
      inputSchema: {
        type: 'object',
        properties: { itemtype: { type: 'string' } },
        required: ['itemtype'],
      },
    },

    // ============== legacy compat: keep glpi_search (mono-criterion) as deprecated alias ==============
    {
      name: 'glpi_search',
      description: '[DEPRECATED — prefer glpi_search_v2] Single-criterion search (kept for backward compat).',
      inputSchema: {
        type: 'object',
        properties: {
          itemtype: { type: 'string' },
          field: { type: 'number' },
          searchtype: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['itemtype', 'field', 'searchtype', 'value'],
      },
    },
  ];

  return { tools: tools.map(annotate) };
};

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

const handleCallTool = async (request: CallToolRequest): Promise<CallToolResult> => {
  const { name, arguments: argsRaw } = request.params;
  const args = (argsRaw ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      // ==== TICKETS — read ====
      case 'glpi_list_tickets': {
        const validated = listArgsSchema.parse(args);
        const opts = parseListArgs(validated);
        let tickets = await client.getTickets({ ...opts, order: opts.order ?? 'DESC' });
        if (typeof validated.status === 'number') {
          tickets = tickets.filter((t: any) => t.status === validated.status);
        }
        return text(tickets.map(formatTicketSummary));
      }

      case 'glpi_get_ticket': {
        const validated = ticketReadSchema.parse(args);
        const { id, with_logs } = validated;
        const [ticket, followups, tasks, solutions] = await Promise.all([
          client.getTicket(id, { with_logs }),
          client.getTicketFollowups(id),
          client.getTicketTasks(id),
          client.getTicketSolutions(id),
        ]);
        return text({
          ...ticket,
          status_label: TICKET_STATUS[(ticket as any).status],
          urgency_label: TICKET_URGENCY[(ticket as any).urgency],
          priority_label: TICKET_URGENCY[(ticket as any).priority],
          counts: {
            followups: followups.length,
            tasks: tasks.length,
            solutions: solutions.length,
          },
        });
      }

      case 'glpi_get_ticket_timeline': {
        const id = args.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'id required');
        const [followups, tasks, solutions, validations] = await Promise.all([
          client.getTicketFollowups(id),
          client.getTicketTasks(id),
          client.getTicketSolutions(id),
          client.getTicketValidations(id),
        ]);
        const timeline = [
          ...followups.map((f: any) => ({ kind: 'followup', date: f.date_creation ?? f.date, ...f })),
          ...tasks.map((t: any) => ({ kind: 'task', date: t.date_creation ?? t.date, ...t })),
          ...solutions.map((s: any) => ({ kind: 'solution', date: s.date_creation ?? s.date, ...s })),
          ...validations.map((v: any) => ({
            kind: 'validation',
            date: v.submission_date ?? v.date_creation ?? v.date,
            status_label: VALIDATION_STATUS[v.status] ?? v.status,
            ...v,
          })),
        ].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
        return text({ ticket_id: id, count: timeline.length, timeline });
      }

      case 'glpi_search_tickets': {
        ticketSearchSchema.parse(args);
        const criteria: SearchCriterion[] = [];
        const push = (c: SearchCriterion) => {
          if (criteria.length > 0 && !c.link) c.link = 'AND';
          criteria.push(c);
        };
        if (args.status !== undefined) push({ field: TICKET_FIELDS.status, searchtype: 'equals', value: args.status as number });
        if (args.assigned_user_id !== undefined) push({ field: TICKET_FIELDS.technician_user, searchtype: 'equals', value: args.assigned_user_id as number });
        if (args.assigned_group_id !== undefined) push({ field: TICKET_FIELDS.technician_group, searchtype: 'equals', value: args.assigned_group_id as number });
        if (args.requester_user_id !== undefined) push({ field: TICKET_FIELDS.requester_user, searchtype: 'equals', value: args.requester_user_id as number });
        if (args.category_id !== undefined) push({ field: TICKET_FIELDS.category, searchtype: 'equals', value: args.category_id as number });
        if (args.entity_id !== undefined) push({ field: TICKET_FIELDS.entity, searchtype: 'equals', value: args.entity_id as number });
        if (args.priority !== undefined) push({ field: TICKET_FIELDS.priority, searchtype: 'equals', value: args.priority as number });
        if (args.urgency !== undefined) push({ field: TICKET_FIELDS.urgency, searchtype: 'equals', value: args.urgency as number });
        if (args.date_from) push({ field: TICKET_FIELDS.date, searchtype: 'morethan', value: args.date_from as string });
        if (args.date_to) push({ field: TICKET_FIELDS.date, searchtype: 'lessthan', value: args.date_to as string });
        if (args.text_search) push({ field: TICKET_FIELDS.name, searchtype: 'contains', value: args.text_search as string });
        if (args.open_only) push({ field: TICKET_FIELDS.status, searchtype: 'lessthan', value: 5 });

        const result = await client.search.search('Ticket', {
          criteria,
          start: (args.start as number) ?? 0,
          limit: (args.limit as number) ?? 50,
          fetchAll: args.fetch_all as boolean,
          maxRows: args.max_rows as number,
          sort: args.sort as number,
          order: (args.order as 'ASC' | 'DESC') ?? 'DESC',
          expandDropdowns: true,
        });

        return text({
          totalcount: result.totalcount,
          count: result.count,
          data: result.data,
        });
      }

      case 'glpi_get_ticket_followups': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketFollowups(id));
      }
      case 'glpi_get_ticket_tasks': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketTasks(id));
      }
      case 'glpi_get_ticket_solutions': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketSolutions(id));
      }
      case 'glpi_get_ticket_validations': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketValidations(id));
      }
      case 'glpi_get_ticket_documents': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketDocuments(id));
      }

      // ==== TICKETS — write ====
      case 'glpi_create_ticket': {
        const name = args.name as string;
        const content = args.content as string;
        if (!name || !content) throw new McpError(ErrorCode.InvalidParams, 'name and content required');
        const result = await client.createTicket({
          name,
          content,
          urgency: (args.urgency as number) ?? 3,
          impact: args.impact as number,
          priority: args.priority as number,
          type: (args.type as number) ?? 1,
          itilcategories_id: args.category_id as number,
          entities_id: args.entity_id as number,
          _users_id_assign: args.user_id_assign as number,
          _groups_id_assign: args.group_id_assign as number,
          _users_id_requester: args.requester_user_id as number,
          _groups_id_requester: args.requester_group_id as number,
          time_to_resolve: args.time_to_resolve as string,
        });
        return text({ success: true, ...result });
      }

      case 'glpi_update_ticket': {
        const id = args.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'id required');
        const updates: Record<string, unknown> = {};
        ['name', 'content', 'status', 'urgency', 'priority', 'impact', 'itilcategories_id'].forEach((k) => {
          if (args[k] !== undefined) updates[k] = args[k];
        });
        await client.updateTicket(id, updates as any);
        return text({ success: true, id });
      }

      case 'glpi_delete_ticket': {
        const id = args.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'id required');
        await client.deleteTicket(id, args.force as boolean);
        return text({ success: true, id, purged: !!args.force });
      }

      case 'glpi_add_followup': {
        const ticket_id = args.ticket_id as number;
        const content = args.content as string;
        if (!ticket_id || !content) throw new McpError(ErrorCode.InvalidParams, 'ticket_id and content required');
        const result = await client.addTicketFollowup(ticket_id, content, args.is_private as boolean);
        return text({ success: true, followup_id: result.id });
      }

      case 'glpi_add_task': {
        const ticket_id = args.ticket_id as number;
        const content = args.content as string;
        if (!ticket_id || !content) throw new McpError(ErrorCode.InvalidParams, 'ticket_id and content required');
        const result = await client.addTicketTask(ticket_id, content, {
          is_private: args.is_private as boolean,
          actiontime: args.actiontime as number,
          state: args.state as number,
          users_id_tech: args.users_id_tech as number,
          groups_id_tech: args.groups_id_tech as number,
        });
        return text({ success: true, task_id: result.id });
      }

      case 'glpi_add_solution': {
        const ticket_id = args.ticket_id as number;
        const content = args.content as string;
        if (!ticket_id || !content) throw new McpError(ErrorCode.InvalidParams, 'ticket_id and content required');
        const result = await client.addTicketSolution(ticket_id, content, args.solutiontypes_id as number);
        return text({ success: true, solution_id: result.id });
      }

      case 'glpi_assign_ticket': {
        const ticket_id = args.ticket_id as number;
        if (!ticket_id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        const user_id = args.user_id as number;
        const group_id = args.group_id as number;
        if (!user_id && !group_id) {
          throw new McpError(ErrorCode.InvalidParams, 'user_id or group_id required');
        }
        const result = await client.assignTicket(ticket_id, {
          users_id: user_id,
          groups_id: group_id,
          type: args.type as number,
        });
        return text({ success: true, assignment_id: result.id });
      }

      case 'glpi_link_tickets': {
        const parent_id = args.parent_id as number;
        const child_id = args.child_id as number;
        if (!parent_id || !child_id) throw new McpError(ErrorCode.InvalidParams, 'parent_id and child_id required');
        const result = await client.linkTickets(parent_id, child_id, (args.link_type as number) ?? 1);
        return text({ success: true, link_id: result.id });
      }

      case 'glpi_add_ticket_validation': {
        const ticket_id = args.ticket_id as number;
        const users_id_validate = args.users_id_validate as number;
        if (!ticket_id || !users_id_validate) {
          throw new McpError(ErrorCode.InvalidParams, 'ticket_id and users_id_validate required');
        }
        const result = await client.addTicketValidation(ticket_id, {
          users_id_validate,
          comment_submission: args.comment_submission as string,
        });
        return text({ success: true, validation_id: result.id });
      }

      case 'glpi_set_validation_status': {
        const validation_id = args.validation_id as number;
        const status = args.status as 2 | 3;
        if (!validation_id || (status !== 2 && status !== 3)) {
          throw new McpError(ErrorCode.InvalidParams, 'validation_id and status (2 or 3) required');
        }
        await client.setTicketValidationStatus(
          validation_id,
          status,
          args.comment_validation as string
        );
        return text({ success: true, validation_id, status_label: VALIDATION_STATUS[status] });
      }

      case 'glpi_upload_document': {
        const filePath = args.file_path as string;
        if (!filePath) throw new McpError(ErrorCode.InvalidParams, 'file_path required');
        let data: Uint8Array;
        try {
          data = await readFile(filePath);
        } catch (err) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `cannot read file "${filePath}": ${err instanceof Error ? err.message : err}`
          );
        }
        const filename = basename(filePath);
        const ticket_id = args.ticket_id as number | undefined;
        // Linking via the manifest (itemtype/items_id) lets GLPI create the
        // Document_Item itself, which also works for restricted profiles that
        // cannot POST Document_Item directly.
        const document = await client.uploadDocument({
          filename,
          data,
          name: args.name as string | undefined,
          mimeType: UPLOAD_MIME_TYPES[extname(filename).toLowerCase()],
          ...(ticket_id ? { itemtype: 'Ticket', items_id: ticket_id } : {}),
        });
        return text({ success: true, document_id: document.id, ...(ticket_id ? { ticket_id } : {}) });
      }

      case 'glpi_attach_document_to_ticket': {
        const ticket_id = args.ticket_id as number;
        const document_id = args.document_id as number;
        if (!ticket_id || !document_id) {
          throw new McpError(ErrorCode.InvalidParams, 'ticket_id and document_id required');
        }
        const result = await client.attachDocumentToTicket(ticket_id, document_id);
        return text({ success: true, link_id: result.id });
      }

      case 'glpi_get_ticket_satisfaction': {
        const ticket_id = args.ticket_id as number;
        if (!ticket_id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketSatisfaction(ticket_id));
      }

      case 'glpi_list_overdue_tickets': {
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const criteria: SearchCriterion[] = [
          { field: TICKET_FIELDS.status, searchtype: 'lessthan', value: 5 },
          // time_to_resolve search-option id is typically 18; fall back to 18.
          { field: 18, searchtype: 'lessthan', value: now, link: 'AND' },
          { field: 18, searchtype: 'notempty', value: '', link: 'AND' },
        ];
        if (args.entity_id !== undefined) {
          criteria.push({ field: TICKET_FIELDS.entity, searchtype: 'equals', value: args.entity_id as number, link: 'AND' });
        }
        const result = await client.search.search('Ticket', {
          criteria,
          limit: (args.limit as number) ?? 50,
          expandDropdowns: true,
          order: 'ASC',
          sort: 18,
        });
        return text({
          totalcount: result.totalcount,
          count: result.count,
          data: result.data,
        });
      }

      // ==== PROBLEMS / CHANGES ====
      case 'glpi_list_problems': {
        const list = await client.getProblems({ ...parseListArgs(args), order: 'DESC' });
        return text(list.map((p: any) => ({
          id: p.id, name: p.name,
          status: PROBLEM_STATUS[p.status] ?? p.status,
          urgency: TICKET_URGENCY[p.urgency] ?? p.urgency,
          date: p.date,
        })));
      }
      case 'glpi_get_problem': {
        const id = args.id as number;
        const p = await client.getProblem(id);
        return text({
          ...p,
          status_label: PROBLEM_STATUS[(p as any).status],
          urgency_label: TICKET_URGENCY[(p as any).urgency],
        });
      }
      case 'glpi_create_problem': {
        const result = await client.createProblem({
          name: args.name as string,
          content: args.content as string,
          urgency: args.urgency as number,
          impact: args.impact as number,
          priority: args.priority as number,
          itilcategories_id: args.category_id as number,
        });
        return text({ success: true, ...result });
      }
      case 'glpi_update_problem': {
        const id = args.id as number;
        const updates: Record<string, unknown> = {};
        ['name', 'content', 'status', 'urgency'].forEach((k) => {
          if (args[k] !== undefined) updates[k] = args[k];
        });
        await client.updateProblem(id, updates as any);
        return text({ success: true, id });
      }

      case 'glpi_list_changes': {
        const list = await client.getChanges({ ...parseListArgs(args), order: 'DESC' });
        return text(list.map((c: any) => ({
          id: c.id, name: c.name,
          status: CHANGE_STATUS[c.status] ?? c.status,
          urgency: TICKET_URGENCY[c.urgency] ?? c.urgency,
          date: c.date,
        })));
      }
      case 'glpi_get_change': {
        const id = args.id as number;
        const c = await client.getChange(id);
        return text({
          ...c,
          status_label: CHANGE_STATUS[(c as any).status],
          urgency_label: TICKET_URGENCY[(c as any).urgency],
        });
      }
      case 'glpi_create_change': {
        const result = await client.createChange({
          name: args.name as string,
          content: args.content as string,
          urgency: args.urgency as number,
          impact: args.impact as number,
          priority: args.priority as number,
          itilcategories_id: args.category_id as number,
        });
        return text({ success: true, ...result });
      }
      case 'glpi_update_change': {
        const id = args.id as number;
        const updates: Record<string, unknown> = {};
        ['name', 'content', 'status'].forEach((k) => {
          if (args[k] !== undefined) updates[k] = args[k];
        });
        await client.updateChange(id, updates as any);
        return text({ success: true, id });
      }

      // ==== ASSETS ====
      case 'glpi_list_computers':
        return text(await client.getComputers(parseListArgs(args)));
      case 'glpi_get_computer':
        return text(await client.getComputer(args.id as number, {
          with_softwares: args.with_softwares as boolean,
          with_connections: args.with_connections as boolean,
          with_networkports: args.with_networkports as boolean,
          with_documents: args.with_documents as boolean,
        }));
      case 'glpi_create_computer':
        return text({ success: true, ...(await client.createComputer(args)) });
      case 'glpi_update_computer': {
        const id = args.id as number;
        const updates = { ...args }; delete (updates as any).id;
        await client.updateComputer(id, updates as any);
        return text({ success: true, id });
      }
      case 'glpi_delete_computer':
        await client.deleteComputer(args.id as number, args.force as boolean);
        return text({ success: true, id: args.id, purged: !!args.force });

      case 'glpi_list_softwares':
        return text(await client.getSoftwares(parseListArgs(args)));
      case 'glpi_get_software':
        return text(await client.getSoftware(args.id as number));
      case 'glpi_create_software':
        return text({ success: true, ...(await client.createSoftware(args)) });

      case 'glpi_list_network_equipments':
        return text(await client.getNetworkEquipments(parseListArgs(args)));
      case 'glpi_get_network_equipment':
        return text(await client.getNetworkEquipment(args.id as number, {
          with_networkports: args.with_networkports as boolean,
        }));

      case 'glpi_list_printers':
        return text(await client.getPrinters(parseListArgs(args)));
      case 'glpi_get_printer':
        return text(await client.getPrinter(args.id as number));

      case 'glpi_list_monitors':
        return text(await client.getMonitors(parseListArgs(args)));
      case 'glpi_get_monitor':
        return text(await client.getMonitor(args.id as number));

      case 'glpi_list_phones':
        return text(await client.getPhones(parseListArgs(args)));
      case 'glpi_get_phone':
        return text(await client.getPhone(args.id as number));

      // ==== KB / CONTRACTS / SUPPLIERS / LOCATIONS / PROJECTS ====
      case 'glpi_list_knowbase':
        return text(await client.getKnowbaseItems(parseListArgs(args)));
      case 'glpi_get_knowbase_item':
        return text(await client.getKnowbaseItem(args.id as number));
      case 'glpi_search_knowbase':
        return text(await client.searchKnowbase(args.query as string, (args.limit as number) ?? 50));
      case 'glpi_create_knowbase_item': {
        const result = await client.createKnowbaseItem({
          name: args.name as string,
          answer: args.answer as string,
          is_faq: args.is_faq ? 1 : 0,
          knowbaseitemcategories_id: args.knowbaseitemcategories_id as number,
        });
        return text({ success: true, ...result });
      }

      case 'glpi_list_contracts':
        return text(await client.getContracts(parseListArgs(args)));
      case 'glpi_get_contract':
        return text(await client.getContract(args.id as number));
      case 'glpi_create_contract':
        return text({ success: true, ...(await client.createContract(args)) });

      case 'glpi_list_suppliers':
        return text(await client.getSuppliers(parseListArgs(args)));
      case 'glpi_get_supplier':
        return text(await client.getSupplier(args.id as number));
      case 'glpi_create_supplier':
        return text({ success: true, ...(await client.createSupplier(args)) });

      case 'glpi_list_locations':
        return text(await client.getLocations(parseListArgs(args)));
      case 'glpi_get_location':
        return text(await client.getLocation(args.id as number));
      case 'glpi_create_location':
        return text({ success: true, ...(await client.createLocation(args)) });

      case 'glpi_list_projects':
        return text(await client.getProjects(parseListArgs(args)));
      case 'glpi_get_project':
        return text(await client.getProject(args.id as number));
      case 'glpi_create_project':
        return text({ success: true, ...(await client.createProject(args)) });
      case 'glpi_update_project': {
        const id = args.id as number;
        const updates: Record<string, unknown> = {};
        ['name', 'content', 'percent_done', 'real_start_date', 'real_end_date'].forEach((k) => {
          if (args[k] !== undefined) updates[k] = args[k];
        });
        await client.updateProject(id, updates as any);
        return text({ success: true, id });
      }

      // ==== USERS / GROUPS ====
      case 'glpi_list_users':
        return text(await client.getUsers({
          ...parseListArgs(args),
          is_active: args.active_only === false ? false : true,
        }));
      case 'glpi_get_user':
        return text(await client.getUser(args.id as number));
      case 'glpi_search_user':
        return text(await client.getUserByName(args.name as string));
      case 'glpi_create_user':
        return text({ success: true, ...(await client.createUser({
          name: args.name as string,
          password: args.password as string,
          realname: args.realname as string,
          firstname: args.firstname as string,
          email: args.email as string,
          phone: args.phone as string,
          profiles_id: args.profiles_id as number,
        })) });

      case 'glpi_list_groups':
        return text(await client.getGroups(parseListArgs(args)));
      case 'glpi_get_group':
        return text(await client.getGroup(args.id as number));
      case 'glpi_create_group':
        return text({ success: true, ...(await client.createGroup({
          name: args.name as string,
          comment: args.comment as string,
          is_requester: args.is_requester ? 1 : 0,
          is_assign: args.is_assign ? 1 : 0,
        })) });
      case 'glpi_add_user_to_group':
        return text({ success: true, ...(await client.addUserToGroup(
          args.user_id as number,
          args.group_id as number,
          args.is_manager as boolean
        )) });

      case 'glpi_list_categories':
        return text(await client.getCategories(parseListArgs(args)));
      case 'glpi_list_entities':
        return text(await client.getEntities(parseListArgs(args)));
      case 'glpi_get_entity':
        return text(await client.getEntity(args.id as number));
      case 'glpi_list_documents':
        return text(await client.getDocuments(parseListArgs(args)));
      case 'glpi_get_document':
        return text(await client.getDocument(args.id as number));

      // ==== STATS ====
      case 'glpi_get_ticket_stats': {
        const stats = await client.getTicketStats({
          entity_id: args.entity_id as number,
          date_from: args.date_from as string,
          date_to: args.date_to as string,
        });
        return text({
          ...stats,
          summary: `${stats.total} tickets — new:${stats.new} processing:${stats.processing} pending:${stats.pending} solved:${stats.solved} closed:${stats.closed}`,
        });
      }

      case 'glpi_get_asset_stats': {
        const stats = await client.getAssetStats();
        return text({ ...stats, total: stats.computers + stats.monitors + stats.printers + stats.networkEquipments + stats.phones });
      }

      case 'glpi_tickets_stats_by': {
        const dimension = args.dimension as 'status' | 'category' | 'technician' | 'entity' | 'month';
        const base: SearchCriterion[] = [];
        if (args.entity_id !== undefined) base.push({ field: TICKET_FIELDS.entity, searchtype: 'equals', value: args.entity_id as number });
        if (args.date_from) base.push({ field: TICKET_FIELDS.date, searchtype: 'morethan', value: args.date_from as string, link: 'AND' });
        if (args.date_to) base.push({ field: TICKET_FIELDS.date, searchtype: 'lessthan', value: args.date_to as string, link: 'AND' });

        const counts: Record<string, number> = {};

        if (dimension === 'status') {
          for (const [statusId, label] of Object.entries(TICKET_STATUS)) {
            const c: SearchCriterion[] = [
              { field: TICKET_FIELDS.status, searchtype: 'equals', value: Number(statusId) },
              ...base.map((b, i) => ({ ...b, link: 'AND' as const })),
            ];
            counts[label] = await client.search.count('Ticket', c);
          }
        } else if (dimension === 'category') {
          const cats = await client.getCategories({ range: '0-199' });
          for (const cat of cats as any[]) {
            const c: SearchCriterion[] = [
              { field: TICKET_FIELDS.category, searchtype: 'equals', value: cat.id },
              ...base.map((b) => ({ ...b, link: 'AND' as const })),
            ];
            const n = await client.search.count('Ticket', c);
            if (n > 0) counts[cat.completename ?? cat.name] = n;
          }
        } else if (dimension === 'technician') {
          const users = await client.getUsers({ range: '0-199', is_active: true });
          for (const u of users) {
            const c: SearchCriterion[] = [
              { field: TICKET_FIELDS.technician_user, searchtype: 'equals', value: u.id },
              ...base.map((b) => ({ ...b, link: 'AND' as const })),
            ];
            const n = await client.search.count('Ticket', c);
            if (n > 0) counts[`${u.firstname ?? ''} ${u.realname ?? ''} (${u.name})`.trim()] = n;
          }
        } else if (dimension === 'entity') {
          const entities = await client.getEntities({ range: '0-99' });
          for (const e of entities as any[]) {
            const c: SearchCriterion[] = [
              { field: TICKET_FIELDS.entity, searchtype: 'equals', value: e.id },
              ...base.map((b) => ({ ...b, link: 'AND' as const })),
            ];
            const n = await client.search.count('Ticket', c);
            if (n > 0) counts[e.completename ?? e.name] = n;
          }
        } else if (dimension === 'month') {
          // Compute monthly buckets between date_from and date_to (or last 6 months).
          const to = args.date_to ? new Date(args.date_to as string) : new Date();
          const from = args.date_from ? new Date(args.date_from as string) : new Date(to.getFullYear(), to.getMonth() - 5, 1);
          const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
          while (cursor <= to) {
            const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
            const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
            const fmt = (d: Date) => d.toISOString().slice(0, 10) + ' 00:00:00';
            const monthCriteria: SearchCriterion[] = [
              { field: TICKET_FIELDS.date, searchtype: 'morethan', value: fmt(monthStart) },
              { field: TICKET_FIELDS.date, searchtype: 'lessthan', value: fmt(monthEnd), link: 'AND' },
            ];
            if (args.entity_id !== undefined) {
              monthCriteria.push({ field: TICKET_FIELDS.entity, searchtype: 'equals', value: args.entity_id as number, link: 'AND' });
            }
            const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
            counts[key] = await client.search.count('Ticket', monthCriteria);
            cursor.setMonth(cursor.getMonth() + 1);
          }
        } else {
          throw new McpError(ErrorCode.InvalidParams, `Unknown dimension: ${dimension}`);
        }

        return text({ dimension, counts, total: Object.values(counts).reduce((s, n) => s + n, 0) });
      }

      // ==== SESSION ====
      case 'glpi_get_session_info': {
        const [profile, profiles, entities] = await Promise.all([
          client.getActiveProfile(),
          client.getMyProfiles(),
          client.getMyEntities(),
        ]);
        return text({ active_profile: profile, available_profiles: profiles, entities });
      }

      // ==== SEARCH ====
      case 'glpi_search_v2': {
        const itemtype = args.itemtype as string;
        if (!itemtype) throw new McpError(ErrorCode.InvalidParams, 'itemtype required');
        const rawCriteria = (args.criteria as CriteriaArg[]) ?? [];
        const criteria = await resolveCriteria(client, itemtype, rawCriteria);
        const result = await client.search.search(itemtype, {
          criteria,
          forcedisplay: args.forcedisplay as number[],
          start: args.start as number,
          limit: args.limit as number,
          sort: args.sort as number,
          order: args.order as 'ASC' | 'DESC',
          fetchAll: args.fetch_all as boolean,
          maxRows: args.max_rows as number,
          expandDropdowns: args.expand_dropdowns !== false,
        });
        return text(result);
      }

      case 'glpi_count': {
        const itemtype = args.itemtype as string;
        if (!itemtype) throw new McpError(ErrorCode.InvalidParams, 'itemtype required');
        const rawCriteria = (args.criteria as CriteriaArg[]) ?? [];
        const criteria = await resolveCriteria(client, itemtype, rawCriteria);
        const totalcount = await client.search.count(itemtype, criteria);
        return text({ itemtype, totalcount });
      }

      case 'glpi_list_search_options': {
        const itemtype = args.itemtype as string;
        if (!itemtype) throw new McpError(ErrorCode.InvalidParams, 'itemtype required');
        const cat = await client.searchOptions.get(itemtype);
        const entries = Array.from(cat.byId.values()).map((o) => ({
          id: o.id, name: o.name, uid: o.uid, table: o.table,
          field: o.field, datatype: o.datatype,
          available_searchtypes: o.available_searchtypes,
        }));
        return text({ itemtype, count: entries.length, options: entries });
      }

      // legacy
      case 'glpi_search': {
        const itemtype = args.itemtype as string;
        const field = args.field as number;
        const searchtype = args.searchtype as SearchType;
        const value = args.value as string;
        if (!itemtype || field === undefined || !searchtype || value === undefined) {
          throw new McpError(ErrorCode.InvalidParams, 'itemtype, field, searchtype, value required');
        }
        const result = await client.search.search(itemtype, {
          criteria: [{ field, searchtype, value }],
          expandDropdowns: true,
        });
        return text(result);
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${name}: ${issues}`);
    }
    if (error instanceof GlpiError) {
      const detail = error.glpiCode
        ? `${error.glpiCode}${error.glpiMessage ? ' — ' + error.glpiMessage : ''}`
        : error.message;
      throw new McpError(
        ErrorCode.InternalError,
        `GLPI API error on ${name} (HTTP ${error.status}): ${detail}`
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

const handleListResources = async (): Promise<ListResourcesResult> => ({
  resources: [
    { uri: 'glpi://tickets/open', name: 'Open Tickets', description: 'Tickets with status < 5', mimeType: 'application/json' },
    { uri: 'glpi://tickets/recent', name: 'Recent Tickets', description: 'Most recent tickets', mimeType: 'application/json' },
    { uri: 'glpi://problems/open', name: 'Open Problems', description: 'Open problems', mimeType: 'application/json' },
    { uri: 'glpi://changes/pending', name: 'Pending Changes', description: 'Pending changes', mimeType: 'application/json' },
    { uri: 'glpi://computers', name: 'Computers', description: 'Computers', mimeType: 'application/json' },
    { uri: 'glpi://groups', name: 'Groups', description: 'Groups', mimeType: 'application/json' },
    { uri: 'glpi://categories', name: 'Categories', description: 'ITIL categories', mimeType: 'application/json' },
    { uri: 'glpi://stats/tickets', name: 'Ticket Statistics', description: 'Ticket counts', mimeType: 'application/json' },
    { uri: 'glpi://stats/assets', name: 'Asset Statistics', description: 'Asset counts', mimeType: 'application/json' },
  ],
});

const handleReadResource = async (request: ReadResourceRequest): Promise<ReadResourceResult> => {
  const { uri } = request.params;
  try {
    switch (uri) {
      case 'glpi://tickets/open': {
        const result = await client.search.search('Ticket', {
          criteria: [{ field: TICKET_FIELDS.status, searchtype: 'lessthan', value: 5 }],
          limit: 100,
          order: 'DESC',
          sort: TICKET_FIELDS.date_mod,
          expandDropdowns: true,
        });
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result.data, null, 2) }] };
      }
      case 'glpi://tickets/recent': {
        const tickets = await client.getTickets({ range: '0-19', order: 'DESC', expand_dropdowns: true });
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(tickets, null, 2) }] };
      }
      case 'glpi://problems/open': {
        const problems = await client.getProblems({ range: '0-99' });
        const open = (problems as any[]).filter((p) => p.status < 5);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(open, null, 2) }] };
      }
      case 'glpi://changes/pending': {
        const changes = await client.getChanges({ range: '0-99' });
        const pending = (changes as any[]).filter((c) => c.status < 8);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(pending, null, 2) }] };
      }
      case 'glpi://computers':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getComputers({ range: '0-99', is_deleted: false }), null, 2) }] };
      case 'glpi://groups':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getGroups({ range: '0-99' }), null, 2) }] };
      case 'glpi://categories':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getCategories({ range: '0-99' }), null, 2) }] };
      case 'glpi://stats/tickets':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getTicketStats(), null, 2) }] };
      case 'glpi://stats/assets':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getAssetStats(), null, 2) }] };
      default:
        throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(
      ErrorCode.InternalError,
      `Error reading resource: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Set in HTTP mode so shutdown can stop accepting requests. */
let runningHttpServer: { close: () => Promise<void> } | undefined;
let shuttingDown = false;

async function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`Shutting down (${reason})...`);
  try {
    await runningHttpServer?.close();
  } catch (error) {
    console.error('Warning: HTTP server close failed:', error instanceof Error ? error.message : error);
  }
  try {
    await client.killSession();
  } catch (error) {
    console.error('Warning: killSession failed during shutdown:', error instanceof Error ? error.message : error);
  }
  process.exit(0);
}

/** MCP over stdin/stdout — one client, the default (Claude Desktop/Code, Cursor). */
async function startStdioTransport() {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error(`MCP GLPI Server v${SERVER_VERSION} running on stdio`);
}

/** MCP Streamable HTTP — web clients such as Open WebUI. */
async function startHttpTransport(config: HttpTransportConfig) {
  const running = await startHttpMcpServer({
    config,
    createServer: createMcpServer,
    log: (message) => console.error(`[mcp-http] ${message}`),
  });
  runningHttpServer = running;

  console.error(`MCP GLPI Server v${SERVER_VERSION} listening on ${running.url}`);
  console.error('  transport: streamable HTTP (stateless, JSON responses)');
  console.error(
    `  auth: ${config.authToken ? 'bearer token required' : 'none — bind to loopback or set MCP_HTTP_AUTH_TOKEN before exposing this port'}`
  );
  if (!config.allowedHosts) {
    console.error(
      `  warning: Host header validation is off because the server is bound to ${config.host}; ` +
      'set MCP_HTTP_ALLOWED_HOSTS to restrict it'
    );
  }
}

async function main() {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
      console.error(USAGE);
      process.exit(0);
    }

    let transportConfig;
    try {
      transportConfig = parseTransportConfig(argv, process.env);
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(`Configuration error: ${error.message}\n\n${USAGE}`);
        process.exit(2);
      }
      throw error;
    }

    const config = getConfig();
    client = new GlpiClient(config);

    // Try to open the session eagerly, but don't die if GLPI is momentarily
    // unreachable: the HTTP layer re-authenticates lazily on first request.
    try {
      await client.initSession();
      console.error('GLPI session initialized');
    } catch (error) {
      console.error(
        `Warning: could not reach GLPI at startup (${error instanceof Error ? error.message : error}). ` +
        'The session will be established on the first request.'
      );
    }

    if (transportConfig.mode === 'http') {
      await startHttpTransport(transportConfig.http);
    } else {
      await startStdioTransport();
    }

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
