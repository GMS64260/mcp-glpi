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

import { GlpiError, GlpiHttp } from './http.js';
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
/** Columns asked for when GLPI has no display preference for the itemtype (see catalogueColumns). */
export const CATALOGUE_COLUMNS_MAX = 15;
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
  // Option 13 is the parent task, with the uid of the task's own name (1): it came back as "name_13".
  ProjectTask: { 13: ['parent_task', 'name'] },
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

/**
 * Rows of a `withindexes` search, `{ "12": {...}, "15": {...} }`, as a list
 * with `id`. GLPI chooses which rows make the page; inside the page they
 * come in id order (descending with order DESC), which is GLPI 11's own
 * order when no sort is asked (GLPI 10 sorts on option 1). A plain list (a GLPI that ignored the parameter) is
 * returned as it is, without ids, rather than numbered by position.
 */
function rowsById<T>(data: unknown, order?: 'ASC' | 'DESC'): T[] {
  if (Array.isArray(data)) return data as T[];
  if (!data || typeof data !== 'object') return [];
  const entries = Object.entries(data as Record<string, unknown>)
    .map(([key, row]) => [Number(key), row] as const)
    .filter(([key, row]) => Number.isInteger(key) && row !== null && typeof row === 'object')
    .sort((x, y) => x[0] - y[0]);
  if (order === 'DESC') entries.reverse();
  return entries.map(([key, row]) => ({ id: key, ...(row as Record<string, unknown>) }) as T);
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

  /** Display names ("First Last", else login) of users by id; ids GLPI does not return are absent. */
  async userDisplayNames(ids: readonly number[]): Promise<Map<number, string>> {
    const wanted = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
    const missing = wanted.filter((id) => !this.userNames.has(id));
    if (missing.length) await this.loadUserNames(missing);
    const out = new Map<number, string>();
    for (const id of wanted) {
      const name = this.userNames.get(id);
      if (name) out.set(id, name);
    }
    return out;
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
   * opened with glpi_get_item. Usually option 2, but not everywhere
   * (TicketValidation: 9 on GLPI 11, none on GLPI 10, where 2 is a comment):
   * undefined when the catalogue has no such option, 2 when it is unreadable.
   */
  private async idOption(itemtype: string): Promise<number | undefined> {
    if (!this.searchOptions) return 2;
    try {
      const catalogue = await this.searchOptions.get(itemtype);
      if (catalogue.byId.size === 0) return 2; // nothing listed: as good as unreadable
      const byUid = catalogue.byUid.get(`${itemtype}.id`);
      if (byUid) return byUid.id;
      const second = catalogue.byId.get(2);
      return second?.field === 'id' && (!second.uid || second.uid.split('.').length === 2) ? 2 : undefined;
    } catch {
      return 2;
    }
  }

  /**
   * Columns for an itemtype GLPI has no display preference for (link tables
   * such as Problem_Ticket, validations...): GLPI then returns its first
   * option only, or nothing, and the rows came back as `{}`. Every option
   * when the catalogue is small, else the itemtype's own columns, up to
   * CATALOGUE_COLUMNS_MAX. undefined when the catalogue cannot be read.
   */
  private async catalogueColumns(itemtype: string): Promise<number[] | undefined> {
    if (!this.searchOptions) return undefined;
    try {
      // GLPI answers 400 to a forced column marked nodisplay.
      const options = [...(await this.searchOptions.get(itemtype)).byId.values()].filter((o) => !o.nodisplay).sort((a, b) => a.id - b.id);
      if (options.length <= CATALOGUE_COLUMNS_MAX) return options.map((o) => o.id);
      return options
        .filter((o) => o.uid === `${itemtype}.${o.field}`)
        .slice(0, CATALOGUE_COLUMNS_MAX)
        .map((o) => o.id);
    } catch {
      return undefined;
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
   * ones (the catalogue's when GLPI has none), with the id column first.
   * Without the defaults (unreadable), the caller's list is sent unchanged
   * and GLPI picks the columns as before. `guessed` marks columns taken from
   * the catalogue: a search GLPI refuses with them is retried without.
   */
  private async columns(
    itemtype: string,
    forcedisplay: readonly number[] = []
  ): Promise<{ ids: number[]; guessed: boolean; idOption?: number }> {
    let base = forcedisplay.length ? [...forcedisplay] : await this.defaultColumns(itemtype);
    if (!base) return { ids: [...forcedisplay], guessed: false, idOption: await this.idOption(itemtype) };
    let guessed = false;
    if (base.length === 0) {
      const fromCatalogue = await this.catalogueColumns(itemtype);
      if (fromCatalogue?.length) {
        base = fromCatalogue;
        guessed = true;
      }
    }
    const idOption = await this.idOption(itemtype);
    return { ids: idOption === undefined || base.includes(idOption) ? base : [idOption, ...base], guessed, idOption };
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
    const columns = mapKeys
      ? await this.columns(itemtype, options.forcedisplay)
      : { ids: [...(options.forcedisplay ?? [])], guessed: false, idOption: 2 as number | undefined };
    // An itemtype without an id option (ProjectTask, ChangeValidation on
    // GLPI 10...) cannot return its ids as a column. `withindexes` keys the
    // rows by id instead, but a JSON object loses GLPI's row order: it is
    // asked for only when no sort is, where the order is the ids' own.
    const indexed = mapKeys && columns.idOption === undefined && options.sort === undefined;
    const query = (forcedisplay: readonly number[]) => {
      const params = new URLSearchParams();
      (options.criteria ?? []).forEach((c, i) => {
        params.append(`criteria[${i}][field]`, String(c.field));
        params.append(`criteria[${i}][searchtype]`, c.searchtype);
        params.append(`criteria[${i}][value]`, String(c.value));
        if (i > 0 && c.link) params.append(`criteria[${i}][link]`, c.link);
      });
      forcedisplay.forEach((id, i) => {
        params.append(`forcedisplay[${i}]`, String(id));
      });
      params.append('range', `${start}-${end}`);
      if (options.sort !== undefined) params.append('sort', String(options.sort));
      if (options.order) params.append('order', options.order);
      if (options.expandDropdowns) params.append('expand_dropdowns', 'true');
      if (options.giveItems) params.append('giveItems', 'true');
      if (options.isDeleted) params.append('is_deleted', '1');
      if (indexed) params.append('withindexes', 'true');
      return params;
    };
    type Page = { totalcount?: number; count?: number; data?: T[] | Record<string, T> };
    const run = (forcedisplay: readonly number[]) => this.http.request<Page>(`search/${itemtype}`, { query: query(forcedisplay) });

    let response: Awaited<ReturnType<typeof run>>;
    try {
      response = await run(columns.ids);
    } catch (err) {
      // Columns guessed from the catalogue must never cost a search that worked before.
      // Only a refused request (400) can be about the columns.
      if (!columns.guessed || !(err instanceof GlpiError) || err.status !== 400) throw err;
      response = await run(columns.idOption === undefined ? [] : [columns.idOption]);
    }
    const { data, headers } = response;
    const rows = indexed ? rowsById<T>(data.data, options.order) : Array.isArray(data.data) ? data.data : [];

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
      count: data.count ?? rows.length,
      start,
      data: mapKeys ? await this.readableRows<T>(itemtype, rows) : rows,
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
