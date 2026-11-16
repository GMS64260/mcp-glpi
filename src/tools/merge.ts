/**
 * glpi_merge_tickets: GLPI's own "merge" massive action, which the REST API
 * does not expose, rebuilt from plain API calls.
 *
 * For each source ticket, in order:
 *   1. copy to the target: the source description (as a followup), then
 *      followups, tasks, document links and actors, as asked by `copy`;
 *   2. link the source as a duplicate of the target;
 *   3. add a followup on the source pointing to the target;
 *   4. trash the source (GLPI's behaviour, recoverable), close it, or keep it.
 *
 * Every ticket is read before the first write, so a wrong id changes
 * nothing. A source whose copy fails is neither linked nor trashed: its
 * report says what was copied already, and the next sources still run.
 * dry_run reads everything and returns the counts without writing.
 */

import { z } from 'zod';
import type { GlpiClient } from '../glpi-client.js';
import { ArgumentError } from '../errors.js';
import { GlpiError } from '../http.js';
import { decodeEntities, text } from '../output.js';
import { defineTool, type ToolDef } from './registry.js';
import { hidden, id, optBool, optStr } from './common.js';

type Row = Record<string, unknown>;

export const MERGE_PARTS = ['followups', 'tasks', 'documents', 'actors'] as const;
export type MergePart = (typeof MERGE_PARTS)[number];

export const SOURCE_ACTIONS = ['trash', 'close', 'keep'] as const;
export type SourceAction = (typeof SOURCE_ACTIONS)[number];

/** Sources per call: each one costs a dozen requests or more. */
export const MERGE_MAX_SOURCES = 20;

/** Actor link itemtypes of a ticket and the column naming the actor. */
const ACTOR_LINKS = [
  { itemtype: 'Ticket_User', key: 'users_id', extra: ['use_notification', 'alternative_email'] },
  { itemtype: 'Group_Ticket', key: 'groups_id', extra: [] },
  { itemtype: 'Supplier_Ticket', key: 'suppliers_id', extra: ['use_notification', 'alternative_email'] },
] as const;

/** Task columns copied as they are (ids, not names). */
const TASK_COLUMNS = [
  'is_private', 'actiontime', 'state', 'users_id', 'users_id_tech', 'groups_id_tech', 'begin', 'end',
  'taskcategories_id', 'date',
];

const errorText = (err: unknown): string => {
  if (err instanceof GlpiError) return [err.status, err.glpiCode, err.glpiMessage].filter(Boolean).join(' ');
  return err instanceof Error ? err.message : String(err);
};

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "[#12 · 2026-11-03 10:15]": origin line put before every copied text. */
export function originLine(sourceId: number, date: unknown, title?: unknown): string {
  const when = typeof date === 'string' && date ? ` · ${date.slice(0, 16)}` : '';
  const name = typeof title === 'string' && title ? ` ${escapeHtml(decodeEntities(title))}` : '';
  return `<p><strong>[#${sourceId}${name}${when}]</strong></p>`;
}

/**
 * Stored HTML to send back. GLPI 10 can return it entity-encoded
 * (`&lt;p&gt;`); posted as is, it would show as literal tags: decode it
 * once, as GLPI's own forms would have sent it.
 */
export function storedHtml(value: unknown): string {
  const s = typeof value === 'string' ? value : '';
  return /&lt;\/?[a-z]/i.test(s) && !/<\/?[a-z]/i.test(s) ? decodeEntities(s) : s;
}

/** Keep the columns that are set: GLPI rejects null dates and 0 is a valid "none". */
function pick(row: Row, columns: readonly string[]): Row {
  const out: Row = {};
  for (const c of columns) if (row[c] !== undefined && row[c] !== null && row[c] !== '') out[c] = row[c];
  return out;
}

interface SourceData {
  ticket: Row;
  followups: Row[];
  tasks: Row[];
  documents: Row[];
  actors: Array<{ itemtype: string; key: string; rows: Row[] }>;
}

interface TargetLinks {
  documents: Set<number>;
  actors: Set<string>;
}

const actorKey = (itemtype: string, actor: unknown, type: unknown, email?: unknown) =>
  `${itemtype}:${actor}:${type}:${Number(actor) === 0 ? String(email ?? '') : ''}`;

async function rows(client: GlpiClientLike, path: string): Promise<Row[]> {
  return (await client.getSubItems(path, { expand_dropdowns: false })) as Row[];
}

type GlpiClientLike = Pick<
  GlpiClient,
  'getItem' | 'getSubItems' | 'createItem' | 'updateItem' | 'deleteItem' | 'linkTickets'
>;

async function readSource(client: GlpiClientLike, sourceId: number, parts: ReadonlySet<MergePart>): Promise<SourceData> {
  const none = async () => [] as Row[];
  const [ticket, followups, tasks, documents, ...actorRows] = await Promise.all([
    client.getItem<Row>('Ticket', sourceId, { expand_dropdowns: false }),
    parts.has('followups') ? rows(client, `Ticket/${sourceId}/ITILFollowup`) : none(),
    parts.has('tasks') ? rows(client, `Ticket/${sourceId}/TicketTask`) : none(),
    parts.has('documents') ? rows(client, `Ticket/${sourceId}/Document_Item`) : none(),
    ...ACTOR_LINKS.map((l) => (parts.has('actors') ? rows(client, `Ticket/${sourceId}/${l.itemtype}`) : none())),
  ]);
  return {
    ticket,
    followups,
    tasks,
    documents,
    actors: ACTOR_LINKS.map((l, i) => ({ itemtype: l.itemtype, key: l.key, rows: actorRows[i] })),
  };
}

async function readTargetLinks(client: GlpiClientLike, targetId: number, parts: ReadonlySet<MergePart>): Promise<TargetLinks> {
  const links: TargetLinks = { documents: new Set(), actors: new Set() };
  if (parts.has('documents')) {
    for (const r of await rows(client, `Ticket/${targetId}/Document_Item`)) links.documents.add(Number(r.documents_id));
  }
  if (parts.has('actors')) {
    for (const l of ACTOR_LINKS) {
      for (const r of await rows(client, `Ticket/${targetId}/${l.itemtype}`)) {
        links.actors.add(actorKey(l.itemtype, r[l.key], r.type, r.alternative_email));
      }
    }
  }
  return links;
}

/** Counts of what merging `src` would copy (dry run), already-linked items excluded. */
function plannedCounts(src: SourceData, target: TargetLinks, parts: ReadonlySet<MergePart>): Row {
  const counts: Row = { description: 1 };
  if (parts.has('followups')) counts.followups = src.followups.length;
  if (parts.has('tasks')) counts.tasks = src.tasks.length;
  if (parts.has('documents')) counts.documents = src.documents.filter((d) => !target.documents.has(Number(d.documents_id))).length;
  if (parts.has('actors')) {
    counts.actors = src.actors.reduce(
      (n, a) => n + a.rows.filter((r) => !target.actors.has(actorKey(a.itemtype, r[a.key], r.type, r.alternative_email))).length,
      0
    );
  }
  return counts;
}

interface MergeArgs {
  targetId: number;
  sourceId: number;
  action: SourceAction;
  comment?: string;
}

/** Copy, link and trash/close one source; never throws, reports instead. */
async function mergeOne(client: GlpiClientLike, src: SourceData, target: TargetLinks, a: MergeArgs): Promise<Row> {
  const { targetId, sourceId } = a;
  const copied: Record<string, number> = {};
  const report: Row = { source_id: sourceId, copied };
  const count = (key: string) => {
    copied[key] = (copied[key] ?? 0) + 1;
  };
  let step = 'description';
  try {
    const t = src.ticket;
    await client.createItem('ITILFollowup', {
      itemtype: 'Ticket',
      items_id: targetId,
      content: originLine(sourceId, t.date, t.name) + storedHtml(t.content),
      is_private: 0,
      ...pick(t, ['requesttypes_id', 'date']),
      ...(Number(t.users_id_recipient) > 0 ? { users_id: t.users_id_recipient } : {}),
    });
    count('description');

    step = 'followups';
    for (const f of src.followups) {
      await client.createItem('ITILFollowup', {
        itemtype: 'Ticket',
        items_id: targetId,
        content: originLine(sourceId, f.date) + storedHtml(f.content),
        ...pick(f, ['is_private', 'requesttypes_id', 'users_id', 'date']),
      });
      count('followups');
    }

    step = 'tasks';
    for (const task of src.tasks) {
      await client.createItem('TicketTask', {
        tickets_id: targetId,
        content: originLine(sourceId, task.date) + storedHtml(task.content),
        ...pick(task, TASK_COLUMNS),
      });
      count('tasks');
    }

    step = 'documents';
    for (const d of src.documents) {
      const docId = Number(d.documents_id);
      if (target.documents.has(docId)) continue;
      await client.createItem('Document_Item', { documents_id: docId, itemtype: 'Ticket', items_id: targetId });
      target.documents.add(docId);
      count('documents');
    }

    step = 'actors';
    const links = ACTOR_LINKS.map((l) => ({ ...l, rows: src.actors.find((x) => x.itemtype === l.itemtype)?.rows ?? [] }));
    for (const l of links) {
      for (const r of l.rows) {
        const key = actorKey(l.itemtype, r[l.key], r.type, r.alternative_email);
        if (target.actors.has(key)) continue;
        await client.createItem(l.itemtype, { tickets_id: targetId, [l.key]: r[l.key], type: r.type, ...pick(r, l.extra) });
        target.actors.add(key);
        count('actors');
      }
    }
  } catch (err) {
    report.error = `copy of ${step} failed: ${errorText(err)}`;
    report.source_left_as_is = true;
    return report;
  }

  const warnings: string[] = [];
  try {
    const link = await client.linkTickets(sourceId, targetId, 'duplicate');
    report.link_id = link.id;
  } catch (err) {
    warnings.push(`duplicate link: ${errorText(err)}`);
  }
  try {
    await client.createItem('ITILFollowup', {
      itemtype: 'Ticket',
      items_id: sourceId,
      content: a.comment ?? `Merged into ticket #${targetId}.`,
      is_private: 0,
    });
  } catch (err) {
    warnings.push(`followup on the source: ${errorText(err)}`);
  }
  try {
    if (a.action === 'trash') await client.deleteItem('Ticket', sourceId, false);
    else if (a.action === 'close') await client.updateItem('Ticket', sourceId, { status: 6 });
    report.source = a.action === 'trash' ? 'trashed' : a.action === 'close' ? 'closed' : 'kept';
  } catch (err) {
    report.source = 'kept';
    warnings.push(`${a.action} the source: ${errorText(err)}`);
  }
  if (warnings.length) report.warnings = warnings;
  return report;
}

const mergeTickets = defineTool({
  name: 'glpi_merge_tickets',
  title: 'Merge tickets',
  toolset: 'tickets',
  description:
    'GLPI merge: copy each source (description, followups, tasks, documents, actors) into target_id, link it as duplicate, trash it. Try dry_run first.',
  annotations: { destructiveHint: true },
  inputSchema: {
    target_id: id('Ticket kept'),
    source_ids: z
      .array(z.preprocess((v) => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v), z.number().int().positive()))
      .min(1)
      .max(MERGE_MAX_SOURCES)
      .describe(`Max ${MERGE_MAX_SOURCES}`),
    copy: z.array(z.enum(MERGE_PARTS)).optional().describe('Default all'),
    source_action: z.enum(SOURCE_ACTIONS).optional().describe('Default trash'),
    comment: hidden(optStr('Followup left on each source')),
    dry_run: optBool('Count only, no write'),
  },
  handler: async ({ client }, a) => {
    const sources = [...new Set(a.source_ids)];
    if (sources.includes(a.target_id)) throw new ArgumentError('target_id cannot be one of source_ids');
    const parts = new Set<MergePart>(a.copy ?? MERGE_PARTS);
    const action: SourceAction = a.source_action ?? 'trash';

    // Read everything first: a wrong id or a refused read changes nothing.
    const read = async (ticketId: number, fn: () => Promise<unknown>) => {
      try {
        return await fn();
      } catch (err) {
        throw new ArgumentError(`ticket ${ticketId} cannot be read: ${errorText(err)}`);
      }
    };
    const target = (await read(a.target_id, () => client.getItem<Row>('Ticket', a.target_id, { expand_dropdowns: false }))) as Row;
    if (Number(target.is_deleted) === 1) throw new ArgumentError(`target ticket ${a.target_id} is in the trash`);
    const data: SourceData[] = [];
    for (const s of sources) data.push((await read(s, () => readSource(client, s, parts))) as SourceData);
    const links = await readTargetLinks(client, a.target_id, parts);

    if (a.dry_run) {
      return text({
        dry_run: true,
        target_id: a.target_id,
        source_action: action,
        sources: data.map((src, i) => ({ source_id: sources[i], name: src.ticket.name, would_copy: plannedCounts(src, links, parts) })),
      });
    }

    const results: Row[] = [];
    for (let i = 0; i < sources.length; i++) {
      results.push(await mergeOne(client, data[i], links, { targetId: a.target_id, sourceId: sources[i], action, comment: a.comment }));
    }
    const failed = results.filter((r) => r.error).length;
    return text({ success: failed === 0, target_id: a.target_id, merged: results.length - failed, failed, sources: results });
  },
});

export const MERGE_TOOLS: ToolDef[] = [mergeTickets];
