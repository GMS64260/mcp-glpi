/**
 * 4.2.0 additions to the generic item tools and stats, through the real
 * McpServer and a fake GLPI: KB visibility (`with: visibility` and its link
 * itemtypes), timeline rows (ITILFollowup, TicketTask, ITILSolution) edited
 * and deleted, Contact, and the "delays" dimension of glpi_tickets_stats_by.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GlpiClient } from '../src/glpi-client.js';
import { createMcpServer } from '../src/server.js';
import { summarizeSeconds } from '../src/tools/stats.js';

interface FetchCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: { input: Record<string, unknown> };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

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

// ---- KB visibility ------------------------------------------------------------

function kbGlpi(c: FetchCall): Response | undefined {
  switch (c.path) {
    case 'KnowbaseItem/3':
      return json({ id: 3, name: 'VPN', answer: '<p>How to</p>' });
    case 'KnowbaseItem/3/KnowbaseItem_Profile':
      return json([{ id: 11, knowbaseitems_id: 3, profiles_id: 2, entities_id: -1, is_recursive: 0 }]);
    case 'KnowbaseItem/3/Group_KnowbaseItem':
      return json([{ id: 12, knowbaseitems_id: 3, groups_id: 4, entities_id: 0, is_recursive: 1 }]);
    case 'KnowbaseItem/3/KnowbaseItem_User':
      return json(['ERROR_RIGHT_MISSING', 'no'], { status: 403 });
    case 'KnowbaseItem/3/Entity_KnowbaseItem':
      return json([{ id: 13, knowbaseitems_id: 3, entities_id: 0, is_recursive: 1 }]);
    case 'Profile/2':
      return json({ id: 2, name: 'Observer' });
    case 'Group/4':
      return json({ id: 4, name: 'IT' });
    case 'Entity/0':
      return json({ id: 0, name: 'Root entity' });
  }
  return undefined;
}

test('glpi_get_item KnowbaseItem with visibility: one row per target, refused list in _errors', async () => {
  const calls = installFetch(kbGlpi);
  const kb = (await call('glpi_get_item', { itemtype: 'KnowbaseItem', id: 3, with: ['visibility'] })).json();
  assert.deepEqual(kb._visibility, [
    { id: 11, link: 'KnowbaseItem_Profile', itemtype: 'Profile', items_id: 2, name: 'Observer', entities_id: -1, is_recursive: 0 },
    { id: 12, link: 'Group_KnowbaseItem', itemtype: 'Group', items_id: 4, name: 'IT', entities_id: 0, is_recursive: 1 },
    { id: 13, link: 'Entity_KnowbaseItem', itemtype: 'Entity', items_id: 0, name: 'Root entity', is_recursive: 1 },
  ]);
  assert.match(kb._errors.KnowbaseItem_User, /403 ERROR_RIGHT_MISSING/);
  // visibility is not a GLPI with_* flag
  const item = calls.find((c) => c.path === 'KnowbaseItem/3')!;
  assert.equal(item.query.get('with_visibility'), null);
});

test('with visibility is refused on other itemtypes', async () => {
  installFetch(() => undefined);
  const r = await call('glpi_get_item', { itemtype: 'Computer', id: 3, with: ['visibility'] });
  assert.ok(r.result.isError);
  assert.match(r.text, /KnowbaseItem only/);
});

test('KB visibility links: create needs the target, cannot be updated', async () => {
  const calls = installFetch((c) => (c.method === 'POST' ? json({ id: 50 }, { status: 201 }) : undefined));
  const missing = await call('glpi_create_item', { itemtype: 'Group_KnowbaseItem', input: { knowbaseitems_id: 3 } });
  assert.ok(missing.result.isError);
  assert.match(missing.text, /needs groups_id/);
  const ok = (await call('glpi_create_item', { itemtype: 'Group_KnowbaseItem', input: { knowbaseitems_id: 3, groups_id: 4, entities_id: 0, is_recursive: 1 } })).json();
  assert.equal(ok.id, 50);
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === 'Group_KnowbaseItem'));
  const upd = await call('glpi_update_item', { itemtype: 'Entity_KnowbaseItem', id: 13, input: { is_recursive: 0 } });
  assert.ok(upd.result.isError);
  assert.match(upd.text, /is a link and cannot be updated/);
});

// ---- timeline rows ------------------------------------------------------------

test('timeline rows: allowed fields are updated, others refused', async () => {
  const calls = installFetch((c) => (c.method === 'PUT' ? json([{ '8': true }]) : undefined));
  const ok = (await call('glpi_update_item', { itemtype: 'ITILFollowup', id: 8, input: { content: 'Fixed typo', is_private: 1 } })).json();
  assert.equal(ok.success, true);
  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.path, 'ITILFollowup/8');
  assert.deepEqual(put.body, { input: { content: 'Fixed typo', is_private: 1 } });

  const bad = await call('glpi_update_item', { itemtype: 'TicketTask', id: 9, input: { tickets_id: 4 } });
  assert.ok(bad.result.isError);
  assert.match(bad.text, /tickets_id cannot be updated here/);
  const task = await call('glpi_update_item', { itemtype: 'TicketTask', id: 9, input: { actiontime: 3600, state: 2 } });
  assert.ok(!task.result.isError, task.text);
});

test('timeline rows have no trash: delete needs purge and confirm_id', async () => {
  const calls = installFetch((c) => (c.method === 'DELETE' ? json([{ '8': true }]) : undefined));
  const plain = await call('glpi_delete_item', { itemtype: 'ITILFollowup', id: 8 });
  assert.ok(plain.result.isError);
  assert.match(plain.text, /no trash.*purge=true and confirm_id=8/);
  assert.equal(calls.length, 0);

  const purged = (await call('glpi_delete_item', { itemtype: 'ITILFollowup', id: 8, purge: true, confirm_id: 8 })).json();
  assert.equal(purged.purged, true);
  assert.equal(calls[0].path, 'ITILFollowup/8');
});

test('timeline itemtypes are write-only: glpi_list_items refuses them, accepts Contact', async () => {
  installFetch((c) => (c.path === 'Contact' ? json([{ id: 1, name: 'Martin', firstname: 'Paul', phone: '0102', password: 'x' }]) : undefined));
  const refused = await call('glpi_list_items', { itemtype: 'ITILFollowup' }).catch((e: Error) => e);
  assert.ok(refused instanceof Error || (refused as { result: CallToolResult }).result.isError);
  const contacts = (await call('glpi_list_items', { itemtype: 'Contact' })).json();
  assert.deepEqual(contacts.items, [{ id: 1, name: 'Martin', firstname: 'Paul', phone: '0102' }]);
});

// ---- delays -------------------------------------------------------------------

test('summarizeSeconds: hours with median and p90', () => {
  assert.equal(summarizeSeconds([]), null);
  assert.deepEqual(summarizeSeconds([3600, 7200, 10800, 36000]), { count: 4, avg_hours: 4, median_hours: 2, p90_hours: 10 });
});

test('glpi_tickets_stats_by delays: GLPI delay columns, deadline respect, filters kept', async () => {
  const calls = installFetch((c) => {
    if (c.path === 'listSearchOptions/Ticket') return json({});
    if (c.path === 'search/Ticket') {
      return json(
        {
          totalcount: 3,
          count: 3,
          data: [
            { 2: 1, 150: '600', 154: '3600', 152: '7200', 17: '2026-11-01 10:00:00', 18: '2026-11-01 12:00:00' },
            { 2: 2, 150: '1200', 154: '36000', 152: '0', 17: '2026-11-03 10:00:00', 18: '2026-11-02 12:00:00' },
            { 2: 3, 150: '0', 154: '0', 152: '0', 17: null, 18: null },
          ],
        },
        { headers: { 'Content-Range': '0-2/3' } }
      );
    }
    return undefined;
  });
  const out = (await call('glpi_tickets_stats_by', { dimension: 'delays', entity_id: 0, date_from: '2026-11-01' })).json();
  assert.equal(out.tickets, 3);
  assert.deepEqual(out.take_into_account, { count: 2, avg_hours: 0.3, median_hours: 0.2, p90_hours: 0.3 });
  assert.equal(out.solve.count, 2);
  assert.equal(out.close.count, 1);
  assert.deepEqual(out.deadline, { solved_with_deadline: 2, solved_late: 1, late_rate: 50 });

  const search = calls.find((c) => c.path === 'search/Ticket')!;
  const forced = [...search.query.entries()].filter(([k]) => k.startsWith('forcedisplay')).map(([, v]) => v);
  for (const id of ['150', '152', '154', '17', '18']) assert.ok(forced.includes(id), `forcedisplay ${id}`);
  assert.equal(search.query.get('criteria[0][field]'), '80');
  assert.equal(search.query.get('criteria[0][link]'), null);
  assert.equal(search.query.get('criteria[1][link]'), 'AND');
});
