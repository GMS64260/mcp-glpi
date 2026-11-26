/**
 * Who works on a ticket, change or problem, and what it is linked to
 * (issue #21).
 *
 * GLPI keeps both outside the object itself, in link tables read as
 * sub-resources of the object:
 *
 *   actors   Ticket_User / Group_Ticket / Supplier_Ticket,
 *            Change_User / Change_Group / Change_Supplier,
 *            Problem_User / Group_Problem / Problem_Supplier
 *            (`type`: 1 requester, 2 assigned, 3 observer);
 *   links    Problem_Ticket, Change_Ticket, Change_Problem, and Ticket_Ticket
 *            for a ticket.
 *
 * glpi_get_ticket / glpi_get_problem / glpi_get_change return them as
 * `actors` (by role, ids and names) and `links` (ids, names and status).
 * A list GLPI refuses goes to `_errors` under the name of its link itemtype,
 * so "nobody assigned" and "not allowed to see" differ.
 *
 * glpi_assign_ticket writes the actors: add, replace or remove.
 */

import type { GlpiClient } from '../glpi-client.js';
import { TICKET_LINK_TYPES, type TicketRelation } from '../glpi-client.js';
import { ArgumentError, describeError } from '../errors.js';
import { type ItilItemtype, STATUS_BY_ITEMTYPE } from '../itil.js';
import { rawRows, sectionError } from './projects.js';

type Row = Record<string, unknown>;

export const ACTOR_ROLES = ['requester', 'assigned', 'observer'] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];
/** GLPI `CommonITILActor` type of each role. */
export const ACTOR_TYPE: Record<ActorRole, number> = { requester: 1, assigned: 2, observer: 3 };

type ActorKind = 'User' | 'Group' | 'Supplier';

interface ActorLink {
  /** Link itemtype, e.g. Ticket_User. */
  link: string;
  kind: ActorKind;
  /** Column naming the actor. */
  key: string;
}

/** Actor link itemtypes of each ITIL object, and the column that points to the object. */
export const ACTOR_LINKS: Record<ItilItemtype, { fk: string; links: readonly ActorLink[] }> = {
  Ticket: {
    fk: 'tickets_id',
    links: [
      { link: 'Ticket_User', kind: 'User', key: 'users_id' },
      { link: 'Group_Ticket', kind: 'Group', key: 'groups_id' },
      { link: 'Supplier_Ticket', kind: 'Supplier', key: 'suppliers_id' },
    ],
  },
  Change: {
    fk: 'changes_id',
    links: [
      { link: 'Change_User', kind: 'User', key: 'users_id' },
      { link: 'Change_Group', kind: 'Group', key: 'groups_id' },
      { link: 'Change_Supplier', kind: 'Supplier', key: 'suppliers_id' },
    ],
  },
  Problem: {
    fk: 'problems_id',
    links: [
      { link: 'Problem_User', kind: 'User', key: 'users_id' },
      { link: 'Group_Problem', kind: 'Group', key: 'groups_id' },
      { link: 'Problem_Supplier', kind: 'Supplier', key: 'suppliers_id' },
    ],
  },
};

interface ItilLink {
  /** Key under `links`. */
  key: 'tickets' | 'problems' | 'changes';
  link: string;
  /** Column of the link row naming the other object. */
  fk: string;
  itemtype: ItilItemtype;
}

export const ITIL_LINKS: Record<ItilItemtype, readonly ItilLink[]> = {
  Ticket: [
    { key: 'problems', link: 'Problem_Ticket', fk: 'problems_id', itemtype: 'Problem' },
    { key: 'changes', link: 'Change_Ticket', fk: 'changes_id', itemtype: 'Change' },
  ],
  Problem: [
    { key: 'tickets', link: 'Problem_Ticket', fk: 'tickets_id', itemtype: 'Ticket' },
    { key: 'changes', link: 'Change_Problem', fk: 'changes_id', itemtype: 'Change' },
  ],
  Change: [
    { key: 'tickets', link: 'Change_Ticket', fk: 'tickets_id', itemtype: 'Ticket' },
    { key: 'problems', link: 'Change_Problem', fk: 'problems_id', itemtype: 'Problem' },
  ],
};

/** Linked objects whose name and status are looked up, per kind (the rest keep their id only). */
export const LINK_SUMMARY_MAX = 200;
const SUMMARY_CHUNK = 50;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const NAME_TTL_MS = 60 * 60 * 1000;
const nameCache = new WeakMap<GlpiClient, Map<string, { at: number; name: string }>>();

/** Name of a group or supplier, one GET per item and per hour; null when it cannot be read. */
async function itemName(client: GlpiClient, itemtype: string, id: number): Promise<string | null> {
  let cache = nameCache.get(client);
  if (!cache) nameCache.set(client, (cache = new Map()));
  const key = `${itemtype}#${id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.name;
  try {
    const obj = await client.getItem<Row>(itemtype, id, { expand_dropdowns: false });
    const name = [obj.completename, obj.name].find((v) => typeof v === 'string' && v) as string | undefined;
    if (!name) return null;
    cache.set(key, { at: Date.now(), name });
    return name;
  } catch {
    return null;
  }
}

async function actorNames(client: GlpiClient, kind: ActorKind, ids: readonly number[]): Promise<Map<number, string>> {
  const wanted = [...new Set(ids)].filter((id) => id > 0);
  if (wanted.length === 0) return new Map();
  if (kind === 'User') {
    const names = await client.search.userDisplayNames(wanted);
    if (names.size === wanted.length) return names;
    // A profile that cannot search users may still read one.
    await Promise.all(
      wanted
        .filter((id) => !names.has(id))
        .map(async (id) => {
          try {
            const u = await client.getItem<Row>('User', id, { expand_dropdowns: false });
            const full = [u.firstname, u.realname].filter((v) => typeof v === 'string' && v).join(' ');
            const name = full || (typeof u.name === 'string' ? u.name : '');
            if (name) names.set(id, name);
          } catch {
            // the id stays without a name
          }
        })
    );
    return names;
  }
  const out = new Map<number, string>();
  await Promise.all(
    wanted.map(async (id) => {
      const name = await itemName(client, kind, id);
      if (name) out.set(id, name);
    })
  );
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface Actor {
  itemtype: ActorKind;
  id: number;
  name: string | null;
  /** Requester known by e-mail only (users_id 0). */
  email?: string;
}

export type Actors = Record<ActorRole, Actor[]>;

const roleOf = (type: unknown): ActorRole | undefined => ACTOR_ROLES.find((r) => ACTOR_TYPE[r] === Number(type));

async function readActors(client: GlpiClient, itemtype: ItilItemtype, id: number, errors: Record<string, string>): Promise<Actors> {
  const actors: Actors = { requester: [], assigned: [], observer: [] };
  const lists = await Promise.all(
    ACTOR_LINKS[itemtype].links.map(async (l) => {
      try {
        const rows = await rawRows(client, `${itemtype}/${id}/${l.link}`);
        const names = await actorNames(client, l.kind, rows.map((r) => Number(r[l.key])));
        return { l, rows, names };
      } catch (err) {
        errors[l.link] = sectionError(err);
        return { l, rows: [] as Row[], names: new Map<number, string>() };
      }
    })
  );
  for (const { l, rows, names } of lists) {
    for (const row of rows) {
      const role = roleOf(row.type);
      if (!role) continue;
      const actorId = Number(row[l.key]);
      const actor: Actor = { itemtype: l.kind, id: actorId, name: names.get(actorId) ?? null };
      if (actorId === 0 && typeof row.alternative_email === 'string' && row.alternative_email) actor.email = row.alternative_email;
      actors[role].push(actor);
    }
  }
  return actors;
}

/** Name and status of ITIL objects by id, one search per 50; ids GLPI does not return are absent. */
async function itilSummaries(client: GlpiClient, itemtype: ItilItemtype, ids: readonly number[]): Promise<Map<number, Row>> {
  const out = new Map<number, Row>();
  const wanted = [...new Set(ids)].slice(0, LINK_SUMMARY_MAX);
  if (wanted.length === 0) return out;
  const option = async (column: string, fallback: number) => {
    try {
      return (await client.searchOptions.resolveField(itemtype, `${itemtype}.${column}`)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const [idOpt, nameOpt, statusOpt] = await Promise.all([option('id', 2), option('name', 1), option('status', 12)]);
  for (let i = 0; i < wanted.length; i += SUMMARY_CHUNK) {
    const chunk = wanted.slice(i, i + SUMMARY_CHUNK);
    try {
      const page = await client.search.search<Row>(itemtype, {
        criteria: chunk.map((value, j) => ({ field: idOpt, searchtype: 'equals' as const, value, ...(j > 0 ? { link: 'OR' as const } : {}) })),
        forcedisplay: [idOpt, nameOpt, statusOpt],
        limit: chunk.length,
      });
      for (const row of page.data) {
        // Readable keys, or option ids when the catalogue could not be read.
        const rowId = Number(row.id ?? row[String(idOpt)]);
        if (!Number.isInteger(rowId)) continue;
        const info: Row = {};
        const name = row.name ?? row[String(nameOpt)];
        if (typeof name === 'string') info.name = name;
        const status = Number(row.status ?? row[String(statusOpt)]);
        if (Number.isInteger(status) && status > 0) {
          info.status = status;
          info.status_label = STATUS_BY_ITEMTYPE[itemtype][status] ?? null;
        }
        out.set(rowId, info);
      }
    } catch {
      // names are a convenience: the ids stay
    }
  }
  return out;
}

const RELATION_BY_CODE = new Map<number, TicketRelation>(
  (Object.entries(TICKET_LINK_TYPES) as [TicketRelation, number][]).map(([relation, code]) => [code, relation])
);
const INVERSE: Partial<Record<TicketRelation, TicketRelation>> = { child_of: 'parent_of', parent_of: 'child_of' };

/**
 * Tickets linked to a ticket, as "this ticket <relation> other".
 * `Ticket/{id}/Ticket_Ticket` returns every link of the database (the table
 * has no `tickets_id` column for GLPI to filter on), so both sides are read
 * from the list with an exact filter.
 */
async function ticketTicketLinks(client: GlpiClient, id: number): Promise<Array<{ id: number; relation: string }>> {
  const side = (column: string) =>
    client.getSubItems('Ticket_Ticket', { expand_dropdowns: false, searchText: { [column]: `^${id}$` } }) as Promise<Row[]>;
  const [mine, theirs] = await Promise.all([side('tickets_id_1'), side('tickets_id_2')]);
  const out: Array<{ id: number; relation: string }> = [];
  for (const row of mine) {
    const relation = RELATION_BY_CODE.get(Number(row.link)) ?? 'link';
    out.push({ id: Number(row.tickets_id_2), relation });
  }
  for (const row of theirs) {
    const relation = RELATION_BY_CODE.get(Number(row.link)) ?? 'link';
    out.push({ id: Number(row.tickets_id_1), relation: INVERSE[relation] ?? relation });
  }
  return out.filter((l) => Number.isInteger(l.id) && l.id !== id);
}

async function readLinks(client: GlpiClient, itemtype: ItilItemtype, id: number, errors: Record<string, string>): Promise<Row> {
  const links: Row = {};
  const jobs: Promise<void>[] = ITIL_LINKS[itemtype].map(async (l) => {
    try {
      const rows = await rawRows(client, `${itemtype}/${id}/${l.link}`);
      const ids = rows.map((r) => Number(r[l.fk])).filter((n) => Number.isInteger(n) && n > 0);
      const info = await itilSummaries(client, l.itemtype, ids);
      links[l.key] = ids.map((linkedId) => ({ id: linkedId, ...(info.get(linkedId) ?? {}) }));
    } catch (err) {
      errors[l.link] = sectionError(err);
    }
  });
  if (itemtype === 'Ticket') {
    jobs.push(
      (async () => {
        try {
          const rows = await ticketTicketLinks(client, id);
          const info = await itilSummaries(client, 'Ticket', rows.map((r) => r.id));
          links.tickets = rows.map((r) => ({ ...r, ...(info.get(r.id) ?? {}) }));
        } catch (err) {
          errors.Ticket_Ticket = sectionError(err);
        }
      })()
    );
  }
  await Promise.all(jobs);
  // Same order whatever answered first.
  const ordered: Row = {};
  for (const key of ['tickets', 'problems', 'changes']) if (links[key] !== undefined) ordered[key] = links[key];
  return ordered;
}

/** `actors`, `links` and, when GLPI refused a list, `_errors` of a ticket, change or problem. */
export async function readItilRelations(client: GlpiClient, itemtype: ItilItemtype, id: number): Promise<Row> {
  const errors: Record<string, string> = {};
  const [actors, links] = await Promise.all([readActors(client, itemtype, id, errors), readLinks(client, itemtype, id, errors)]);
  return { actors, links, ...(Object.keys(errors).length ? { _errors: errors } : {}) };
}

// ---------------------------------------------------------------------------
// Writing actors
// ---------------------------------------------------------------------------

export const ACTOR_MODES = ['add', 'replace', 'remove'] as const;
export type ActorMode = (typeof ACTOR_MODES)[number];

export interface ActorChange {
  userId?: number;
  groupId?: number;
  /** 1 requester, 2 assigned (default), 3 observer. */
  type?: number;
  mode?: ActorMode;
}

interface LinkRef {
  link: string;
  id: number;
}

/**
 * Add, replace or remove a user and/or a group among the actors of a ticket,
 * change or problem.
 *
 *   add      one more actor of the role (GLPI's own behaviour);
 *   replace  the user takes the place of the role's users, the group of its
 *            groups: every add comes before the first removal, so the object
 *            is never left without assignee and a refused add removes
 *            nobody; a requester known by e-mail only is kept;
 *   remove   takes the actor off the role; an actor that does not hold it is
 *            an error naming the ones that do.
 *
 * GLPI has no transaction over these calls: a failure after the first write
 * is reported with what was already applied.
 */
export async function changeActors(
  client: GlpiClient,
  itemtype: ItilItemtype,
  id: number,
  change: ActorChange
): Promise<{ added: LinkRef[]; removed: LinkRef[] }> {
  const type = change.type ?? ACTOR_TYPE.assigned;
  const role = roleOf(type);
  if (!role) throw new ArgumentError('type must be 1 (requester), 2 (assigned) or 3 (observer)');
  const mode = change.mode ?? 'add';
  const { fk, links } = ACTOR_LINKS[itemtype];
  const targets = [
    change.userId ? { ...links[0], value: change.userId } : undefined,
    change.groupId ? { ...links[1], value: change.groupId } : undefined,
  ].filter((t): t is ActorLink & { value: number } => t !== undefined);
  if (targets.length === 0) throw new ArgumentError('user_id or group_id required');

  // Everything is read before the first write: a wrong id changes nothing.
  const current = await Promise.all(
    targets.map(async (t) =>
      mode === 'add' ? [] : (await rawRows(client, `${itemtype}/${id}/${t.link}`)).filter((r) => Number(r.type) === type)
    )
  );
  if (mode === 'remove') {
    targets.forEach((t, i) => {
      if (current[i].some((r) => Number(r[t.key]) === t.value)) return;
      const holders = current[i].map((r) => r[t.key]).join(', ') || 'none';
      throw new ArgumentError(`${t.kind} ${t.value} is not ${role} of ${itemtype} ${id} (${t.kind} ids with that role: ${holders})`);
    });
  }

  const added: LinkRef[] = [];
  const removed: LinkRef[] = [];
  try {
    // Every add before the first removal: a refused add removes nobody.
    for (const [i, t] of targets.entries()) {
      const held = current[i].some((r) => Number(r[t.key]) === t.value);
      if (mode === 'add' || (mode === 'replace' && !held)) {
        const created = await client.createItem(t.link, { [fk]: id, [t.key]: t.value, type });
        added.push({ link: t.link, id: created?.id });
      }
    }
    if (mode !== 'add') {
      for (const [i, t] of targets.entries()) {
        // replace keeps a requester known by e-mail only (users_id 0): it is nobody's seat to take.
        const leaving = current[i].filter((r) =>
          mode === 'remove' ? Number(r[t.key]) === t.value : Number(r[t.key]) !== t.value && Number(r[t.key]) > 0
        );
        for (const row of leaving) {
          await client.deleteItem(t.link, Number(row.id));
          removed.push({ link: t.link, id: Number(row.id) });
        }
      }
    }
  } catch (err) {
    if (added.length + removed.length === 0) throw err;
    // The writes already made stay: say so, or the caller believes nothing changed.
    const done = (refs: LinkRef[]) => refs.map((r) => `${r.link} ${r.id}`).join(', ') || 'none';
    throw new Error(
      `${describeError(err)}\nPartly applied on ${itemtype} ${id} before this failure: added ${done(added)}; removed ${done(removed)}. ` +
        'Read the actors again before retrying.'
    );
  }
  return { added, removed };
}
