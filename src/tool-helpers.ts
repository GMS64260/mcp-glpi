/**
 * Tool-layer helpers extracted from index.ts so they can be unit-tested
 * (index.ts starts the server on import).
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { formatGlpiDate } from './glpi-client.js';
import type { GlpiClient, TicketRelation } from './glpi-client.js';
import type { SearchCriterion, SearchLink, SearchType } from './search.js';
import type { SearchOptionsCatalogue } from './search-options.js';
import { ArgumentError } from './errors.js';
import { VALIDATION_ACCEPTED, VALIDATION_REFUSED, type ValidationAnswer } from './itil.js';

const invalid = (message: string) => new ArgumentError(message);

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

/**
 * Read a positive integer id from the arguments. Accepts numeric strings
 * ("12") and throws an ArgumentError when missing or malformed, so a missing id
 * can never turn into a `PUT Problem/undefined` call.
 */
export function requireId(args: Record<string, unknown>, key: string, min = 1): number {
  const value = args[key];
  if (value === undefined || value === null || value === '') throw invalid(`${key} is required`);
  const n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min) {
    throw invalid(`${key} must be ${min >= 1 ? 'a positive' : 'a non-negative'} integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

const VALIDATION_ANSWERS: Record<string, ValidationAnswer> = {
  accepted: VALIDATION_ACCEPTED,
  accept: VALIDATION_ACCEPTED,
  approved: VALIDATION_ACCEPTED,
  approve: VALIDATION_ACCEPTED,
  granted: VALIDATION_ACCEPTED,
  refused: VALIDATION_REFUSED,
  refuse: VALIDATION_REFUSED,
  rejected: VALIDATION_REFUSED,
  reject: VALIDATION_REFUSED,
  denied: VALIDATION_REFUSED,
};

/**
 * `status` for glpi_set_validation_status: "accepted" or "refused", as
 * GLPI's code (3 or 4). Numbers are refused on purpose: until 4.2.0 the tool
 * documented 2 = granted and 3 = refused while GLPI reads 2 as Waiting and 3
 * as Accepted, so a number cannot be told apart from the old convention, and
 * an approval must not be guessed.
 */
export function parseValidationStatus(value: unknown): ValidationAnswer {
  const answer = typeof value === 'string' ? VALIDATION_ANSWERS[value.trim().toLowerCase()] : undefined;
  if (answer === undefined) {
    throw invalid(
      `status must be "accepted" or "refused", got ${JSON.stringify(value)}. ` +
        'Numeric codes are not accepted: mcp-glpi <= 4.2.0 documented 2/3, which GLPI reads as Waiting/Accepted.'
    );
  }
  return answer;
}

// ---------------------------------------------------------------------------
// Criteria / field resolution
// ---------------------------------------------------------------------------

export interface CriteriaArg {
  field: number | string;
  searchtype: SearchType;
  value: string | number | boolean;
  link?: SearchLink;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Up to `max` option names closest to `ref` ("name (id, uid)"). */
export function closestOptions(catalogue: SearchOptionsCatalogue, ref: string, max = 5): string[] {
  const needle = ref.toLowerCase();
  const scored = [...catalogue.byId.values()].map((o) => {
    const candidates = [o.name, o.field, o.uid].filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
    let score = Infinity;
    for (const c of candidates) {
      const s = c.includes(needle) || needle.includes(c) ? Math.abs(c.length - needle.length) * 0.1 : levenshtein(needle, c) + 2;
      score = Math.min(score, s);
    }
    return { o, score };
  });
  scored.sort((a, b) => a.score - b.score || a.o.id - b.o.id);
  return scored.slice(0, max).map(({ o }) => `${o.name} (${o.id}${o.uid ? ', ' + o.uid : ''})`);
}

/**
 * Translate criteria `field` refs (option id, uid, column or label) to option
 * ids. An unknown name is an ArgumentError listing the closest options
 * (it used to fall back to field 0 and search on the wrong column).
 */
export async function resolveCriteria(
  client: GlpiClient,
  itemtype: string,
  raw: CriteriaArg[]
): Promise<SearchCriterion[]> {
  return Promise.all(
    raw.map(async (c, i) => {
      const field = await client.searchOptions.resolveField(itemtype, c.field);
      if (field === undefined) {
        const catalogue = await client.searchOptions.get(itemtype);
        const near = closestOptions(catalogue, String(c.field));
        throw invalid(
          `criteria[${i}].field "${c.field}" is not a search option of ${itemtype}.` +
            (near.length ? ` Closest: ${near.join('; ')}.` : '') +
            ' See glpi_list_search_options.'
        );
      }
      return { field, searchtype: c.searchtype, value: c.value, link: c.link };
    })
  );
}

/**
 * Standard Ticket search-option ids (GLPI >= 9.5), used as fallbacks when the
 * SearchOptions catalogue cannot resolve the column.
 */
export const TICKET_FIELDS = {
  id: 2,
  name: 1,
  status: 12,
  date: 15,
  date_mod: 19,
  solvedate: 17,
  closedate: 16,
  time_to_resolve: 18,
  priority: 3,
  urgency: 10,
  impact: 11,
  category: 7,
  entity: 80,
  requester_user: 4,
  technician_user: 5,
  technician_group: 8,
  observer_user: 66,
  type: 14,
} as const;

export type TicketFieldKey = keyof typeof TICKET_FIELDS;

/**
 * Column/uid used to resolve each key dynamically. The actor options
 * (requester 4, technician 5, observer 66: Ticket_User rows of type 1, 2, 3)
 * share one uid and one column (`name` of glpi_users); the role is a join
 * condition, not part of the option. They cannot be told apart through
 * listSearchOptions, so they keep GLPI's standard ids. On a GLPI where they
 * were renumbered, filter with glpi_search_v2 and the right option id.
 */
const TICKET_FIELD_REFS: Partial<Record<TicketFieldKey, string>> = {
  id: 'Ticket.id',
  name: 'Ticket.name',
  status: 'Ticket.status',
  date: 'Ticket.date',
  date_mod: 'Ticket.date_mod',
  solvedate: 'Ticket.solvedate',
  closedate: 'Ticket.closedate',
  time_to_resolve: 'Ticket.time_to_resolve',
  priority: 'Ticket.priority',
  urgency: 'Ticket.urgency',
  impact: 'Ticket.impact',
  type: 'Ticket.type',
  category: 'Ticket.ITILCategory.completename',
  entity: 'Ticket.Entity.completename',
};

const ticketFieldCache = new WeakMap<GlpiClient, Map<TicketFieldKey, Promise<number>>>();

/**
 * Search-option id of a Ticket field, resolved once per process (per client)
 * through the catalogue, with the static id as fallback.
 */
export function ticketField(client: GlpiClient, key: TicketFieldKey): Promise<number> {
  let perClient = ticketFieldCache.get(client);
  if (!perClient) {
    perClient = new Map();
    ticketFieldCache.set(client, perClient);
  }
  const cached = perClient.get(key);
  if (cached) return cached;
  const ref = TICKET_FIELD_REFS[key];
  const fallback = TICKET_FIELDS[key];
  const resolved = ref
    ? client.searchOptions.resolveField('Ticket', ref).then(
        (id) => id ?? fallback,
        () => {
          // Catalogue unreachable: do not cache the fallback forever.
          perClient!.delete(key);
          return fallback;
        }
      )
    : Promise.resolve(fallback);
  perClient.set(key, resolved);
  return resolved;
}

/**
 * Search value of the ITIL status option for "not solved/closed" (statuses
 * 1-4 for tickets). The status option is not ordered: `lessthan 5` makes GLPI
 * match Solved tickets instead.
 */
export const OPEN_STATUS_VALUE = 'notold';

/** Problem statuses that are not Solved (5) / Closed (6). */
export const OPEN_PROBLEM_STATUSES = [1, 2, 3, 4, 7, 8] as const;
/** Change statuses that are not Applied (5), Closed (6), Review (8), Refused (13), Cancelled (14). */
export const PENDING_CHANGE_STATUSES = [1, 2, 3, 4, 7, 9, 10, 11, 12] as const;

/** `status IN (...)` as OR-linked equals criteria. */
export function statusInCriteria(field: number, statuses: readonly number[]): SearchCriterion[] {
  return statuses.map((value, i) => ({
    field,
    searchtype: 'equals' as const,
    value,
    ...(i > 0 ? { link: 'OR' as const } : {}),
  }));
}

/** Rows of `itemtype` whose status is one of `statuses`, newest date_mod first. */
export async function searchByStatuses(
  client: GlpiClient,
  itemtype: 'Problem' | 'Change' | 'Ticket',
  statuses: readonly number[],
  limit = 50
) {
  const [statusField, dateModField] = await Promise.all([
    client.searchOptions.resolveField(itemtype, `${itemtype}.status`).catch(() => undefined),
    client.searchOptions.resolveField(itemtype, `${itemtype}.date_mod`).catch(() => undefined),
  ]);
  return client.search.search(itemtype, {
    criteria: statusInCriteria(statusField ?? 12, statuses),
    start: 0,
    limit,
    sort: dateModField ?? 19,
    order: 'DESC',
    expandDropdowns: true,
  });
}

// ---------------------------------------------------------------------------
// Month buckets (glpi_tickets_stats_by dimension=month)
// ---------------------------------------------------------------------------

export const MAX_STATS_MONTHS = 36;

export interface MonthBucket {
  /** "YYYY-MM" */
  key: string;
  /** "YYYY-MM-01 00:00:00", local time */
  start: string;
  /** First day of the next month, "YYYY-MM-01 00:00:00" */
  end: string;
  /** One second before `start`: GLPI's `morethan` is strict (>). */
  afterValue: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Year + month (0-based) of a "YYYY-MM[-DD...]" string, without Date/UTC parsing. */
function parseYearMonth(value: string): { y: number; m: number } {
  const match = value.match(/^\s*(\d{4})-(\d{1,2})/);
  if (match) return { y: parseInt(match[1], 10), m: parseInt(match[2], 10) - 1 };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw invalid(`invalid date "${value}" (expected YYYY-MM-DD)`);
  return { y: d.getFullYear(), m: d.getMonth() };
}

/**
 * Monthly buckets between date_from and date_to (inclusive months), default
 * the last 6 months up to `now`. Boundaries are built with local getters, so
 * a ticket created at 00:00:00 on the 1st lands in its own month whatever the
 * process timezone. More than 36 months is an error.
 */
export function monthBuckets(dateFrom?: string, dateTo?: string, now: Date = new Date()): MonthBucket[] {
  const to = dateTo ? parseYearMonth(dateTo) : { y: now.getFullYear(), m: now.getMonth() };
  const from = dateFrom
    ? parseYearMonth(dateFrom)
    : { y: new Date(to.y, to.m - 5, 1).getFullYear(), m: new Date(to.y, to.m - 5, 1).getMonth() };
  const months = (to.y - from.y) * 12 + (to.m - from.m) + 1;
  if (months < 1) throw invalid('date_from must be before date_to');
  if (months > MAX_STATS_MONTHS) {
    throw invalid(`dimension=month covers ${months} months; the maximum is ${MAX_STATS_MONTHS}. Narrow date_from/date_to.`);
  }
  const buckets: MonthBucket[] = [];
  for (let i = 0; i < months; i++) {
    const startDate = new Date(from.y, from.m + i, 1, 0, 0, 0);
    const endDate = new Date(from.y, from.m + i + 1, 1, 0, 0, 0);
    const before = new Date(from.y, from.m + i, 1, 0, 0, 0);
    before.setSeconds(before.getSeconds() - 1);
    buckets.push({
      key: `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}`,
      start: formatGlpiDate(startDate),
      end: formatGlpiDate(endDate),
      afterValue: formatGlpiDate(before),
    });
  }
  return buckets;
}

/** Criteria selecting tickets created inside a bucket: date > start-1s AND date < end. */
export function monthCriteria(bucket: MonthBucket, dateField: number): SearchCriterion[] {
  return [
    { field: dateField, searchtype: 'morethan', value: bucket.afterValue },
    { field: dateField, searchtype: 'lessthan', value: bucket.end, link: 'AND' },
  ];
}

// ---------------------------------------------------------------------------
// glpi_link_tickets
// ---------------------------------------------------------------------------

const RELATIONS: readonly TicketRelation[] = ['link', 'duplicate', 'child_of', 'parent_of'];
const LINK_TYPE_TO_RELATION: Record<number, TicketRelation> = {
  1: 'link',
  2: 'duplicate',
  3: 'child_of',
  4: 'parent_of',
};

/**
 * Normalise glpi_link_tickets arguments to "ticket <relation> other".
 *
 * New form: ticket_id, other_ticket_id, relation (or numeric link_type,
 * GLPI constants: 1 link, 2 duplicate, 3 ticket_id is child of other,
 * 4 ticket_id is parent of other).
 *
 * Legacy form: parent_id, child_id, link_type. The parameter names carry the
 * direction, so link_type 3 or 4 both mean "parent_id is the parent of
 * child_id" (v3 sent link_type as-is, which made 3 = SON_OF invert it).
 */
export function resolveLinkArgs(args: Record<string, unknown>): {
  ticketId: number;
  otherTicketId: number;
  relation: TicketRelation;
} {
  const legacy = args.ticket_id === undefined && (args.parent_id !== undefined || args.child_id !== undefined);
  const ticketId = requireId(args, legacy ? 'parent_id' : 'ticket_id');
  const otherTicketId = requireId(args, legacy ? 'child_id' : 'other_ticket_id');
  if (ticketId === otherTicketId) throw invalid('a ticket cannot be linked to itself');

  let relation: TicketRelation | undefined;
  if (args.relation !== undefined) {
    if (!RELATIONS.includes(args.relation as TicketRelation)) {
      throw invalid(`relation must be one of ${RELATIONS.join(', ')}`);
    }
    relation = args.relation as TicketRelation;
  } else if (args.link_type !== undefined) {
    const n = Number(args.link_type);
    relation = LINK_TYPE_TO_RELATION[n];
    if (!relation) throw invalid('link_type must be 1 (link), 2 (duplicate), 3 (child of) or 4 (parent of)');
    if (legacy && (relation === 'child_of' || relation === 'parent_of')) relation = 'parent_of';
  } else {
    relation = 'link';
  }
  return { ticketId, otherTicketId, relation };
}

// ---------------------------------------------------------------------------
// glpi_upload_document
// ---------------------------------------------------------------------------

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** MIME types for glpi_upload_document, keyed by lowercase file extension. */
export const UPLOAD_MIME_TYPES: Record<string, string> = {
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

export interface UploadSource {
  filename: string;
  data: Uint8Array;
  mimeType?: string;
}

function tooLarge(size: number): ArgumentError {
  return invalid(`file is ${size} bytes; the maximum is ${MAX_UPLOAD_BYTES} bytes (20 MB)`);
}

/**
 * Resolve the bytes to upload.
 *  - `content_base64` + `filename`: inline content, no filesystem access.
 *  - `file_path`: only when GLPI_UPLOAD_DIR is set, and only for a regular
 *    file whose real path (symlinks resolved) is inside that directory.
 *    Relative paths are resolved against GLPI_UPLOAD_DIR.
 * Both are capped at 20 MB.
 */
export async function resolveUploadSource(
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): Promise<UploadSource> {
  if (args.content_base64 !== undefined) {
    if (typeof args.content_base64 !== 'string' || args.content_base64.length === 0) {
      throw invalid('content_base64 must be a non-empty base64 string');
    }
    const filename = args.filename;
    if (typeof filename !== 'string' || !filename.trim()) throw invalid('filename is required with content_base64');
    if (basename(filename) !== filename || filename === '.' || filename === '..') {
      throw invalid('filename must be a bare file name (no directory)');
    }
    const b64 = args.content_base64.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw invalid('content_base64 is not valid base64');
    const estimated = Math.floor((b64.length * 3) / 4);
    if (estimated > MAX_UPLOAD_BYTES + 3) throw tooLarge(estimated);
    const data = Buffer.from(b64, 'base64');
    if (data.length === 0) throw invalid('content_base64 decodes to an empty file');
    if (data.length > MAX_UPLOAD_BYTES) throw tooLarge(data.length);
    return { filename, data, mimeType: UPLOAD_MIME_TYPES[extname(filename).toLowerCase()] };
  }

  const filePath = args.file_path;
  if (typeof filePath !== 'string' || !filePath) throw invalid('file_path or content_base64 + filename required');

  const uploadDir = env.GLPI_UPLOAD_DIR;
  if (!uploadDir) {
    throw invalid(
      'Uploading by file_path is disabled: the server has no GLPI_UPLOAD_DIR. ' +
        'Set GLPI_UPLOAD_DIR to the directory files may be read from, or send content_base64 + filename instead.'
    );
  }
  let realDir: string;
  try {
    realDir = await realpath(uploadDir);
  } catch {
    throw invalid('GLPI_UPLOAD_DIR does not exist on the server');
  }
  let realFile: string;
  try {
    realFile = await realpath(resolve(realDir, filePath));
  } catch (err) {
    throw invalid(`cannot read file "${filePath}": ${err instanceof Error ? err.message : err}`);
  }
  const rel = relative(realDir, realFile);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw invalid(`file_path must be inside GLPI_UPLOAD_DIR (${realDir})`);
  }
  const info = await stat(realFile);
  if (!info.isFile()) throw invalid(`"${filePath}" is not a regular file`);
  if (info.size > MAX_UPLOAD_BYTES) throw tooLarge(info.size);
  const data = await readFile(realFile);
  const filename = basename(realFile);
  return { filename, data, mimeType: UPLOAD_MIME_TYPES[extname(filename).toLowerCase()] };
}
