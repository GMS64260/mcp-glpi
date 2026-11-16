/**
 * High-level search/count/fetch_all over GLPI's /search/{itemtype} endpoint.
 *
 * Features:
 *   - Multi-criteria with link operator (AND / OR / AND NOT / OR NOT).
 *   - forcedisplay (choose returned columns).
 *   - Reads totalcount + Content-Range header.
 *   - fetch_all: paginates until totalcount reached, capped by maxRows.
 *   - Optional sort + order.
 */

import { GlpiHttp } from './http.js';
import type { SearchOptionsCatalogue, SearchOptionsCache } from './search-options.js';

export type SearchType =
  | 'contains'
  | 'notcontains'
  | 'equals'
  | 'notequals'
  | 'lessthan'
  | 'morethan'
  | 'under'
  | 'notunder'
  | 'empty'
  | 'notempty';

export type SearchLink = 'AND' | 'OR' | 'AND NOT' | 'OR NOT';

export interface SearchCriterion {
  field: number;
  searchtype: SearchType;
  value: string | number | boolean;
  /** Combination operator with the previous criterion. Ignored on the first one. */
  link?: SearchLink;
}

export interface SearchOptions {
  criteria?: SearchCriterion[];
  /** field_id list to return; if undefined, GLPI uses its default. */
  forcedisplay?: number[];
  /** First row (0-indexed). */
  start?: number;
  /** Maximum rows for this single call. */
  limit?: number;
  /** Sort by field_id (search option id). */
  sort?: number;
  order?: 'ASC' | 'DESC';
  /** If true, paginate until totalcount is reached (or maxRows is hit). */
  fetchAll?: boolean;
  /** Safety cap when fetchAll=true (default 1000). */
  maxRows?: number;
  /** Pass `expand_dropdowns=true` for resolved labels. */
  expandDropdowns?: boolean;
  /** Pass `giveItems=true` to receive raw items. */
  giveItems?: boolean;
  /** true = search ONLY deleted (trashed) rows. */
  isDeleted?: boolean;
}

export interface SearchResponse<T = Record<string, unknown>> {
  itemtype: string;
  totalcount: number;
  count: number;
  start: number;
  data: T[];
  /** Raw Content-Range header value, if present. */
  contentRange?: string;
}

const DEFAULT_PAGE = 100;
const DEFAULT_MAX_ROWS = 1000;

/**
 * Short, readable key for a search option uid.
 *   own table  "Ticket.status"                    -> "status"
 *   joined     "Ticket.ITILCategory.completename"  -> "itilcategory_completename"
 *   joined     "Ticket.Ticket_User.User.name"      -> "user_name"
 */
export function shortKeyForUid(itemtype: string, uid: string): string {
  const parts = uid.split('.');
  if (parts.length === 2 && parts[0] === itemtype) return parts[1];
  if (parts.length < 2) return uid;
  return parts.slice(-2).join('_').toLowerCase();
}

/**
 * Friendly keys for well-known search options, keyed by option id, with the
 * SQL column the option must point at (so a renumbered catalogue never gets
 * a wrong name). Actor options share one uid (requester 4 and technician 5
 * are both "Ticket.Ticket_User.User.name"), so the id is the only way to
 * tell them apart.
 */
const ITIL_COMMON_KEYS: Record<number, readonly [string, string]> = {
  1: ['name', 'name'],
  2: ['id', 'id'],
  7: ['category', 'completename'],
  12: ['status', 'status'],
  15: ['date', 'date'],
  19: ['date_mod', 'date_mod'],
  80: ['entity', 'completename'],
};

export const FRIENDLY_SEARCH_KEYS: Record<string, Record<number, readonly [string, string]>> = {
  Ticket: {
    ...ITIL_COMMON_KEYS,
    3: ['priority', 'priority'],
    4: ['requester_name', 'name'],
    5: ['technician_name', 'name'],
    8: ['technician_group', 'completename'],
    10: ['urgency', 'urgency'],
    16: ['closedate', 'closedate'],
    17: ['solvedate', 'solvedate'],
    18: ['time_to_resolve', 'time_to_resolve'],
    21: ['content', 'content'],
    65: ['observer_group', 'completename'],
    66: ['observer_name', 'name'],
    71: ['requester_group', 'completename'],
  },
  Change: ITIL_COMMON_KEYS,
  Problem: ITIL_COMMON_KEYS,
};

function friendlyKey(itemtype: string, optionId: number | undefined, field: string | undefined): string | undefined {
  if (optionId === undefined) return undefined;
  const entry = FRIENDLY_SEARCH_KEYS[itemtype]?.[optionId];
  if (!entry) return undefined;
  // Only when the option is the expected column (or unknown to the catalogue).
  return field === undefined || field === entry[1] ? entry[0] : undefined;
}

/**
 * Build the key-renaming table for a set of row keys.
 *
 * Keys are either numeric option ids (GLPI's default) or option uids (when
 * `uid_cols` is set). Numeric keys are looked up in `byId`. When two keys
 * produce the same short key (e.g. requester and technician are both
 * "user_name"), every colliding key that is not an own-table column is
 * suffixed with its option id ("user_name_4", "user_name_5"). Unknown keys are
 * kept as they are.
 */
export function buildKeyMap(
  itemtype: string,
  keys: string[],
  catalogue: SearchOptionsCatalogue
): Map<string, string> {
  const resolved = keys.map((key) => {
    const option = /^\d+$/.test(key) ? catalogue.byId.get(parseInt(key, 10)) : catalogue.byUid.get(key);
    const uid = option?.uid ?? (/^\d+$/.test(key) ? undefined : key);
    if (key === 'id') return { key, short: 'id', own: true, optionId: undefined as number | undefined };
    const numericId = option?.id ?? (/^\d+$/.test(key) ? parseInt(key, 10) : undefined);
    const friendly = friendlyKey(itemtype, numericId, option?.field);
    if (friendly) return { key, short: friendly, own: true, optionId: numericId };
    if (!uid) {
      // Option without uid: fall back to its column name, else keep the key.
      return { key, short: option?.field ?? key, own: false, optionId: option?.id };
    }
    const parts = uid.split('.');
    const own = parts.length === 2 && parts[0] === itemtype;
    return { key, short: shortKeyForUid(itemtype, uid), own, optionId: option?.id };
  });

  const counts = new Map<string, number>();
  for (const r of resolved) counts.set(r.short, (counts.get(r.short) ?? 0) + 1);

  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const r of resolved) {
    let target = r.short;
    if ((counts.get(r.short) ?? 0) > 1 && !r.own) {
      target = `${r.short}_${r.optionId ?? r.key}`;
    }
    while (used.has(target)) target = `${target}_${r.optionId ?? r.key}`;
    used.add(target);
    map.set(r.key, target);
  }
  return map;
}

/** Rename the keys of search rows to readable short keys (see buildKeyMap). */
export function mapRowKeys<T = Record<string, unknown>>(
  itemtype: string,
  rows: unknown[],
  catalogue: SearchOptionsCatalogue
): T[] {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      for (const k of Object.keys(row)) keys.add(k);
    }
  }
  if (keys.size === 0) return rows as T[];
  const keyMap = buildKeyMap(itemtype, [...keys], catalogue);
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) out[keyMap.get(k) ?? k] = v;
    return out as T;
  });
}

export class GlpiSearch {
  /**
   * @param searchOptions catalogue used to rename row keys (numeric option
   *   ids -> readable names). Without it rows are returned as GLPI sent them.
   */
  constructor(
    private http: GlpiHttp,
    private searchOptions?: SearchOptionsCache,
    /** Session user and interface, to pick the display preferences; without it, the global ones. */
    private session?: () => Promise<{ userId?: number; interface: string }>
  ) {}

  /** Map row keys through the catalogue; falls back to raw rows if it cannot be read. */
  private async readableRows<T>(itemtype: string, rows: T[]): Promise<T[]> {
    if (!this.searchOptions || rows.length === 0) return rows;
    let catalogue: SearchOptionsCatalogue;
    try {
      catalogue = await this.searchOptions.get(itemtype);
    } catch (err) {
      if (process.env.GLPI_DEBUG) {
        console.error(`[glpi-search] listSearchOptions/${itemtype} failed, raw keys kept: ${err instanceof Error ? err.message : err}`);
      }
      return rows;
    }
    const named = itemtype === 'User' ? rows : await this.withUserNames(rows, catalogue);
    return mapRowKeys<T>(itemtype, named, catalogue);
  }

  /** Display names of users by id, filled by loadUserNames; kept for the life of the process. */
  private userNames = new Map<number, string>();

  /**
   * GLPI 11 returns user columns reached through a link (Ticket requester,
   * technician, observer...) as user ids: "605", or ["10","693"] for several
   * users. Replace them with "First Last" (login when the user has no name),
   * looked up in one search per 50 unknown users. Text values (logins) are
   * left alone, and so is an id GLPI does not return (deleted user, refused).
   */
  private async withUserNames<T>(rows: T[], catalogue: SearchOptionsCatalogue): Promise<T[]> {
    const keys = [...catalogue.byId.values()]
      .filter((o) => o.table === 'glpi_users' && o.field === 'name')
      .map((o) => String(o.id));
    if (keys.length === 0) return rows;
    const isId = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v) && v !== '0';
    const ids = new Set<number>();
    for (const row of rows as Array<Record<string, unknown>>) {
      for (const k of keys) {
        const v = row?.[k];
        for (const x of Array.isArray(v) ? v : [v]) if (isId(x)) ids.add(Number(x));
      }
    }
    const missing = [...ids].filter((id) => !this.userNames.has(id));
    if (missing.length) await this.loadUserNames(missing);
    if (ids.size === 0) return rows;
    const name = (x: unknown) => (isId(x) ? this.userNames.get(Number(x)) ?? x : x);
    return (rows as Array<Record<string, unknown>>).map((row) => {
      if (!row || typeof row !== 'object') return row;
      const out = { ...row };
      for (const k of keys) {
        const v = out[k];
        if (v !== undefined && v !== null) out[k] = Array.isArray(v) ? v.map(name) : name(v);
      }
      return out;
    }) as T[];
  }

  private async loadUserNames(ids: number[]): Promise<void> {
    const option = async (column: string, fallback: number) => {
      try {
        return (await this.searchOptions?.resolveField('User', `User.${column}`)) ?? fallback;
      } catch {
        return fallback;
      }
    };
    const [idOpt, login, realname, firstname] = await Promise.all([
      option('id', 2), option('name', 1), option('realname', 34), option('firstname', 9),
    ]);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const criteria: SearchCriterion[] = chunk.map((id, j) => ({
        field: idOpt,
        searchtype: 'equals',
        value: id,
        ...(j > 0 ? { link: 'OR' as const } : {}),
      }));
      try {
        const page = await this.fetchPage<Record<string, unknown>>(
          'User',
          { criteria, forcedisplay: [idOpt, login, realname, firstname] },
          0,
          chunk.length - 1,
          false
        );
        for (const r of page.data) {
          const id = Number(r[String(idOpt)]);
          const full = [r[String(firstname)], r[String(realname)]].filter((v) => typeof v === 'string' && v.trim()).join(' ');
          const display = full || (typeof r[String(login)] === 'string' ? (r[String(login)] as string) : '');
          if (Number.isInteger(id) && display) this.userNames.set(id, display);
        }
      } catch {
        // names are a convenience: the ids stay
      }
    }
  }

  /**
   * Search-option id of the itemtype's `id` column. GLPI only returns it
   * when it is a displayed column (Ticket), and rows without it cannot be
   * opened with glpi_get_item. Option 2 is the id of nearly every itemtype,
   * used when the catalogue is unreadable.
   */
  private async idOption(itemtype: string): Promise<number> {
    if (!this.searchOptions) return 2;
    try {
      return (await this.searchOptions.resolveField(itemtype, `${itemtype}.id`)) ?? 2;
    } catch {
      return 2;
    }
  }

  private displayCache = new Map<string, Promise<number[] | undefined>>();

  /**
   * Columns GLPI shows by default for `itemtype`: the user's display
   * preferences, else the global ones, for the session's interface, by rank.
   * GLPI drops them as soon as forcedisplay is sent, so a search that adds
   * the id column sends them too. undefined when they cannot be read.
   */
  async defaultColumns(itemtype: string): Promise<number[] | undefined> {
    const session = (await this.session?.().catch(() => undefined)) ?? { interface: 'central' };
    const cacheKey = `${session.interface}:${session.userId ?? 0}:${itemtype}`;
    let cached = this.displayCache.get(cacheKey);
    if (!cached) {
      cached = (async () => {
        const params = new URLSearchParams({ 'searchText[itemtype]': `^${itemtype}$`, range: '0-499' });
        const { data } = await this.http.request<Array<Record<string, unknown>>>('DisplayPreference', { query: params });
        const rows = (Array.isArray(data) ? data : []).filter(
          (r) => r.itemtype === itemtype && (r.interface ?? 'central') === session.interface
        );
        const mine = rows.filter((r) => session.userId !== undefined && Number(r.users_id) === session.userId);
        const chosen = mine.length ? mine : rows.filter((r) => Number(r.users_id) === 0);
        return chosen.sort((x, y) => Number(x.rank) - Number(y.rank)).map((r) => Number(r.num));
      })().catch(() => undefined);
      this.displayCache.set(cacheKey, cached);
    }
    return cached;
  }

  /**
   * forcedisplay for a row search: the caller's columns, or GLPI's default
   * ones, with the id column first. Without the defaults (unreadable), the
   * caller's list is sent unchanged and GLPI picks the columns as before.
   */
  private async columns(itemtype: string, forcedisplay: readonly number[] = []): Promise<number[]> {
    const base = forcedisplay.length ? [...forcedisplay] : await this.defaultColumns(itemtype);
    if (!base) return [...forcedisplay];
    const idOption = await this.idOption(itemtype);
    return base.includes(idOption) ? base : [idOption, ...base];
  }

  /**
   * Execute a search call (single page or fetch_all loop).
   */
  async search<T = Record<string, unknown>>(
    itemtype: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse<T>> {
    if (options.fetchAll) return this.fetchAll<T>(itemtype, options);

    const start = options.start ?? 0;
    const limit = options.limit ?? DEFAULT_PAGE;
    // GLPI ranges are inclusive: "0-4" returns 5 rows.
    return this.fetchPage<T>(itemtype, options, start, start + Math.max(1, limit) - 1);
  }

  /**
   * Return only totalcount for the given criteria. Cheap probe (range=0-0).
   */
  async count(
    itemtype: string,
    criteria: SearchCriterion[] = []
  ): Promise<number> {
    const res = await this.fetchPage(itemtype, { criteria }, 0, 0, false);
    return res.totalcount;
  }

  private async fetchPage<T>(
    itemtype: string,
    options: SearchOptions,
    start: number,
    end: number,
    mapKeys = true
  ): Promise<SearchResponse<T>> {
    // Note: `uid_cols=true` is deliberately NOT sent. GLPI then keys columns
    // by uid, and distinct options sharing a uid (Ticket requester 4 and
    // technician 5 are both "Ticket.Ticket_User.User.name") collapse into a
    // single key, losing data. Numeric keys are renamed via the catalogue.
    const params = new URLSearchParams();

    (options.criteria ?? []).forEach((c, i) => {
      params.append(`criteria[${i}][field]`, String(c.field));
      params.append(`criteria[${i}][searchtype]`, c.searchtype);
      params.append(`criteria[${i}][value]`, String(c.value));
      if (i > 0 && c.link) params.append(`criteria[${i}][link]`, c.link);
    });

    const forcedisplay = mapKeys ? await this.columns(itemtype, options.forcedisplay) : [...(options.forcedisplay ?? [])];
    forcedisplay.forEach((id, i) => {
      params.append(`forcedisplay[${i}]`, String(id));
    });

    params.append('range', `${start}-${end}`);
    if (options.sort !== undefined) params.append('sort', String(options.sort));
    if (options.order) params.append('order', options.order);
    if (options.expandDropdowns) params.append('expand_dropdowns', 'true');
    if (options.giveItems) params.append('giveItems', 'true');
    if (options.isDeleted) params.append('is_deleted', '1');

    const { data, headers } = await this.http.request<{
      totalcount?: number;
      count?: number;
      data?: T[];
    }>(`search/${itemtype}`, { query: params });

    const contentRange = headers.get('content-range') ?? undefined;
    let totalcount = data.totalcount ?? 0;
    if (!totalcount && contentRange) {
      // Format: "start-end/total"
      const match = contentRange.match(/\/(\d+)$/);
      if (match) totalcount = parseInt(match[1], 10);
    }

    return {
      itemtype,
      totalcount,
      count: data.count ?? (data.data?.length ?? 0),
      start,
      data: mapKeys ? await this.readableRows<T>(itemtype, data.data ?? []) : data.data ?? [],
      contentRange,
    };
  }

  private async fetchAll<T>(
    itemtype: string,
    options: SearchOptions
  ): Promise<SearchResponse<T>> {
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    const pageSize = options.limit ?? DEFAULT_PAGE;
    let cursor = options.start ?? 0;
    const collected: T[] = [];
    let totalcount = 0;
    let contentRange: string | undefined;

    while (collected.length < maxRows) {
      const remaining = maxRows - collected.length;
      const thisPage = Math.min(pageSize, remaining);
      const end = cursor + thisPage - 1;

      const page = await this.fetchPage<T>(itemtype, options, cursor, end);
      totalcount = page.totalcount;
      contentRange = page.contentRange;

      collected.push(...page.data);
      cursor += page.data.length;

      if (page.data.length === 0) break;
      if (totalcount && cursor >= totalcount) break;
    }

    return {
      itemtype,
      totalcount,
      count: collected.length,
      start: options.start ?? 0,
      data: collected,
      contentRange,
    };
  }
}
