/**
 * Projects (issue #14). glpi_get_item reads what hangs below a project in
 * GLPI through its `with` values, so no extra tool is listed:
 *
 *   Project      tasks, task_details (each task with its team and tickets),
 *                team, tickets / changes / problems (Itil_Project links),
 *                costs, items, subprojects; documents stays GLPI's own flag.
 *   ProjectTask  team, tickets.
 *
 * A Project read always carries `counts` (tasks, team, itil). A section GLPI
 * refuses is reported under `_errors` instead of coming back as an empty
 * list, so "no tasks" and "not allowed to see the tasks" differ.
 *
 * Writes go through the generic item tools (items.ts): ProjectTask and the
 * link itemtypes (ProjectTeam, ProjectTaskTeam, Itil_Project,
 * ProjectTask_Ticket) are accepted there, with update allow-lists and the
 * fields each one needs on create.
 *
 * Project and task states are a dropdown (ProjectState), not fixed codes:
 * rows get `state` (name) and `state_is_finished` from the cached list.
 */

import type { GlpiClient, ProjectState } from '../glpi-client.js';
import { GlpiError } from '../http.js';
import { STATUS_BY_ITEMTYPE, isItilItemtype } from '../itil.js';
import { compactItem, type TextOptions } from '../output.js';

/** `with` values glpi_get_item handles itself for Project / ProjectTask. */
export const PROJECT_WITH = ['tasks', 'task_details', 'team', 'costs', 'items', 'subprojects'] as const;
export type ProjectWith = (typeof PROJECT_WITH)[number];

/** Tasks whose team and tickets task_details reads (two calls per task). */
export const TASK_DETAILS_MAX = 50;
/** Linked items whose name (and ITIL status) is looked up, per section. */
export const LINK_NAMES_MAX = 100;

export const TASK_FIELDS = [
  'id', 'name', 'projects_id', 'projecttasks_id', 'projectstates_id', 'state', 'state_is_finished',
  'projecttasktypes_id', 'percent_done', 'is_milestone', 'plan_start_date', 'plan_end_date',
  'real_start_date', 'real_end_date', 'planned_duration', 'effective_duration', 'users_id',
  'content',
];

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Project states
// ---------------------------------------------------------------------------

/**
 * Add `state` and `state_is_finished` to a Project / ProjectTask row (copy).
 * `projectstates_id` is an id, or the state name when dropdowns are
 * expanded; 0 (no state) gives `state: null, state_is_finished: false`.
 */
export function withProjectState<T extends Row>(row: T, states: readonly ProjectState[]): T {
  const value = row.projectstates_id;
  if (value === undefined) return row;
  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));
  const state = numeric ? states.find((s) => s.id === Number(value)) : states.find((s) => s.name === value);
  return {
    ...row,
    state: state?.name ?? (!numeric && typeof value === 'string' ? value : null),
    state_is_finished: state?.is_finished ?? false,
  };
}

/** States for rows of `itemtype` (Project / ProjectTask only), never failing the caller. */
export async function projectStatesFor(client: GlpiClient, itemtype: string): Promise<ProjectState[] | undefined> {
  if (itemtype !== 'Project' && itemtype !== 'ProjectTask') return undefined;
  try {
    return await client.getProjectStates();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Linked items
// ---------------------------------------------------------------------------

interface LinkedRef {
  itemtype: string;
  items_id: number;
}

/** Display name of a GLPI object: "First Last (login)" for users, else name. */
function displayName(itemtype: string, obj: Row): string | null {
  if (itemtype === 'User') {
    const full = [obj.firstname, obj.realname].filter((v) => typeof v === 'string' && v).join(' ');
    if (full) return obj.name ? `${full} (${obj.name})` : full;
  }
  return typeof obj.name === 'string' ? obj.name : null;
}

const refKey = (r: LinkedRef) => `${r.itemtype}#${r.items_id}`;

/**
 * Name (and ITIL status) of linked items, one GET per distinct item, at most
 * LINK_NAMES_MAX per call; a failed lookup leaves the name null.
 */
async function describeLinks(client: GlpiClient, refs: readonly LinkedRef[]): Promise<Map<string, Row>> {
  const unique = [...new Map(refs.map((r) => [refKey(r), r])).values()].slice(0, LINK_NAMES_MAX);
  const out = new Map<string, Row>();
  await Promise.all(
    unique.map(async (ref) => {
      try {
        const obj = await client.getItem<Row>(ref.itemtype, ref.items_id, { expand_dropdowns: false });
        const info: Row = { name: displayName(ref.itemtype, obj) };
        if (isItilItemtype(ref.itemtype) && obj.status !== undefined) {
          info.status = obj.status;
          info.status_label = STATUS_BY_ITEMTYPE[ref.itemtype][Number(obj.status)] ?? null;
        }
        out.set(refKey(ref), info);
      } catch {
        out.set(refKey(ref), { name: null });
      }
    })
  );
  return out;
}

/** Link rows as `{ id, itemtype, items_id, name[, status, status_label] }`. */
async function linkRows(client: GlpiClient, rows: readonly Row[], toRef: (row: Row) => LinkedRef): Promise<Row[]> {
  const refs = rows.map(toRef);
  const names = await describeLinks(client, refs);
  return rows.map((row, i) => ({ id: row.id, ...refs[i], ...(names.get(refKey(refs[i])) ?? {}) }));
}

const polymorphic = (row: Row): LinkedRef => ({ itemtype: String(row.itemtype), items_id: Number(row.items_id) });
const ticketLink = (row: Row): LinkedRef => ({ itemtype: 'Ticket', items_id: Number(row.tickets_id) });

/** Raw rows of a sub-resource, ids not names (link targets and parents stay ids). */
const rawRows = async (client: GlpiClient, path: string) =>
  (await client.getSubItems(path, { expand_dropdowns: false })) as Row[];

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** "403 ERROR_RIGHT_MISSING ..." for a GLPI refusal, the message otherwise. */
function sectionError(err: unknown): string {
  if (err instanceof GlpiError) return [err.status, err.glpiCode, err.glpiMessage].filter(Boolean).join(' ');
  return err instanceof Error ? err.message : String(err);
}

interface SectionRun {
  out: Row;
  errors: Record<string, string>;
  jobs: Promise<void>[];
}

/** Run `read` into `out[key]`; a failure goes to `errors[key without "_"]`. */
function section(run: SectionRun, key: string, read: () => Promise<Row[]>): void {
  run.jobs.push(
    read().then(
      (rows) => {
        run.out[key] = rows;
      },
      (err) => {
        run.errors[key.replace(/^_/, '')] = sectionError(err);
      }
    )
  );
}

async function readTasks(client: GlpiClient, projectId: number, states: readonly ProjectState[], details: boolean, text: TextOptions) {
  const rows = await rawRows(client, `Project/${projectId}/ProjectTask`);
  const tasks = rows.map((r) => compactItem('ProjectTask', withProjectState(r, states), { ...text, fields: TASK_FIELDS }));
  if (!details) return tasks;
  const detailed = await Promise.all(
    tasks.slice(0, TASK_DETAILS_MAX).map(async (task) => {
      const [team, tickets] = await Promise.all([
        rawRows(client, `ProjectTask/${task.id}/ProjectTaskTeam`).then((r) => linkRows(client, r, polymorphic)),
        rawRows(client, `ProjectTask/${task.id}/ProjectTask_Ticket`).then((r) => linkRows(client, r, ticketLink)),
      ]);
      return { ...task, team, tickets };
    })
  );
  return [...detailed, ...tasks.slice(TASK_DETAILS_MAX)];
}

/** Itil_Project links of a project, read once for tickets / changes / problems. */
function itilLinks(client: GlpiClient, projectId: number): () => Promise<Row[]> {
  let rows: Promise<Row[]> | undefined;
  return () => (rows ??= rawRows(client, `Project/${projectId}/Itil_Project`).then((r) => linkRows(client, r, polymorphic)));
}

const ITIL_WITH = { tickets: 'Ticket', changes: 'Change', problems: 'Problem' } as const;

/**
 * Sections of a Project / ProjectTask read for glpi_get_item, keyed `_tasks`,
 * `_team`, `_tickets`... like GLPI's own `with_*` data, plus `_errors`, and
 * `counts` on a project. `flags` are the caller's `with` values; the ones
 * handled here are removed from it (the rest go to GLPI).
 */
export async function readProjectSections(
  client: GlpiClient,
  itemtype: 'Project' | 'ProjectTask',
  id: number,
  flags: Set<string>,
  states: readonly ProjectState[],
  text: TextOptions = {}
): Promise<Row> {
  const run: SectionRun = { out: {}, errors: {}, jobs: [] };
  const take = (flag: string) => flags.delete(flag);

  if (itemtype === 'ProjectTask') {
    if (take('team')) section(run, '_team', async () => linkRows(client, await rawRows(client, `ProjectTask/${id}/ProjectTaskTeam`), polymorphic));
    if (take('tickets')) section(run, '_tickets', async () => linkRows(client, await rawRows(client, `ProjectTask/${id}/ProjectTask_Ticket`), ticketLink));
  } else {
    const details = take('task_details');
    if (take('tasks') || details) section(run, '_tasks', () => readTasks(client, id, states, details, text));
    if (take('team')) section(run, '_team', async () => linkRows(client, await rawRows(client, `Project/${id}/ProjectTeam`), polymorphic));
    const itil = itilLinks(client, id);
    for (const [flag, type] of Object.entries(ITIL_WITH)) {
      if (take(flag)) section(run, `_${flag}`, async () => (await itil()).filter((l) => l.itemtype === type));
    }
    if (take('items')) section(run, '_items', async () => linkRows(client, await rawRows(client, `Project/${id}/Item_Project`), polymorphic));
    if (take('costs')) {
      section(run, '_costs', async () =>
        ((await client.getSubItems(`Project/${id}/ProjectCost`)) as Row[]).map((r) =>
          compactItem('ProjectCost', r, { ...text, fields: ['id', 'name', 'cost', 'begin_date', 'end_date', 'budgets_id', 'comment'] })
        )
      );
    }
    if (take('subprojects')) {
      section(run, '_subprojects', async () =>
        (await rawRows(client, `Project/${id}/Project`)).map((r) =>
          compactItem('Project', withProjectState(r, states), { fields: ['id', 'name', 'code', 'state', 'state_is_finished', 'percent_done', 'plan_end_date'] })
        )
      );
    }
  }
  await Promise.all(run.jobs);

  const out: Row = { ...run.out };
  if (itemtype === 'Project') out.counts = await projectCounts(client, id, out);
  if (Object.keys(run.errors).length) out._errors = run.errors;
  return out;
}

/** tasks / team / itil counts, from the sections read or by count; open_tasks with the tasks. */
async function projectCounts(client: GlpiClient, id: number, sections: Row): Promise<Row> {
  const counts: Row = {};
  const tasks = sections._tasks as Row[] | undefined;
  const subs = { tasks: 'ProjectTask', team: 'ProjectTeam', itil: 'Itil_Project' } as const;
  await Promise.all(
    (Object.keys(subs) as (keyof typeof subs)[]).map(async (key) => {
      const loaded = key === 'tasks' ? tasks : key === 'team' ? (sections._team as Row[] | undefined) : undefined;
      if (loaded) {
        counts[key] = loaded.length;
        return;
      }
      try {
        counts[key] = await client.countSubItems(`Project/${id}/${subs[key]}`);
      } catch {
        // a refused count is left out; the section itself reports the error
      }
    })
  );
  if (tasks) counts.open_tasks = tasks.filter((t) => t.state_is_finished !== true).length;
  return counts;
}
