/**
 * Generic CRUD over GLPI itemtypes: assets, KB, contracts, suppliers,
 * locations, entities, projects, documents, groups, categories...
 */

import { z } from 'zod';
import { ArgumentError } from '../errors.js';
import type { GetOptions } from '../glpi-client.js';
import { COMPACT_FIELDS, compactItem, listEnvelope, text } from '../output.js';
import { advertisedAs, defineTool, type ToolDef } from './registry.js';
import { ITIL_UPDATE_FIELDS } from './itil.js';
import { TICKET_UPDATE_FIELDS, checkPurge } from './tickets.js';
import { PROJECT_WITH, projectStatesFor, readProjectSections, withProjectState } from './projects.js';
import { fields, id, listShape, optBool, optInt, textShape, toListOptions, verbose } from './common.js';

const invalid = (message: string) => new ArgumentError(message);

export const ITEMTYPES = [
  'Computer', 'Software', 'NetworkEquipment', 'Printer', 'Monitor', 'Phone', 'Peripheral',
  'Rack', 'Enclosure', 'PDU', 'KnowbaseItem', 'Contract', 'Supplier', 'Location', 'Entity',
  'Project', 'Document', 'Group', 'ITILCategory', 'Ticket', 'Problem', 'Change', 'User', 'Profile',
  'ProjectTask', 'ProjectState',
] as const;

/**
 * Link itemtypes, written through glpi_create_item / glpi_delete_item and
 * read through glpi_get_item `with` on the project or task.
 */
export const LINK_ITEMTYPES = ['ProjectTeam', 'ProjectTaskTeam', 'Itil_Project', 'ProjectTask_Ticket'] as const;
export const WRITE_ITEMTYPES = [...ITEMTYPES, ...LINK_ITEMTYPES] as const;
export type Itemtype = (typeof WRITE_ITEMTYPES)[number];

const itemtypeSchema = z.enum(ITEMTYPES);
/**
 * Write tools validate their enum but list it as a string: the values are
 * already listed by glpi_list_items / glpi_get_item, and an invalid itemtype
 * is rejected with the allowed values.
 */
const itemtypeWriteSchema = advertisedAs(z.enum(WRITE_ITEMTYPES), {
  type: 'string',
  description: 'Itemtype, as in glpi_list_items',
});

/** Sub-resources glpi_get_item can embed (GLPI `with_*` query flags). */
export const WITH_FLAGS = [
  'softwares', 'networkports', 'connections', 'disks', 'documents', 'infocoms', 'contracts',
  'tickets', 'problems', 'changes', 'logs',
] as const;

/** `with` values: GLPI's flags, then the project sections (projects.ts). */
export const WITH_VALUES = [...WITH_FLAGS, ...PROJECT_WITH] as const;
const PROJECT_ONLY = new Set<string>(PROJECT_WITH);

/** Fields glpi_update_item may change, where v3 restricted them. */
export const UPDATE_FIELDS: Partial<Record<Itemtype, readonly string[]>> = {
  Computer: [
    'name', 'serial', 'otherserial', 'uuid', 'contact', 'contact_num', 'comment',
    'locations_id', 'states_id', 'computertypes_id', 'computermodels_id', 'manufacturers_id',
    'users_id', 'groups_id', 'users_id_tech', 'groups_id_tech',
  ],
  Project: [
    'name', 'code', 'content', 'comment', 'priority', 'projectstates_id', 'projecttypes_id', 'projects_id',
    'percent_done', 'auto_percent_done', 'plan_start_date', 'plan_end_date', 'real_start_date', 'real_end_date',
    'users_id', 'groups_id', 'entities_id', 'is_recursive',
  ],
  ProjectTask: [
    'name', 'content', 'comment', 'projectstates_id', 'projecttasktypes_id', 'projecttasks_id', 'percent_done',
    'plan_start_date', 'plan_end_date', 'real_start_date', 'real_end_date', 'planned_duration',
    'effective_duration', 'is_milestone', 'users_id',
  ],
  // Links: delete and create again.
  ProjectTeam: [],
  ProjectTaskTeam: [],
  Itil_Project: [],
  ProjectTask_Ticket: [],
  // Same fields as glpi_update_ticket / glpi_update_problem / glpi_update_change.
  Ticket: TICKET_UPDATE_FIELDS,
  Problem: ITIL_UPDATE_FIELDS,
  Change: ITIL_UPDATE_FIELDS,
};

const PASSWORD_FIELDS = ['password', 'password2'];

/** Fields GLPI needs to create these itemtypes (checked before the call). */
export const CREATE_REQUIRED: Partial<Record<Itemtype, readonly string[]>> = {
  ProjectTask: ['projects_id', 'name'],
  ProjectTeam: ['projects_id', 'itemtype', 'items_id'],
  ProjectTaskTeam: ['projecttasks_id', 'itemtype', 'items_id'],
  Itil_Project: ['projects_id', 'itemtype', 'items_id'],
  ProjectTask_Ticket: ['projecttasks_id', 'tickets_id'],
};

/**
 * Itemtypes whose create response names the entity the item landed in, when
 * the input did not set entities_id: GLPI silently uses the active entity.
 */
function reportsEntity(itemtype: Itemtype): boolean {
  if (itemtype === 'Entity' || itemtype === 'User') return false;
  return COMPACT_FIELDS[itemtype]?.includes('entities_id') ?? false;
}

function checkInput(itemtype: Itemtype, input: Record<string, unknown>, allowed?: readonly string[]) {
  if (Object.keys(input).length === 0) throw invalid('input is empty');
  if (itemtype === 'User') {
    const pw = Object.keys(input).filter((k) => PASSWORD_FIELDS.includes(k));
    if (pw.length) throw invalid('passwords cannot be set through this server; GLPI sends the invitation or an admin sets it');
  }
  if (allowed) {
    const unknown = Object.keys(input).filter((k) => !allowed.includes(k) && k !== 'id');
    if (unknown.length) {
      throw invalid(
        allowed.length
          ? `${itemtype}: field(s) ${unknown.join(', ')} cannot be updated here. Allowed: ${allowed.join(', ')}`
          : `${itemtype} is a link and cannot be updated: delete it and create a new one`
      );
    }
  }
}

const inputSchema = z.record(z.unknown()).describe('GLPI columns, e.g. {"name":"PC-42","locations_id":3}; booleans 0/1');

const listItems = defineTool({
  name: 'glpi_list_items',
  title: 'List items',
  toolset: 'core',
  description:
    'List items of one itemtype (assets, KB, contracts, groups, entities...) as compact rows. For criteria use glpi_search_v2.',
  inputSchema: {
    itemtype: itemtypeSchema,
    ...listShape,
    search_text: z.record(z.string()).optional().describe('{column: "substring"}; "^x$" for exact'),
    fields,
    verbose,
    ...textShape,
  },
  handler: async ({ client }, a) => {
    const { opts, start } = toListOptions(a);
    if (a.search_text) opts.searchText = a.search_text;
    const [page, states] = await Promise.all([
      client.getItemsPage<Record<string, unknown>>(a.itemtype, opts),
      projectStatesFor(client, a.itemtype),
    ]);
    const items = page.items.map((row) => compactItem(a.itemtype, states ? withProjectState(row, states) : row, a));
    return text(listEnvelope(items, start, page.totalcount));
  },
});

const getItem = defineTool({
  name: 'glpi_get_item',
  title: 'Get item',
  toolset: 'core',
  description:
    'One item, compact, plus related data (with). Project: state, counts, tasks, team, tickets, costs...; refused parts go to _errors.',
  inputSchema: {
    itemtype: itemtypeSchema,
    id: id(),
    with: z.array(z.enum(WITH_VALUES)).optional().describe('Related data to embed'),
    verbose,
    ...textShape,
  },
  handler: async ({ client }, a) => {
    const flags = new Set<string>(a.with ?? []);
    const isProject = a.itemtype === 'Project' || a.itemtype === 'ProjectTask';
    const misplaced = [...flags].filter((f) => PROJECT_ONLY.has(f));
    if (!isProject && misplaced.length) throw invalid(`with ${misplaced.join(', ')}: Project only`);
    const notForTask = misplaced.filter((f) => f !== 'team');
    if (a.itemtype === 'ProjectTask' && notForTask.length) throw invalid(`with ${notForTask.join(', ')}: Project only (ProjectTask takes team, tickets)`);
    const states = await projectStatesFor(client, a.itemtype);
    // Project sections are read here. readProjectSections removes the flags
    // it handles synchronously, before its first await: the rest go to GLPI.
    const sections = isProject
      ? readProjectSections(client, a.itemtype as 'Project' | 'ProjectTask', a.id, flags, states ?? [], a)
      : Promise.resolve({});
    const opts: GetOptions = {};
    for (const flag of flags) (opts as Record<string, boolean>)[`with_${flag}`] = true;
    const [item, extra] = await Promise.all([client.getItem<Record<string, unknown>>(a.itemtype, a.id, opts), sections]);
    return text({ ...compactItem(a.itemtype, states ? withProjectState(item, states) : item, a), ...extra });
  },
});

const createItem = defineTool({
  name: 'glpi_create_item',
  title: 'Create item',
  toolset: 'assets',
  description:
    'Create an item of any itemtype from GLPI column values; returns its id and, without entities_id, the entity it landed in. ProjectTask needs projects_id.',
  inputSchema: {
    itemtype: itemtypeWriteSchema,
    input: inputSchema,
  },
  handler: async ({ client }, a) => {
    checkInput(a.itemtype, a.input);
    const missing = (CREATE_REQUIRED[a.itemtype] ?? []).filter((k) => a.input[k] === undefined || a.input[k] === '');
    if (missing.length) throw invalid(`${a.itemtype}: input needs ${missing.join(', ')}`);
    const result = await client.createItem(a.itemtype, a.input);
    const out: Record<string, unknown> = { success: true, itemtype: a.itemtype, ...result };
    if (result?.id && a.input.entities_id === undefined && reportsEntity(a.itemtype)) {
      try {
        const created = await client.getItem<Record<string, unknown>>(a.itemtype, result.id);
        out.entities_id = created.entities_id;
      } catch {
        // the item exists; its entity is only a convenience
      }
    }
    return text(out);
  },
});

const updateItem = defineTool({
  name: 'glpi_update_item',
  title: 'Update item',
  toolset: 'assets',
  description:
    'Change the given fields. Computer, Project(Task), Ticket, Problem, Change: usual fields only; links: none. auto_percent_done=1 derives percent_done from tasks.',
  inputSchema: {
    itemtype: itemtypeWriteSchema,
    id: id(),
    input: inputSchema,
  },
  handler: async ({ client }, a) => {
    checkInput(a.itemtype, a.input, UPDATE_FIELDS[a.itemtype]);
    const { id: _ignored, ...fields } = a.input;
    if (Object.keys(fields).length === 0) throw invalid('nothing to update');
    await client.updateItem(a.itemtype, a.id, fields);
    return text({ success: true, itemtype: a.itemtype, id: a.id });
  },
});

const deleteItem = defineTool({
  name: 'glpi_delete_item',
  title: 'Delete item',
  toolset: 'assets',
  description: 'Trash an item (recoverable); purge=true with confirm_id=id deletes it for good.',
  inputSchema: {
    itemtype: itemtypeWriteSchema,
    id: id(),
    purge: optBool('Delete permanently; needs confirm_id'),
    confirm_id: optInt('Same id, to confirm a purge'),
  },
  handler: async ({ client }, a) => {
    const purge = checkPurge(a.id, a.purge, a.confirm_id);
    await client.deleteItem(a.itemtype, a.id, purge);
    return text({ success: true, itemtype: a.itemtype, id: a.id, purged: purge });
  },
});

export const ITEM_TOOLS: ToolDef[] = [listItems, getItem, createItem, updateItem, deleteItem];
