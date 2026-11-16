/**
 * Schema building blocks and small helpers shared by the tool modules.
 *
 * Parameter descriptions stay short: code tables (status, urgency,
 * priority...), the date format, paging and text-capping rules live once in
 * the server instructions (server.ts), and descriptions point there.
 */

import { z } from 'zod';
import type { ListOptions } from '../glpi-client.js';
import { ArgumentError } from '../errors.js';
import { pageLimit } from '../output.js';
import { hidden } from './registry.js';

export { hidden };

/** Numeric strings ("12") are accepted for numbers, as in v3. */
const numericString = (v: unknown) => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v);

/**
 * Descriptions are optional: a parameter whose name already says what it is
 * (ticket_id on a ticket tool, email...) is listed without one.
 */
const described = <T extends z.ZodTypeAny>(schema: T, description?: string): T =>
  description ? (schema.describe(description) as T) : schema;

/** Required positive integer id. */
export const id = (description?: string) =>
  described(z.preprocess(numericString, z.number().int().positive()), description);

/** Optional id where 0 is meaningful (root entity, "no category"). */
export const optId = (description?: string) =>
  described(z.preprocess(numericString, z.number().int().nonnegative()).optional(), description);

/**
 * Active entity: an id (0 = root) or "all". Numeric strings are coerced like
 * every other id argument, so `{"entity_id": "3"}` switches entity 3.
 */
export const entityIdArg = (description?: string) =>
  described(
    z.preprocess(numericString, z.union([z.number().int().nonnegative(), z.literal('all')])),
    description
  );

export const optInt = (description?: string) => described(z.preprocess(numericString, z.number().int()).optional(), description);

export const optBool = (description?: string) => described(z.boolean().optional(), description);
export const optStr = (description?: string) => described(z.string().optional(), description);

// ---- pointers to the code tables of the instructions --------------------------

export const STATUS_TICKET_DESC = 'Status (instructions)';
export const STATUS_PROBLEM_DESC = STATUS_TICKET_DESC;
export const STATUS_CHANGE_DESC = STATUS_TICKET_DESC;
export const URGENCY_DESC = 'Urgency 1-5';
export const IMPACT_DESC = 'Impact 1-5';
export const PRIORITY_DESC = 'Priority 1-6';
/** Suffix for date parameters; the format is in the instructions. */
export const DATE = '(date)';

export const itilItemtype = z.enum(['Ticket', 'Change', 'Problem']).optional().describe('Default Ticket');

// ---- shared list / output parameters ----------------------------------------
//
// Defined once here and explained once, in the instructions ("Lists return
// ...", "Text fields ..."): their per-tool description would repeat the
// same sentence in a dozen tools. SHARED_PARAMS names them for the test
// that checks every advertised parameter is described somewhere.

export const SHARED_PARAMS = [
  'start', 'limit', 'sort', 'order', 'is_deleted', 'expand_dropdowns', 'fetch_all', 'max_rows',
  'fields', 'verbose', 'max_content_chars', 'raw_html',
] as const;

export const verbose = z.boolean().optional();
export const fields = z.array(z.string()).min(1).optional();

/** max_content_chars / raw_html. */
export const textShape = {
  max_content_chars: z.number().int().min(0).optional(),
  raw_html: z.boolean().optional(),
};

export const orderSchema = z.enum(['ASC', 'DESC']).optional();
export const sortSchema = z.union([z.string().min(1), z.number().int()]).optional();

/** start/limit: every paged tool. */
export const pageShape = {
  start: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
};

/** Paging of the search/{itemtype} tools. */
export const searchPageShape = {
  ...pageShape,
  fetch_all: z.boolean().optional(),
  max_rows: z.number().int().min(1).optional(),
  sort: sortSchema,
  order: orderSchema,
};

export const isDeleted = z.boolean().optional();
export const expandDropdowns = z.boolean().optional();

/** Paging/sorting arguments of the GET /{itemtype} list tools. */
export const listShape = {
  ...pageShape,
  /** v3 "START-END"; accepted, not advertised. */
  range: hidden(optStr('Legacy START-END')),
  /** v3 parameter, removed: accepted so the handler can explain why. */
  include_deleted: hidden(z.unknown().optional()),
  sort: sortSchema,
  order: orderSchema,
  expand_dropdowns: expandDropdowns,
  is_deleted: isDeleted,
};

export interface ListArgs {
  start?: number;
  limit?: number;
  range?: string;
  include_deleted?: unknown;
  sort?: string | number;
  order?: 'ASC' | 'DESC';
  expand_dropdowns?: boolean;
  is_deleted?: boolean;
}

export const INCLUDE_DELETED_REMOVED =
  'include_deleted was removed: it meant is_deleted=true, which lists only the trashed rows. ' +
  'Omit it for the active rows, or pass is_deleted: true for the trash.';

/** start/limit (or legacy range) -> ListOptions + the effective start. */
export function toListOptions(args: ListArgs, defaultOrder?: 'ASC' | 'DESC'): { opts: ListOptions; start: number; limit: number } {
  if (args.include_deleted !== undefined) throw new ArgumentError(INCLUDE_DELETED_REMOVED);
  let start = args.start ?? 0;
  let limit = pageLimit(args.limit);
  const m = args.range?.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (m) {
    start = parseInt(m[1], 10);
    limit = pageLimit(Math.max(1, parseInt(m[2], 10) - start + 1));
  }
  const opts: ListOptions = {
    range: `${start}-${start + limit - 1}`,
    expand_dropdowns: args.expand_dropdowns !== false,
  };
  if (args.sort !== undefined) opts.sort = args.sort;
  if (args.order ?? defaultOrder) opts.order = args.order ?? defaultOrder;
  if (args.is_deleted !== undefined) opts.is_deleted = args.is_deleted;
  return { opts, start, limit };
}

/** "10-29" -> { start: 10, limit: 20 } for alias mappers. */
export function rangeArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.range !== 'string') return args;
  const m = args.range.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!m) return args;
  const { range: _range, ...rest } = args;
  const start = parseInt(m[1], 10);
  return { ...rest, start, limit: Math.max(1, parseInt(m[2], 10) - start + 1) };
}

/** Copy without undefined values. */
export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/** Booleans to GLPI's 0/1. */
export function bool01(v: unknown): unknown {
  return typeof v === 'boolean' ? (v ? 1 : 0) : v;
}
