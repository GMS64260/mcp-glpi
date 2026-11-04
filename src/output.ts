/**
 * Output conventions shared by every tool.
 *
 *   - `text(obj)`: compact JSON (no indentation) in one text content block.
 *   - `htmlToText` / `truncateText` / `cleanText`: GLPI stores rich text as
 *     HTML, often entity-encoded twice (`&lt;p&gt;`); tools return plain text
 *     capped at `max_content_chars` unless the caller asks for `raw_html`.
 *   - `listEnvelope`: `{ totalcount, start, count, next_start, items }`.
 *   - `compactItem`: per-itemtype projection of a GLPI object (detail and
 *     list tools), `verbose: true` returns the raw object instead.
 *   - `stripLinks`: drops HATEOAS `links` arrays that slip through.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isItilItemtype, STATUS_BY_ITEMTYPE, TICKET_PRIORITY, TICKET_URGENCY } from './itil.js';

export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_MAX_CONTENT_CHARS = 2000;

/** One compact JSON text block. */
export function text(obj: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

// ---------------------------------------------------------------------------
// Text fields
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  agrave: 'à',
  acirc: 'â',
  ccedil: 'ç',
  ocirc: 'ô',
  ucirc: 'û',
  ugrave: 'ù',
  icirc: 'î',
  iuml: 'ï',
  euml: 'ë',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  euro: '€',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? match;
  });
}

/**
 * HTML (possibly entity-encoded) to plain text: decode entities, turn block
 * tags into line breaks, drop the other tags, collapse whitespace.
 */
export function htmlToText(input: string): string {
  let s = input;
  // GLPI often stores "&lt;p&gt;..." — decode once so the tags become real.
  if (/&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cap a string at `max` characters, saying how long it was. */
export function truncateText(input: string, max = DEFAULT_MAX_CONTENT_CHARS): string {
  if (max <= 0 || input.length <= max) return input;
  return `${input.slice(0, max)}…[truncated, ${input.length} chars]`;
}

export interface TextOptions {
  /** Default 2000; 0 disables truncation. */
  max_content_chars?: number;
  /** Return the stored HTML as-is (no conversion, no truncation). */
  raw_html?: boolean;
}

/** Text fields converted by `cleanText` / `cleanTextFields`. */
export const TEXT_FIELDS = ['content', 'answer', 'comment', 'comment_submission', 'comment_validation'] as const;

export function cleanText(value: unknown, opts: TextOptions = {}): unknown {
  if (typeof value !== 'string' || opts.raw_html) return value;
  return truncateText(htmlToText(value), opts.max_content_chars ?? DEFAULT_MAX_CONTENT_CHARS);
}

/** Apply `cleanText` to the known text fields of an object (copy). */
export function cleanTextFields<T extends Record<string, unknown>>(obj: T, opts: TextOptions = {}): T {
  if (opts.raw_html) return obj;
  const out: Record<string, unknown> = { ...obj };
  for (const key of TEXT_FIELDS) {
    if (typeof out[key] === 'string') out[key] = cleanText(out[key], opts);
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// HATEOAS links
// ---------------------------------------------------------------------------

/** Remove `links` keys (GLPI HATEOAS) recursively, up to `depth` levels. */
export function stripLinks<T>(value: T, depth = 4): T {
  if (depth < 0 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripLinks(v, depth - 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'links') continue;
    out[k] = stripLinks(v, depth - 1);
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// List envelope
// ---------------------------------------------------------------------------

export interface ListEnvelope<T> {
  totalcount: number;
  start: number;
  count: number;
  next_start: number | null;
  items: T[];
}

export function listEnvelope<T>(items: T[], start: number, totalcount: number | undefined): ListEnvelope<T> {
  const total = totalcount ?? start + items.length;
  const end = start + items.length;
  return {
    totalcount: total,
    start,
    count: items.length,
    next_start: items.length > 0 && end < total ? end : null,
    items,
  };
}

/** Clamp a requested page size to 1..500 (default 25). */
export function pageLimit(limit: number | undefined, fallback = DEFAULT_LIST_LIMIT): number {
  if (limit === undefined) return fallback;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit)));
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const asNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v);
  return undefined;
};

/** Add status_label / urgency_label / priority_label to an ITIL object (copy). */
export function withItilLabels<T extends Record<string, unknown>>(itemtype: string, obj: T): T {
  if (!isItilItemtype(itemtype)) return obj;
  const out: Record<string, unknown> = { ...obj };
  const status = asNumber(obj.status);
  if (status !== undefined) out.status_label = STATUS_BY_ITEMTYPE[itemtype][status] ?? null;
  const urgency = asNumber(obj.urgency);
  if (urgency !== undefined) out.urgency_label = TICKET_URGENCY[urgency] ?? null;
  const priority = asNumber(obj.priority);
  if (priority !== undefined) out.priority_label = TICKET_PRIORITY[priority] ?? null;
  return out as T;
}

// ---------------------------------------------------------------------------
// Compact projections
// ---------------------------------------------------------------------------

const ASSET_FIELDS = [
  'id', 'name', 'entities_id', 'serial', 'otherserial', 'states_id', 'locations_id',
  'users_id', 'groups_id', 'users_id_tech', 'groups_id_tech', 'manufacturers_id',
  'contact', 'uuid', 'is_deleted', 'date_mod', 'comment',
];

const ITIL_FIELDS = [
  'id', 'name', 'type', 'status', 'status_label', 'urgency', 'urgency_label', 'impact',
  'priority', 'priority_label', 'itilcategories_id', 'entities_id', 'date', 'date_mod',
  'solvedate', 'closedate', 'time_to_resolve', 'time_to_own', 'users_id_recipient',
  'requesttypes_id', 'global_validation', 'actiontime', 'is_deleted', 'content',
];

/** Fields kept by `compactItem` per itemtype (missing ones are skipped). */
export const COMPACT_FIELDS: Record<string, readonly string[]> = {
  Computer: ASSET_FIELDS,
  NetworkEquipment: ASSET_FIELDS,
  Printer: ASSET_FIELDS,
  Monitor: ASSET_FIELDS,
  Phone: ASSET_FIELDS,
  Peripheral: ASSET_FIELDS,
  Rack: ASSET_FIELDS,
  Enclosure: ASSET_FIELDS,
  PDU: ASSET_FIELDS,
  Software: ['id', 'name', 'entities_id', 'manufacturers_id', 'softwarecategories_id', 'is_deleted', 'date_mod', 'comment'],
  Ticket: ITIL_FIELDS,
  Problem: ITIL_FIELDS,
  Change: ITIL_FIELDS,
  KnowbaseItem: ['id', 'name', 'is_faq', 'knowbaseitemcategories_id', 'users_id', 'view', 'date_creation', 'date_mod', 'answer'],
  Contract: ['id', 'name', 'num', 'contracttypes_id', 'begin_date', 'duration', 'notice', 'periodicity', 'renewal', 'entities_id', 'is_deleted', 'comment'],
  Supplier: ['id', 'name', 'suppliertypes_id', 'address', 'postcode', 'town', 'country', 'website', 'phonenumber', 'email', 'entities_id', 'is_deleted', 'comment'],
  Location: ['id', 'name', 'completename', 'locations_id', 'address', 'postcode', 'town', 'building', 'room', 'entities_id', 'comment'],
  Entity: ['id', 'name', 'completename', 'entities_id', 'level', 'email', 'phonenumber', 'comment'],
  Project: ['id', 'name', 'code', 'priority', 'projectstates_id', 'state', 'state_is_finished', 'projecttypes_id', 'projects_id', 'percent_done', 'auto_percent_done', 'plan_start_date', 'plan_end_date', 'real_start_date', 'real_end_date', 'users_id', 'groups_id', 'entities_id', 'is_recursive', 'date_mod', 'is_deleted', 'content', 'comment'],
  ProjectTask: ['id', 'name', 'projects_id', 'projecttasks_id', 'projectstates_id', 'state', 'state_is_finished', 'projecttasktypes_id', 'percent_done', 'is_milestone', 'plan_start_date', 'plan_end_date', 'real_start_date', 'real_end_date', 'planned_duration', 'effective_duration', 'users_id', 'entities_id', 'date_mod', 'content', 'comment'],
  ProjectState: ['id', 'name', 'is_finished', 'color', 'comment'],
  ProjectTeam: ['id', 'projects_id', 'itemtype', 'items_id'],
  ProjectTaskTeam: ['id', 'projecttasks_id', 'itemtype', 'items_id'],
  Itil_Project: ['id', 'projects_id', 'itemtype', 'items_id'],
  ProjectTask_Ticket: ['id', 'projecttasks_id', 'tickets_id'],
  Document: ['id', 'name', 'filename', 'mime', 'documentcategories_id', 'users_id', 'entities_id', 'date_mod', 'is_deleted', 'comment'],
  Group: ['id', 'name', 'completename', 'groups_id', 'entities_id', 'is_requester', 'is_assign', 'is_manager', 'comment'],
  ITILCategory: ['id', 'name', 'completename', 'itilcategories_id', 'level', 'code', 'entities_id', 'is_incident', 'is_request', 'is_problem', 'is_change', 'comment'],
  User: ['id', 'name', 'realname', 'firstname', 'phone', 'mobile', 'is_active', 'entities_id', 'profiles_id', 'locations_id', 'usertitles_id', 'usercategories_id', 'last_login', 'date_mod', 'is_deleted', 'comment'],
  Profile: ['id', 'name', 'interface', 'is_default', 'comment'],
};

const DEFAULT_COMPACT_FIELDS = [
  'id', 'name', 'completename', 'status', 'states_id', 'entities_id', 'locations_id', 'date_mod', 'is_deleted', 'comment',
];

/** Asset model/type dropdowns ("computertypes_id", "printermodels_id", ...). */
const ASSET_TYPE_KEY = /^[a-z]+(types|models)_id$/;

export interface CompactOptions extends TextOptions {
  /** Return the object as GLPI sent it (links stripped, text still cleaned unless raw_html). */
  verbose?: boolean;
  /** Explicit list of keys to keep (overrides the default projection). */
  fields?: readonly string[];
}

/**
 * Compact projection of a GLPI object: the itemtype's useful keys, ITIL
 * labels, sub-resources requested with `with_*` (keys starting with "_"),
 * and text fields as plain text.
 */
export function compactItem(itemtype: string, obj: unknown, opts: CompactOptions = {}): Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj as Record<string, unknown>;
  const raw = withItilLabels(itemtype, stripLinks(obj as Record<string, unknown>));
  let out: Record<string, unknown>;
  if (opts.verbose) {
    out = raw;
  } else {
    const keys = opts.fields ?? COMPACT_FIELDS[itemtype] ?? DEFAULT_COMPACT_FIELDS;
    const isAsset = (COMPACT_FIELDS[itemtype] ?? null) === ASSET_FIELDS;
    out = {};
    for (const k of keys) if (raw[k] !== undefined) out[k] = raw[k];
    if (!opts.fields) {
      for (const [k, v] of Object.entries(raw)) {
        if (k in out) continue;
        if (k.startsWith('_') || (isAsset && ASSET_TYPE_KEY.test(k))) out[k] = v;
      }
    }
  }
  return cleanTextFields(out, opts);
}
