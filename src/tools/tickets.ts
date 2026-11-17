/**
 * Ticket tools: search, detail, timeline, SLA, satisfaction, and writes
 * (followup / task / solution also accept a Change or Problem).
 */

import { z } from 'zod';
import { type GlpiClient, formatGlpiDate } from '../glpi-client.js';
import type { SearchCriterion } from '../search.js';
import { ArgumentError } from '../errors.js';
import { type ItilItemtype, VALIDATION_STATUS } from '../itil.js';
import { cleanTextFields, compactItem, pageLimit, stripLinks, text } from '../output.js';
import {
  OPEN_STATUS_VALUE,
  parseValidationStatus,
  resolveLinkArgs,
  resolveUploadSource,
  ticketField,
} from '../tool-helpers.js';
import { defineTool, type ToolDef } from './registry.js';
import {
  DATE,
  IMPACT_DESC,
  PRIORITY_DESC,
  STATUS_TICKET_DESC,
  URGENCY_DESC,
  defined,
  hidden,
  id,
  isDeleted,
  itilItemtype,
  optBool,
  optId,
  optInt,
  optStr,
  orderSchema,
  pageShape,
  searchPageShape,
  sortSchema,
  textShape,
  verbose,
} from './common.js';
import { resolveSearchSort, searchEnvelope } from './search-rows.js';

const invalid = (message: string) => new ArgumentError(message);

/** Id of the Ticket, Change or Problem named by `itemtype` (ids are per itemtype). */
const ITIL_PARENT_DESC = 'Id within itemtype';

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export const TIMELINE_KINDS = ['followup', 'task', 'solution', 'validation', 'document'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

const TIMELINE_FIELDS: Record<TimelineKind, readonly string[]> = {
  followup: ['id', 'users_id', 'is_private', 'requesttypes_id', 'content'],
  task: ['id', 'users_id', 'users_id_tech', 'groups_id_tech', 'state', 'actiontime', 'begin', 'end', 'is_private', 'content'],
  solution: ['id', 'users_id', 'status', 'solutiontypes_id', 'content'],
  validation: [
    'id', 'users_id', 'users_id_validate', 'status', 'status_label', 'submission_date', 'validation_date',
    'comment_submission', 'comment_validation',
  ],
  document: ['id', 'documents_id', 'users_id'],
};

function timelineDate(kind: TimelineKind, row: Record<string, unknown>): string {
  const d = kind === 'validation' ? row.submission_date ?? row.date_creation ?? row.date : row.date_creation ?? row.date ?? row.date_mod;
  return typeof d === 'string' ? d : '';
}

/** One timeline row in the compact shape shared by glpi_get_ticket_timeline and glpi://ticket/{id}. */
export function timelineEntry(
  kind: TimelineKind,
  raw: unknown,
  opts: { verbose?: boolean; max_content_chars?: number; raw_html?: boolean }
): Record<string, unknown> {
  const row = stripLinks((raw ?? {}) as Record<string, unknown>);
  const withLabel =
    kind === 'validation' ? { ...row, status_label: VALIDATION_STATUS[Number(row.status)] ?? row.status } : row;
  let out: Record<string, unknown>;
  if (opts.verbose) out = withLabel;
  else {
    out = {};
    for (const k of TIMELINE_FIELDS[kind]) if (withLabel[k] !== undefined) out[k] = withLabel[k];
  }
  return { kind, date: timelineDate(kind, row), ...cleanTextFields(out, opts) };
}

// ---------------------------------------------------------------------------
// "me": the User id of the connected account
// ---------------------------------------------------------------------------

/** Actor filter: a User id, or "me" for the account this server is connected as. */
const actorId = (description?: string) => {
  const schema = z
    .preprocess(
      (v) => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v),
      z.union([z.number().int().nonnegative(), z.literal('me')])
    )
    .optional();
  return description ? schema.describe(description) : schema;
};

/** User id of the session (getFullSession -> session.glpiID), read once per process (GlpiClient.sessionInfo). */
export async function resolveMyUserId(client: GlpiClient): Promise<number> {
  return (await client.sessionInfo()).userId;
}

async function actorValue(client: GlpiClient, value: number | 'me'): Promise<number> {
  if (value !== 'me') return value;
  try {
    return await resolveMyUserId(client);
  } catch (err) {
    throw new ArgumentError(`Cannot resolve "me" to a user id (${err instanceof Error ? err.message : err}); pass the numeric id`);
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const searchTickets = defineTool({
  name: 'glpi_search_tickets',
  title: 'Search tickets',
  toolset: 'tickets',
  description:
    'Find tickets by status, actors ("me" = connected user), category, entity, opening dates or title. For other itemtypes use glpi_search_v2.',
  inputSchema: {
    status: optInt(STATUS_TICKET_DESC),
    open_only: optBool('Open tickets only (status notold)'),
    assigned_user_id: actorId('Technician'),
    assigned_group_id: optId(),
    requester_user_id: actorId(),
    observer_user_id: actorId(),
    category_id: optId('ITILCategory id'),
    entity_id: optId('Entity id (0 = root)'),
    priority: optInt(PRIORITY_DESC),
    urgency: optInt(URGENCY_DESC),
    date_from: optStr(`Opened after ${DATE}`),
    date_to: optStr(`Opened before ${DATE}`),
    text_search: optStr('Text in the title'),
    is_deleted: isDeleted,
    ...searchPageShape,
    sort: sortSchema.describe('Column or search-option id (default 19, last update)'),
    order: orderSchema.describe('Default DESC'),
    ...textShape,
  },
  handler: async ({ client }, q) => {
    const criteria: SearchCriterion[] = [];
    const push = (c: SearchCriterion) => {
      if (criteria.length > 0 && !c.link) c.link = 'AND';
      criteria.push(c);
    };
    const f = (key: Parameters<typeof ticketField>[1]) => ticketField(client, key);
    if (q.status !== undefined) push({ field: await f('status'), searchtype: 'equals', value: q.status });
    if (q.assigned_user_id !== undefined) {
      push({ field: await f('technician_user'), searchtype: 'equals', value: await actorValue(client, q.assigned_user_id) });
    }
    if (q.assigned_group_id !== undefined) push({ field: await f('technician_group'), searchtype: 'equals', value: q.assigned_group_id });
    if (q.requester_user_id !== undefined) {
      push({ field: await f('requester_user'), searchtype: 'equals', value: await actorValue(client, q.requester_user_id) });
    }
    if (q.observer_user_id !== undefined) {
      // Static id 66, like requester 4 and technician 5: see TICKET_FIELD_REFS (tool-helpers.ts).
      push({ field: await f('observer_user'), searchtype: 'equals', value: await actorValue(client, q.observer_user_id) });
    }
    if (q.category_id !== undefined) push({ field: await f('category'), searchtype: 'equals', value: q.category_id });
    if (q.entity_id !== undefined) push({ field: await f('entity'), searchtype: 'equals', value: q.entity_id });
    if (q.priority !== undefined) push({ field: await f('priority'), searchtype: 'equals', value: q.priority });
    if (q.urgency !== undefined) push({ field: await f('urgency'), searchtype: 'equals', value: q.urgency });
    if (q.date_from) push({ field: await f('date'), searchtype: 'morethan', value: q.date_from });
    if (q.date_to) push({ field: await f('date'), searchtype: 'lessthan', value: q.date_to });
    if (q.text_search) push({ field: await f('name'), searchtype: 'contains', value: q.text_search });
    // GLPI's status option has no ordering: 'lessthan 5' matches Solved. 'notold' = New..Pending.
    if (q.open_only) push({ field: await f('status'), searchtype: 'equals', value: OPEN_STATUS_VALUE });

    const result = await client.search.search<Record<string, unknown>>('Ticket', {
      criteria,
      start: q.start ?? 0,
      limit: pageLimit(q.limit),
      fetchAll: q.fetch_all,
      maxRows: q.max_rows,
      // Without sort GLPI orders by id ascending: the advertised default is last update first.
      sort: (await resolveSearchSort(client, 'Ticket', q.sort)) ?? (await f('date_mod')),
      order: q.order ?? 'DESC',
      expandDropdowns: true,
      isDeleted: q.is_deleted,
    });
    return text(searchEnvelope('Ticket', result, q));
  },
});

const getTicket = defineTool({
  name: 'glpi_get_ticket',
  title: 'Get ticket',
  toolset: 'tickets',
  description:
    'One ticket with labels, plain-text content and followup/task/solution counts. Conversation: glpi_get_ticket_timeline.',
  inputSchema: {
    id: id(),
    with_logs: optBool('Add the history log (long)'),
    verbose,
    ...textShape,
  },
  handler: async ({ client }, a) => {
    const [ticket, counts] = await Promise.all([
      client.getTicket(a.id, { with_logs: a.with_logs }),
      client.countItilChildren('Ticket', a.id),
    ]);
    return text({ ...compactItem('Ticket', ticket, a), counts });
  },
});

const getTimeline = defineTool({
  name: 'glpi_get_ticket_timeline',
  title: 'Get ITIL timeline',
  toolset: 'tickets',
  description:
    'Followups, tasks, solutions, validations and documents of a ticket, change or problem, oldest first.',
  inputSchema: {
    id: id(ITIL_PARENT_DESC),
    itemtype: itilItemtype,
    kinds: z
      .array(z.enum(TIMELINE_KINDS))
      .min(1)
      .optional()
      .describe('Default all; no validation on Problem'),
    verbose,
    ...textShape,
  },
  handler: async ({ client }, a) => {
    const itemtype: ItilItemtype = a.itemtype ?? 'Ticket';
    const kinds = new Set<TimelineKind>(a.kinds ?? TIMELINE_KINDS);
    const none = async () => [] as unknown[];
    const [followups, tasks, solutions, validations, documents] = await Promise.all([
      kinds.has('followup') ? client.getItilFollowups(itemtype, a.id) : none(),
      kinds.has('task') ? client.getItilTasks(itemtype, a.id) : none(),
      kinds.has('solution') ? client.getItilSolutions(itemtype, a.id) : none(),
      kinds.has('validation') ? client.getItilValidations(itemtype, a.id) : none(),
      kinds.has('document') ? client.getItilDocuments(itemtype, a.id) : none(),
    ]);
    const timeline = [
      ...followups.map((r) => timelineEntry('followup', r, a)),
      ...tasks.map((r) => timelineEntry('task', r, a)),
      ...solutions.map((r) => timelineEntry('solution', r, a)),
      ...validations.map((r) => timelineEntry('validation', r, a)),
      ...documents.map((r) => timelineEntry('document', r, a)),
    ].sort((x, y) => String(x.date).localeCompare(String(y.date)));
    return text({ itemtype, id: a.id, count: timeline.length, timeline });
  },
});

const listOverdue = defineTool({
  name: 'glpi_list_overdue_tickets',
  title: 'List overdue tickets',
  toolset: 'tickets',
  description: 'Open tickets past their resolution deadline, oldest deadline first.',
  inputSchema: {
    entity_id: optId('Entity id (0 = root)'),
    ...pageShape,
    ...textShape,
  },
  handler: async ({ client }, a) => {
    // GLPI stores server-local datetimes: compare with local time, not UTC.
    const now = formatGlpiDate(new Date());
    const ttr = await ticketField(client, 'time_to_resolve');
    const criteria: SearchCriterion[] = [
      { field: await ticketField(client, 'status'), searchtype: 'equals', value: OPEN_STATUS_VALUE },
      { field: ttr, searchtype: 'lessthan', value: now, link: 'AND' },
      { field: ttr, searchtype: 'notempty', value: '', link: 'AND' },
    ];
    if (a.entity_id !== undefined) {
      criteria.push({ field: await ticketField(client, 'entity'), searchtype: 'equals', value: a.entity_id, link: 'AND' });
    }
    const result = await client.search.search<Record<string, unknown>>('Ticket', {
      criteria,
      start: a.start ?? 0,
      limit: pageLimit(a.limit),
      expandDropdowns: true,
      order: 'ASC',
      sort: ttr,
    });
    return text(searchEnvelope('Ticket', result, a));
  },
});

const getSatisfaction = defineTool({
  name: 'glpi_get_ticket_satisfaction',
  title: 'Get ticket satisfaction',
  toolset: 'tickets',
  description: 'Satisfaction survey of a ticket (score, comment, dates); empty when none.',
  inputSchema: { ticket_id: id() },
  handler: async ({ client }, a) => {
    const rows = await client.getTicketSatisfaction(a.ticket_id);
    return text(rows.map((r) => cleanTextFields(r as Record<string, unknown>)));
  },
});

// ---- writes ----------------------------------------------------------------

const createTicket = defineTool({
  name: 'glpi_create_ticket',
  title: 'Create ticket',
  toolset: 'tickets',
  description: 'Create a ticket and return its id.',
  inputSchema: {
    name: z.string().min(1).describe('Title'),
    content: z.string().min(1).describe('Description, text or HTML'),
    type: optInt('Ticket type (default 1 Incident)'),
    urgency: optInt(`${URGENCY_DESC} (default 3)`),
    impact: optInt(IMPACT_DESC),
    priority: optInt(`${PRIORITY_DESC} (GLPI computes it if omitted)`),
    category_id: optId('ITILCategory id'),
    entity_id: optId('Entity id (default active)'),
    requester_user_id: optId(),
    requester_group_id: optId(),
    user_id_assign: optId('Technician'),
    group_id_assign: optId('Assigned group'),
    time_to_resolve: optStr(`Resolution deadline ${DATE}`),
  },
  handler: async ({ client }, a) => {
    const result = await client.createTicket(
      defined({
        name: a.name,
        content: a.content,
        urgency: a.urgency ?? 3,
        impact: a.impact,
        priority: a.priority,
        type: a.type ?? 1,
        itilcategories_id: a.category_id,
        entities_id: a.entity_id,
        _users_id_assign: a.user_id_assign,
        _groups_id_assign: a.group_id_assign,
        _users_id_requester: a.requester_user_id,
        _groups_id_requester: a.requester_group_id,
        time_to_resolve: a.time_to_resolve,
      }) as Parameters<typeof client.createTicket>[0]
    );
    return text({ success: true, ...result });
  },
});

const updateTicketShape = {
  id: id(),
  name: optStr('Title'),
  content: optStr(),
  status: optInt(STATUS_TICKET_DESC),
  urgency: optInt(URGENCY_DESC),
  impact: optInt(IMPACT_DESC),
  priority: optInt(PRIORITY_DESC),
  itilcategories_id: optId(),
  type: optInt('Ticket type'),
  time_to_resolve: optStr(`Resolution deadline ${DATE}`),
};

/** Fields glpi_update_ticket changes; glpi_update_item allows the same on Ticket. */
export const TICKET_UPDATE_FIELDS: readonly string[] = Object.keys(updateTicketShape).filter((k) => k !== 'id');

const updateTicket = defineTool({
  name: 'glpi_update_ticket',
  title: 'Update ticket',
  toolset: 'tickets',
  description:
    'Change the given fields of a ticket. To solve with an explanation prefer glpi_add_solution.',
  inputSchema: updateTicketShape,
  handler: async ({ client }, a) => {
    const { id: ticketId, ...fields } = a;
    const updates = defined(fields);
    if (Object.keys(updates).length === 0) throw invalid('nothing to update: pass at least one field besides id');
    await client.updateTicket(ticketId, updates as never);
    return text({ success: true, id: ticketId });
  },
});

const setTicketStatus = defineTool({
  name: 'glpi_set_ticket_status',
  title: 'Set ticket status',
  toolset: 'tickets',
  description: 'Change only the status of a ticket. To solve with an explanation prefer glpi_add_solution.',
  inputSchema: {
    id: id(),
    status: z.number().int().min(1).max(6).describe(STATUS_TICKET_DESC),
  },
  handler: async ({ client }, a) => {
    await client.updateTicket(a.id, { status: a.status });
    return text({ success: true, id: a.id, status: a.status });
  },
});

/** purge (or legacy force) requires confirm_id === id. */
export function checkPurge(itemId: number, purge: boolean | undefined, confirmId: number | undefined): boolean {
  if (!purge) return false;
  if (confirmId !== itemId) {
    throw invalid(
      `purge permanently destroys the item: set confirm_id to the same id (${itemId}) to confirm, ` +
        'or omit purge to move it to the trash (recoverable).'
    );
  }
  return true;
}

const deleteTicket = defineTool({
  name: 'glpi_delete_ticket',
  title: 'Delete ticket',
  toolset: 'tickets',
  description: 'Trash a ticket (recoverable); purge=true with confirm_id=id deletes it for good.',
  inputSchema: {
    id: id(),
    purge: optBool('Delete permanently; needs confirm_id'),
    /** v3 name of purge; accepted, not advertised. */
    force: hidden(optBool('Legacy purge')),
    confirm_id: optInt('Same id, to confirm a purge'),
  },
  handler: async ({ client }, a) => {
    const purge = checkPurge(a.id, a.purge ?? a.force, a.confirm_id);
    await client.deleteTicket(a.id, purge);
    return text({ success: true, id: a.id, purged: purge });
  },
});

const isPrivate = optBool('Hidden from the requester');

const addFollowup = defineTool({
  name: 'glpi_add_followup',
  title: 'Add followup',
  toolset: 'tickets',
  description: 'Add a followup (comment) to a ticket, change or problem.',
  inputSchema: {
    ticket_id: id(ITIL_PARENT_DESC),
    itemtype: itilItemtype,
    content: z.string().min(1).describe('Text or HTML'),
    is_private: isPrivate,
  },
  handler: async ({ client }, a) => {
    const result = await client.addItilFollowup(a.itemtype ?? 'Ticket', a.ticket_id, a.content, a.is_private ?? false);
    return text({ success: true, followup_id: result.id });
  },
});

const addTask = defineTool({
  name: 'glpi_add_task',
  title: 'Add task',
  toolset: 'tickets',
  description: 'Add a task (work log, time spent, planning) to a ticket, change or problem.',
  inputSchema: {
    ticket_id: id(ITIL_PARENT_DESC),
    itemtype: itilItemtype,
    content: z.string().min(1),
    actiontime: optInt('Time spent, seconds'),
    state: optInt('Task state (default 1 To do)'),
    is_private: isPrivate,
    users_id_tech: optId('Technician'),
    groups_id_tech: optId('Group in charge'),
    begin: optStr(`Planned start ${DATE}`),
    end: optStr(`Planned end ${DATE}`),
  },
  handler: async ({ client }, a) => {
    const result = await client.addItilTask(a.itemtype ?? 'Ticket', a.ticket_id, a.content, {
      is_private: a.is_private,
      actiontime: a.actiontime,
      state: a.state,
      users_id_tech: a.users_id_tech,
      groups_id_tech: a.groups_id_tech,
      begin: a.begin,
      end: a.end,
    });
    return text({ success: true, task_id: result.id });
  },
});

const addSolution = defineTool({
  name: 'glpi_add_solution',
  title: 'Add solution',
  toolset: 'tickets',
  description: 'Add a solution to a ticket, change or problem, which GLPI then marks solved.',
  inputSchema: {
    ticket_id: id(ITIL_PARENT_DESC),
    itemtype: itilItemtype,
    content: z.string().min(1),
    solutiontypes_id: optId(),
  },
  handler: async ({ client }, a) => {
    const result = await client.addItilSolution(a.itemtype ?? 'Ticket', a.ticket_id, a.content, a.solutiontypes_id);
    return text({ success: true, solution_id: result.id });
  },
});

const assignTicket = defineTool({
  name: 'glpi_assign_ticket',
  title: 'Assign ticket',
  toolset: 'tickets',
  description: 'Add a user and/or a group to a ticket as requester, assignee (default) or observer.',
  inputSchema: {
    ticket_id: id(),
    user_id: optId(),
    group_id: optId(),
    type: optInt('Actor role (default 2 Assigned)'),
  },
  handler: async ({ client }, a) => {
    if (!a.user_id && !a.group_id) throw invalid('user_id or group_id required');
    const result = await client.assignTicket(a.ticket_id, { users_id: a.user_id, groups_id: a.group_id, type: a.type });
    return text({
      success: true,
      assignment_id: result.id,
      ...(result.user_link_id !== undefined ? { user_assignment_id: result.user_link_id } : {}),
      ...(result.group_link_id !== undefined ? { group_assignment_id: result.group_link_id } : {}),
    });
  },
});

const linkTickets = defineTool({
  name: 'glpi_link_tickets',
  title: 'Link tickets',
  toolset: 'tickets',
  description: 'Link two tickets as "ticket_id <relation> other_ticket_id", e.g. 12 duplicate 7, 12 child_of 7.',
  inputSchema: {
    ticket_id: optId('Subject ticket'),
    other_ticket_id: optId('Related ticket'),
    relation: z.enum(['link', 'duplicate', 'child_of', 'parent_of']).optional().describe('Default link'),
    /** v3 form (parent_id + child_id + numeric link_type): accepted, not advertised. */
    link_type: hidden(optInt('Legacy relation')),
    parent_id: hidden(optId('Legacy parent ticket')),
    child_id: hidden(optId('Legacy child ticket')),
  },
  handler: async ({ client }, a) => {
    const { ticketId, otherTicketId, relation } = resolveLinkArgs(a);
    const result = await client.linkTickets(ticketId, otherTicketId, relation);
    return text({ success: true, link_id: result.id, ticket_id: ticketId, other_ticket_id: otherTicketId, relation });
  },
});

const addValidation = defineTool({
  name: 'glpi_add_ticket_validation',
  title: 'Request ticket validation',
  toolset: 'tickets',
  description: 'Ask a user to approve a ticket; GLPI notifies them.',
  inputSchema: {
    ticket_id: id(),
    users_id_validate: id('Approver'),
    comment_submission: optStr('Message to the approver'),
  },
  handler: async ({ client }, a) => {
    const result = await client.addTicketValidation(a.ticket_id, {
      users_id_validate: a.users_id_validate,
      comment_submission: a.comment_submission,
    });
    return text({ success: true, validation_id: result.id });
  },
});

const setValidationStatus = defineTool({
  name: 'glpi_set_validation_status',
  title: 'Answer ticket validation',
  toolset: 'tickets',
  description: 'Approve or refuse a ticket validation (id from the timeline).',
  inputSchema: {
    validation_id: id(),
    status: z.union([z.number(), z.string()]).describe('2 Granted, 3 Refused'),
    comment_validation: optStr('Answer comment'),
  },
  handler: async ({ client }, a) => {
    const status = parseValidationStatus(a.status);
    await client.setTicketValidationStatus(a.validation_id, status, a.comment_validation);
    return text({ success: true, validation_id: a.validation_id, status_label: VALIDATION_STATUS[status] });
  },
});

const uploadDocument = defineTool({
  name: 'glpi_upload_document',
  title: 'Upload document',
  toolset: 'tickets',
  description:
    'Upload a file (max 20 MB) as a Document from base64 or a path in GLPI_UPLOAD_DIR, optionally attached to a ticket.',
  inputSchema: {
    content_base64: optStr('File content, base64'),
    filename: optStr('File name, with content_base64'),
    file_path: optStr('Path inside GLPI_UPLOAD_DIR'),
    name: optStr('Document title (default file name)'),
    ticket_id: optId('Attach to this ticket'),
  },
  handler: async ({ client }, a) => {
    const source = await resolveUploadSource(a);
    // Linking via the manifest lets GLPI create the Document_Item itself,
    // which also works for profiles that cannot POST Document_Item.
    const document = await client.uploadDocument({
      filename: source.filename,
      data: source.data,
      name: a.name,
      mimeType: source.mimeType,
      ...(a.ticket_id ? { itemtype: 'Ticket', items_id: a.ticket_id } : {}),
    });
    return text({ success: true, document_id: document.id, ...(a.ticket_id ? { ticket_id: a.ticket_id } : {}) });
  },
});

const attachDocument = defineTool({
  name: 'glpi_attach_document_to_ticket',
  title: 'Attach document to ticket',
  toolset: 'tickets',
  description: 'Link an existing Document to a ticket.',
  inputSchema: {
    ticket_id: id(),
    document_id: id(),
  },
  handler: async ({ client }, a) => {
    const result = await client.attachDocumentToTicket(a.ticket_id, a.document_id);
    return text({ success: true, link_id: result.id });
  },
});

export const TICKET_TOOLS: ToolDef[] = [
  searchTickets,
  getTicket,
  getTimeline,
  listOverdue,
  getSatisfaction,
  createTicket,
  updateTicket,
  setTicketStatus,
  deleteTicket,
  addFollowup,
  addTask,
  addSolution,
  assignTicket,
  linkTickets,
  addValidation,
  setValidationStatus,
  uploadDocument,
  attachDocument,
];
