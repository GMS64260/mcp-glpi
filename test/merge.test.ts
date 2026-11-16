/**
 * glpi_merge_tickets through the real McpServer and a fake GLPI: what is
 * copied, deduplication against the target, dry run, the source left as is
 * when a copy fails, and the checks made before any write.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GlpiClient } from '../src/glpi-client.js';
import { createMcpServer } from '../src/server.js';
import { originLine, storedHtml } from '../src/tools/merge.js';

interface FetchCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: { input: Record<string, unknown> };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'Content-Type': 'application/json' } });

let nextId = 1000;

/** Target 10; source 20 with a followup, a task, a document already on the target and two actors (one already there). */
function mergeGlpi(c: FetchCall, opts: { failTask?: boolean } = {}): Response | undefined {
  if (c.method === 'POST') {
    if (opts.failTask && c.path === 'TicketTask') return json(['ERROR_GLPI_ADD', 'boom'], { status: 400 });
    return json({ id: nextId++, message: '' }, { status: 201 });
  }
  if (c.method === 'DELETE' || c.method === 'PUT') return json([{ '20': true, message: '' }]);
  switch (c.path) {
    case 'Ticket/10':
      return json({ id: 10, name: 'Printer down', is_deleted: 0 });
    case 'Ticket/20':
      return json({ id: 20, name: "L'imprimante", content: '&lt;p&gt;Printer &amp; scanner&lt;/p&gt;', date: '2026-11-01 09:30:00', users_id_recipient: 7, requesttypes_id: 1 });
    case 'Ticket/20/ITILFollowup':
      return json([{ id: 1, content: '<p>Still down</p>', is_private: 1, users_id: 7, date: '2026-11-02 10:00:00', requesttypes_id: 1 }]);
    case 'Ticket/20/TicketTask':
      return json([{ id: 2, content: 'Checked', actiontime: 1800, state: 2, users_id_tech: 3, begin: null, date: '2026-11-02 11:00:00' }]);
    case 'Ticket/20/Document_Item':
      return json([{ id: 3, documents_id: 55 }, { id: 4, documents_id: 56 }]);
    case 'Ticket/10/Document_Item':
      return json([{ id: 9, documents_id: 55 }]);
    case 'Ticket/20/Ticket_User':
      return json([{ id: 5, users_id: 7, type: 1, use_notification: 1, alternative_email: '' }, { id: 6, users_id: 3, type: 2 }]);
    case 'Ticket/10/Ticket_User':
      return json([{ id: 8, users_id: 7, type: 1 }]);
    case 'Ticket/20/Group_Ticket':
      return json([{ id: 7, groups_id: 4, type: 2 }]);
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

async function call(args: Record<string, unknown>) {
  const glpi = new GlpiClient({ url: 'https://glpi.test', userToken: 'u', maxRetries: 0 });
  const server = createMcpServer({ client: glpi });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const result = (await client.callTool({ name: 'glpi_merge_tickets', arguments: args })) as CallToolResult;
  await client.close();
  const text = (result.content[0] as { text: string }).text;
  return { result, text, json: () => JSON.parse(text) };
}

const posts = (calls: FetchCall[], path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body!.input);

test('storedHtml decodes entity-encoded HTML only; originLine names the source', () => {
  assert.equal(storedHtml('&lt;p&gt;a &amp; b&lt;/p&gt;'), '<p>a & b</p>');
  assert.equal(storedHtml('<p>a &amp; b</p>'), '<p>a &amp; b</p>');
  assert.equal(storedHtml(null), '');
  assert.equal(originLine(20, '2026-11-01 09:30:00', 'A <b>'), '<p><strong>[#20 A &lt;b&gt; · 2026-11-01 09:30]</strong></p>');
});

test('merge copies description, followups, tasks, new documents and new actors, links and trashes the source', async () => {
  const calls = installFetch((c) => mergeGlpi(c));
  const out = (await call({ target_id: 10, source_ids: [20] })).json();

  assert.equal(out.success, true);
  assert.deepEqual(out.sources[0].copied, { description: 1, followups: 1, tasks: 1, documents: 1, actors: 2 });
  assert.equal(out.sources[0].source, 'trashed');

  const fups = posts(calls, 'ITILFollowup');
  // description, followup, then the note on the source
  assert.equal(fups.length, 3);
  assert.equal(fups[0].items_id, 10);
  assert.match(String(fups[0].content), /^<p><strong>\[#20 L'imprimante · 2026-11-01 09:30\]<\/strong><\/p><p>Printer & scanner<\/p>$/);
  assert.equal(fups[0].users_id, 7);
  assert.equal(fups[1].is_private, 1);
  assert.equal(fups[2].items_id, 20);
  assert.match(String(fups[2].content), /#10/);

  const task = posts(calls, 'TicketTask')[0];
  assert.equal(task.tickets_id, 10);
  assert.equal(task.actiontime, 1800);
  assert.equal(task.begin, undefined, 'null columns are not sent');

  assert.deepEqual(posts(calls, 'Document_Item'), [{ documents_id: 56, itemtype: 'Ticket', items_id: 10 }]);
  assert.deepEqual(posts(calls, 'Ticket_User'), [{ tickets_id: 10, users_id: 3, type: 2 }]);
  assert.deepEqual(posts(calls, 'Group_Ticket'), [{ tickets_id: 10, groups_id: 4, type: 2 }]);
  assert.deepEqual(posts(calls, 'Ticket_Ticket'), [{ tickets_id_1: 20, tickets_id_2: 10, link: 2 }]);
  const del = calls.find((c) => c.method === 'DELETE');
  assert.equal(del?.path, 'Ticket/20');
  assert.equal(del?.query.get('force_purge'), null, 'trash, not purge');
});

test('merge dry_run writes nothing and counts what is missing on the target', async () => {
  const calls = installFetch((c) => mergeGlpi(c));
  const out = (await call({ target_id: 10, source_ids: [20], dry_run: true })).json();
  assert.equal(out.dry_run, true);
  assert.deepEqual(out.sources[0].would_copy, { description: 1, followups: 1, tasks: 1, documents: 1, actors: 2 });
  assert.ok(calls.every((c) => c.method === 'GET'));
});

test('merge with copy=[] and source_action=close copies the description only and closes', async () => {
  const calls = installFetch((c) => mergeGlpi(c));
  const out = (await call({ target_id: 10, source_ids: [20], copy: [], source_action: 'close' })).json();
  assert.deepEqual(out.sources[0].copied, { description: 1 });
  assert.equal(out.sources[0].source, 'closed');
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put?.path, 'Ticket/20');
  assert.deepEqual(put?.body, { input: { status: 6 } });
  assert.ok(!calls.some((c) => c.path.endsWith('/TicketTask')), 'tasks not read');
});

test('a failed copy leaves the source unlinked and untouched', async () => {
  const calls = installFetch((c) => mergeGlpi(c, { failTask: true }));
  const { result, json: out } = await call({ target_id: 10, source_ids: [20] });
  assert.ok(!result.isError);
  const r = out();
  assert.equal(r.success, false);
  assert.equal(r.failed, 1);
  assert.match(r.sources[0].error, /copy of tasks failed: 400 ERROR_GLPI_ADD boom/);
  assert.deepEqual(r.sources[0].copied, { description: 1, followups: 1 });
  assert.equal(posts(calls, 'Ticket_Ticket').length, 0);
  assert.ok(!calls.some((c) => c.method === 'DELETE'));
});

test('merge checks ids before writing: target among sources, unreadable ticket', async () => {
  let calls = installFetch((c) => mergeGlpi(c));
  const same = await call({ target_id: 10, source_ids: [10, 20] });
  assert.ok(same.result.isError);
  assert.match(same.text, /target_id cannot be one of source_ids/);
  assert.equal(calls.length, 0);

  calls = installFetch((c) =>
    c.path === 'Ticket/21' ? json(['ERROR_ITEM_NOT_FOUND', 'Item not found'], { status: 404 }) : mergeGlpi(c)
  );
  const missing = await call({ target_id: 10, source_ids: [20, 21] });
  assert.ok(missing.result.isError);
  assert.match(missing.text, /ticket 21 cannot be read/);
  assert.ok(calls.every((c) => c.method === 'GET'), 'nothing written');
});
