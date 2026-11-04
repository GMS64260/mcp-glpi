/**
 * Projects (issue #14) through the real McpServer and a fake GLPI:
 * glpi_get_item `with` sections on Project / ProjectTask, project states,
 * counts, refused sections, ProjectTask and link writes.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GlpiClient } from '../src/glpi-client.js';
import { createMcpServer } from '../src/server.js';
import { withProjectState } from '../src/tools/projects.js';

interface FetchCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

const STATES = [
  { id: 1, name: 'New', is_finished: 0 },
  { id: 2, name: 'Processing', is_finished: 0 },
  { id: 3, name: 'Closed', is_finished: 1 },
];

/** A project 5 with two tasks (one finished), a team, ITIL links and a refused cost list. */
function projectGlpi(c: FetchCall): Response | undefined {
  const expanded = c.query.get('expand_dropdowns') === 'true';
  switch (c.path) {
    case 'ProjectState':
      return json(STATES);
    case 'Project/5':
      return json({ id: 5, name: 'Migration', projectstates_id: expanded ? 'Processing' : 2, entities_id: 'Root > Client A', percent_done: 40, content: '<p>Plan</p>' });
    case 'Project/5/ProjectTask':
      if (c.query.get('range') === '0-0') return json([{ id: 10 }], { headers: { 'Content-Range': '0-0/2' } });
      return json([
        { id: 10, name: 'Inventory', projects_id: 5, projecttasks_id: 0, projectstates_id: 3, percent_done: 100, is_milestone: 0, planned_duration: 7200, links: [] },
        { id: 11, name: 'Cutover', projects_id: 5, projecttasks_id: 10, projectstates_id: 2, percent_done: 0, is_milestone: 1, content: '&lt;p&gt;Weekend&lt;/p&gt;' },
      ]);
    case 'Project/5/ProjectTeam':
      return json([{ id: 1, projects_id: 5, itemtype: 'User', items_id: 7 }, { id: 2, projects_id: 5, itemtype: 'Group', items_id: 3 }]);
    case 'Project/5/Itil_Project':
      if (c.query.get('range') === '0-0') return json([{ id: 1 }], { headers: { 'Content-Range': '0-0/2' } });
      return json([{ id: 1, projects_id: 5, itemtype: 'Ticket', items_id: 42 }, { id: 2, projects_id: 5, itemtype: 'Change', items_id: 3 }]);
    case 'Project/5/ProjectCost':
      return json(['ERROR_RIGHT_MISSING', "You don't have permission to perform this action."], { status: 403 });
    case 'ProjectTask/10/ProjectTaskTeam':
      return json([{ id: 4, projecttasks_id: 10, itemtype: 'User', items_id: 7 }]);
    case 'ProjectTask/10/ProjectTask_Ticket':
      return json([{ id: 9, projecttasks_id: 10, tickets_id: 42 }]);
    case 'User/7':
      return json({ id: 7, name: 'jdoe', firstname: 'Jane', realname: 'Doe' });
    case 'Group/3':
      return json({ id: 3, name: 'Network team' });
    case 'Ticket/42':
      return json({ id: 42, name: 'Switch order', status: 2 });
    case 'Change/3':
      return json({ id: 3, name: 'Core switch swap', status: 9 });
  }
  return undefined;
}

function installFetch(route: (c: FetchCall) => Response | undefined): FetchCall[] {
  const calls: FetchCall[] = [];
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/apirest\.php\//, '');
    if (path === 'initSession') return json({ session_token: 's' });
    const call: FetchCall = {
      method: init?.method ?? 'GET',
      path,
      query: u.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return route(call) ?? json([]);
  });
  return calls;
}

async function call(name: string, args: Record<string, unknown>) {
  const glpi = new GlpiClient({ url: 'https://glpi.test', userToken: 'u', maxRetries: 0 });
  const server = createMcpServer({ client: glpi });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  await client.close();
  const text = (result.content[0] as { text: string }).text;
  return { result, text, json: () => JSON.parse(text) };
}

test('withProjectState: by id, by expanded name, no state', () => {
  const states = STATES.map((s) => ({ ...s, is_finished: s.is_finished === 1 }));
  assert.deepEqual(withProjectState({ projectstates_id: 3 }, states), { projectstates_id: 3, state: 'Closed', state_is_finished: true });
  assert.deepEqual(withProjectState({ projectstates_id: 'Processing' }, states), { projectstates_id: 'Processing', state: 'Processing', state_is_finished: false });
  assert.deepEqual(withProjectState({ projectstates_id: 0 }, states), { projectstates_id: 0, state: null, state_is_finished: false });
  assert.deepEqual(withProjectState({ name: 'x' }, states), { name: 'x' });
});

test('glpi_get_item Project: state and counts, sections only on request', async () => {
  const calls = installFetch(projectGlpi);
  const project = (await call('glpi_get_item', { itemtype: 'Project', id: 5 })).json();
  assert.equal(project.state, 'Processing');
  assert.equal(project.state_is_finished, false);
  assert.equal(project.content, 'Plan');
  assert.deepEqual(project.counts, { tasks: 2, team: 2, itil: 2 });
  assert.equal(project._tasks, undefined);
  // Counts use range=0-0, not the full lists.
  assert.ok(calls.filter((c) => c.path === 'Project/5/ProjectTask').every((c) => c.query.get('range') === '0-0'));
});

test('glpi_get_item Project with tasks, team, tickets, changes: compact rows, names and statuses', async () => {
  const calls = installFetch(projectGlpi);
  const p = (await call('glpi_get_item', { itemtype: 'Project', id: 5, with: ['tasks', 'team', 'tickets', 'changes'] })).json();

  assert.deepEqual(p._tasks.map((t: Record<string, unknown>) => [t.id, t.state, t.state_is_finished, t.projecttasks_id]), [
    [10, 'Closed', true, 0],
    [11, 'Processing', false, 10],
  ]);
  assert.equal(p._tasks[1].content, 'Weekend');
  assert.equal(p._tasks[0].links, undefined);
  assert.deepEqual(p.counts, { tasks: 2, team: 2, itil: 2, open_tasks: 1 });
  assert.deepEqual(p._team, [
    { id: 1, itemtype: 'User', items_id: 7, name: 'Jane Doe (jdoe)' },
    { id: 2, itemtype: 'Group', items_id: 3, name: 'Network team' },
  ]);
  assert.deepEqual(p._tickets, [{ id: 1, itemtype: 'Ticket', items_id: 42, name: 'Switch order', status: 2, status_label: 'Processing (assigned)' }]);
  assert.deepEqual(p._changes, [{ id: 2, itemtype: 'Change', items_id: 3, name: 'Core switch swap', status: 9, status_label: 'Evaluation' }]);
  assert.equal(p._problems, undefined);

  // Itil_Project is read once for tickets and changes; GLPI gets no with_tickets/with_changes.
  assert.equal(calls.filter((c) => c.path === 'Project/5/Itil_Project' && c.query.get('range') !== '0-0').length, 1);
  const get = calls.find((c) => c.path === 'Project/5')!;
  assert.equal(get.query.get('with_tickets'), null);
  assert.equal(get.query.get('with_changes'), null);
});

test('task_details nests each task\'s team and tickets', async () => {
  installFetch(projectGlpi);
  const p = (await call('glpi_get_item', { itemtype: 'Project', id: 5, with: ['task_details'] })).json();
  const inventory = p._tasks.find((t: { id: number }) => t.id === 10);
  assert.deepEqual(inventory.team, [{ id: 4, itemtype: 'User', items_id: 7, name: 'Jane Doe (jdoe)' }]);
  assert.deepEqual(inventory.tickets, [{ id: 9, itemtype: 'Ticket', items_id: 42, name: 'Switch order', status: 2, status_label: 'Processing (assigned)' }]);
  assert.deepEqual(p._tasks.find((t: { id: number }) => t.id === 11).team, []);
});

test('a section GLPI refuses is reported in _errors, not as an empty list', async () => {
  installFetch(projectGlpi);
  const { result, json: out } = await call('glpi_get_item', { itemtype: 'Project', id: 5, with: ['costs', 'documents'] });
  assert.ok(!result.isError);
  const p = out();
  assert.equal(p._costs, undefined);
  assert.match(p._errors.costs, /^403 ERROR_RIGHT_MISSING/);
});

test('documents stays GLPI\'s own flag on a project', async () => {
  const calls = installFetch(projectGlpi);
  await call('glpi_get_item', { itemtype: 'Project', id: 5, with: ['documents'] });
  assert.equal(calls.find((c) => c.path === 'Project/5')!.query.get('with_documents'), 'true');
});

test('ProjectTask: team and tickets; project-only values are refused elsewhere', async () => {
  installFetch((c) => (c.path === 'ProjectTask/10' ? json({ id: 10, name: 'Inventory', projectstates_id: 3 }) : projectGlpi(c)));
  const task = (await call('glpi_get_item', { itemtype: 'ProjectTask', id: 10, with: ['team', 'tickets'] })).json();
  assert.equal(task.state, 'Closed');
  assert.equal(task._team[0].name, 'Jane Doe (jdoe)');
  assert.equal(task._tickets[0].items_id, 42);
  assert.equal(task.counts, undefined);

  const onTask = await call('glpi_get_item', { itemtype: 'ProjectTask', id: 10, with: ['tasks'] });
  assert.ok(onTask.result.isError);
  assert.match(onTask.text, /Project only/);
  const onComputer = await call('glpi_get_item', { itemtype: 'Computer', id: 1, with: ['team'] });
  assert.ok(onComputer.result.isError);
});

test('glpi_list_items Project rows carry state and state_is_finished', async () => {
  installFetch((c) =>
    c.path === 'Project'
      ? json([{ id: 5, name: 'Migration', projectstates_id: 'Closed' }, { id: 6, name: 'Idea', projectstates_id: 0 }], { headers: { 'Content-Range': '0-1/2' } })
      : projectGlpi(c)
  );
  const page = (await call('glpi_list_items', { itemtype: 'Project' })).json();
  assert.deepEqual(page.items.map((p: Record<string, unknown>) => [p.id, p.state, p.state_is_finished]), [
    [5, 'Closed', true],
    [6, null, false],
  ]);
});

test('Project and ProjectTask updates: extended allow-lists; links cannot be updated', async () => {
  const calls = installFetch((c) => (c.method === 'PUT' ? json([{ 5: true }]) : undefined));
  const ok = await call('glpi_update_item', {
    itemtype: 'Project', id: 5,
    input: { projectstates_id: 3, plan_end_date: '2026-12-01', users_id: 7, entities_id: 4, is_recursive: 1, auto_percent_done: 1 },
  });
  assert.ok(!ok.result.isError, ok.text);
  const task = await call('glpi_update_item', { itemtype: 'ProjectTask', id: 10, input: { percent_done: 50, effective_duration: 3600, projectstates_id: 2 } });
  assert.ok(!task.result.isError, task.text);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 2);

  const bad = await call('glpi_update_item', { itemtype: 'ProjectTask', id: 10, input: { projects_id: 9 } });
  assert.ok(bad.result.isError);
  assert.match(bad.text, /projects_id cannot be updated/);
  const link = await call('glpi_update_item', { itemtype: 'ProjectTeam', id: 1, input: { items_id: 8 } });
  assert.ok(link.result.isError);
  assert.match(link.text, /link and cannot be updated/);
});

test('creating a ProjectTask needs projects_id; a link is created with its fields', async () => {
  const calls = installFetch((c) => (c.method === 'POST' ? json({ id: 99, message: '' }, { status: 201 }) : undefined));
  const missing = await call('glpi_create_item', { itemtype: 'ProjectTask', input: { name: 'Audit' } });
  assert.ok(missing.result.isError);
  assert.match(missing.text, /ProjectTask: input needs projects_id/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);

  const link = await call('glpi_create_item', { itemtype: 'ProjectTaskTeam', input: { projecttasks_id: 10, itemtype: 'User', items_id: 7 } });
  assert.ok(!link.result.isError, link.text);
  assert.deepEqual(calls.find((c) => c.method === 'POST')!.body, { input: { projecttasks_id: 10, itemtype: 'User', items_id: 7 } });
});

test('create reports the entity the item landed in when entities_id was not given', async () => {
  const calls = installFetch((c) => {
    if (c.method === 'POST') return json({ id: 12, message: '' }, { status: 201 });
    if (c.path === 'Project/12') return json({ id: 12, name: 'New', entities_id: 'Root entity' });
    return undefined;
  });
  const created = (await call('glpi_create_item', { itemtype: 'Project', input: { name: 'New' } })).json();
  assert.deepEqual(created, { success: true, itemtype: 'Project', id: 12, message: '', entities_id: 'Root entity' });

  const before = calls.length;
  const placed = (await call('glpi_create_item', { itemtype: 'Project', input: { name: 'New', entities_id: 4 } })).json();
  assert.equal(placed.entities_id, undefined);
  assert.equal(calls.length - before, 1, 'no extra read when entities_id is given');
});
