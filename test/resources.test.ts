/**
 * MCP resources and resource templates through the real McpServer, an
 * in-memory transport and a fake GLPI behind `fetch`.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GlpiClient } from '../src/glpi-client.js';
import { TICKET_RESOURCE_ENTRY_CHARS, TICKET_RESOURCE_TIMELINE } from '../src/resources.js';
import { createMcpServer } from '../src/server.js';
import { parseRegistryOptions } from '../src/tools/registry.js';

interface FetchCall {
  method: string;
  path: string;
  query: URLSearchParams;
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });

async function connect(route: (call: FetchCall) => Response | undefined = () => undefined) {
  const calls: FetchCall[] = [];
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/apirest\.php\//, '');
    if (path === 'initSession') return json({ session_token: 's' });
    const call = { method: init?.method ?? 'GET', path, query: u.searchParams };
    calls.push(call);
    return route(call) ?? json([]);
  });
  const glpi = new GlpiClient({ url: 'https://glpi.test', userToken: 'u', maxRetries: 0 });
  const server = createMcpServer({ client: glpi });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, calls, close: () => client.close() };
}

const readJson = async (client: Client, uri: string) => {
  const r = await client.readResource({ uri });
  assert.equal(r.contents[0].mimeType, 'application/json');
  const text = (r.contents[0] as { text: string }).text;
  assert.ok(!text.includes('\n  '), 'compact JSON');
  return JSON.parse(text);
};

/** criteria[i][field|searchtype|value|link] of a search call. */
function criteria(q: URLSearchParams) {
  const out: Array<Record<string, string>> = [];
  for (const [k, v] of q) {
    const m = /^criteria\[(\d+)\]\[(\w+)\]$/.exec(k);
    if (m) (out[Number(m[1])] ??= {})[m[2]] = v;
  }
  return out;
}

test('resources/list and resources/templates/list; capability listChanged false', async () => {
  const { client, close } = await connect();
  assert.deepEqual(client.getServerCapabilities()?.resources, { listChanged: false });
  const { resources } = await client.listResources();
  const { resourceTemplates } = await client.listResourceTemplates();
  await close();
  assert.deepEqual(
    resources.map((r) => r.uri).sort(),
    [
      'glpi://categories', 'glpi://changes/pending', 'glpi://computers', 'glpi://groups', 'glpi://problems/open',
      'glpi://stats/assets', 'glpi://stats/tickets', 'glpi://tickets/open', 'glpi://tickets/recent',
    ]
  );
  assert.deepEqual(resourceTemplates.map((t) => t.uriTemplate).sort(), ['glpi://kb/{id}', 'glpi://ticket/{id}', 'glpi://user/{id}']);
  for (const r of [...resources, ...resourceTemplates]) {
    assert.ok(r.title && r.description, `${r.name} has title and description`);
    assert.equal(r.mimeType, 'application/json');
  }
});

test('glpi://ticket/{id}: compact ticket with status_label, plain text, last 10 timeline entries truncated', async () => {
  const followups = Array.from({ length: 12 }, (_, i) => ({
    id: 100 + i,
    users_id: 'tech',
    content: i === 11 ? `&lt;p&gt;${'x'.repeat(TICKET_RESOURCE_ENTRY_CHARS + 50)}&lt;/p&gt;` : `<p>followup ${i}</p>`,
    date_creation: `2026-10-${String(i + 1).padStart(2, '0')} 10:00:00`,
    links: [{ rel: 'User', href: 'x' }],
  }));
  const { client, calls, close } = await connect((c) => {
    if (c.path === 'Ticket/5') {
      return json({
        id: 5, name: 'Printer down', status: 2, urgency: 4, priority: 4, content: '&lt;p&gt;It &amp;amp; fails&lt;/p&gt;',
        users_id_lastupdater: 3, links: [{ rel: 'Entity', href: 'x' }],
      });
    }
    if (c.path === 'Ticket/5/ITILFollowup') return json(followups);
    if (c.path === 'Ticket/5/ITILSolution') return json([{ id: 9, content: 'Rebooted', date_creation: '2026-10-30 09:00:00', status: 2 }]);
    return undefined;
  });
  const t = await readJson(client, 'glpi://ticket/5');
  await close();
  assert.equal(t.id, 5);
  assert.equal(t.status_label, 'Processing (assigned)');
  assert.equal(t.urgency_label, 'High');
  assert.equal(t.content, 'It & fails');
  assert.equal(t.links, undefined);
  assert.equal(t.users_id_lastupdater, undefined, 'compact projection');
  assert.equal(t.timeline_total, 13);
  assert.equal(t.timeline.length, TICKET_RESOURCE_TIMELINE);
  assert.equal(t.timeline.at(-1).kind, 'solution');
  assert.equal(t.timeline[0].id, 103, 'oldest entries dropped');
  const long = t.timeline.find((e: { id: number }) => e.id === 111);
  assert.match(long.content, /…\[truncated, \d+ chars\]$/);
  assert.equal(long.links, undefined);
  for (const c of calls) assert.equal(c.query.get('get_hateoas'), 'false', `${c.path} without HATEOAS`);
});

test('glpi://kb/{id} returns the answer as text; glpi://user/{id} is compact; bad ids are rejected', async () => {
  const { client, close } = await connect((c) => {
    if (c.path === 'KnowbaseItem/4') return json({ id: 4, name: 'VPN', answer: '&lt;h2&gt;Steps&lt;/h2&gt;&lt;p&gt;Reboot&lt;/p&gt;', is_faq: 0 });
    if (c.path === 'User/2') return json({ id: 2, name: 'jdoe', realname: 'Doe', firstname: 'John', password: 'hash', api_token: 't' });
    return undefined;
  });
  const kb = await readJson(client, 'glpi://kb/4');
  const user = await readJson(client, 'glpi://user/2');
  await assert.rejects(client.readResource({ uri: 'glpi://ticket/abc' }));
  await close();
  assert.equal(kb.answer, 'Steps\nReboot');
  assert.deepEqual(user, { id: 2, name: 'jdoe', realname: 'Doe', firstname: 'John' });
});

test('glpi://changes/pending sends status IN (1,2,3,4,7,9,10,11,12); problems/open excludes 5 and 6', async () => {
  const rows = { totalcount: 1, count: 1, data: [{ 2: 7, 1: 'Upgrade', 12: 10 }] };
  const { client, calls, close } = await connect((c) => (c.path.startsWith('search/') ? json(rows) : undefined));
  const changes = await readJson(client, 'glpi://changes/pending');
  await readJson(client, 'glpi://problems/open');
  await close();
  const changeCrit = criteria(calls.find((c) => c.path === 'search/Change')!.query);
  assert.deepEqual(changeCrit.map((c) => Number(c.value)), [1, 2, 3, 4, 7, 9, 10, 11, 12]);
  assert.ok(changeCrit.every((c) => c.searchtype === 'equals'));
  assert.ok(changeCrit.slice(1).every((c) => c.link === 'OR'));
  const problemCrit = criteria(calls.find((c) => c.path === 'search/Problem')!.query);
  assert.deepEqual(problemCrit.map((c) => Number(c.value)), [1, 2, 3, 4, 7, 8]);
  assert.deepEqual(Object.keys(changes).sort(), ['count', 'items', 'next_start', 'start', 'totalcount']);
  assert.equal(changes.totalcount, 1);
});

test('glpi://tickets/open uses status notold and returns the list envelope; computers are compact', async () => {
  const { client, calls, close } = await connect((c) => {
    if (c.path === 'search/Ticket') return json({ totalcount: 1, count: 1, data: [{ 2: 1, 12: 4 }] });
    if (c.path === 'Computer') {
      return json([{ id: 1, name: 'PC-1', serial: 'S', computertypes_id: 'Laptop', ticket_tco: '0.00', links: [] }], {
        'Content-Range': '0-0/42',
      });
    }
    return undefined;
  });
  const open = await readJson(client, 'glpi://tickets/open');
  const computers = await readJson(client, 'glpi://computers');
  await close();
  const crit = criteria(calls.find((c) => c.path === 'search/Ticket')!.query);
  assert.deepEqual(crit, [{ field: '12', searchtype: 'equals', value: 'notold' }]);
  assert.equal(open.totalcount, 1);
  assert.equal(open.items.length, 1);
  assert.equal(computers.totalcount, 42);
  assert.equal(computers.next_start, 1);
  assert.deepEqual(computers.items[0], { id: 1, name: 'PC-1', serial: 'S', computertypes_id: 'Laptop' });
});

test('resources and resource templates follow GLPI_TOOLSETS', async () => {
  const uris = async (env: Record<string, string>) => {
    const glpi = new GlpiClient({ url: 'https://glpi.test', userToken: 'u', maxRetries: 0 });
    const server = createMcpServer({ client: glpi, options: parseRegistryOptions(env) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();
    await client.close();
    return { fixed: resources.map((r) => r.uri).sort(), templates: resourceTemplates.map((t) => t.uriTemplate).sort() };
  };
  const all = await uris({});
  assert.ok(['glpi://tickets/open', 'glpi://tickets/recent', 'glpi://problems/open', 'glpi://changes/pending'].every((u) => all.fixed.includes(u)));

  const assets = await uris({ GLPI_TOOLSETS: 'assets' });
  assert.ok(!assets.fixed.some((u) => /^glpi:\/\/(tickets|problems|changes)\//.test(u)), assets.fixed.join(' '));
  assert.ok(assets.fixed.includes('glpi://computers'));
  assert.deepEqual(all.templates, ['glpi://kb/{id}', 'glpi://ticket/{id}', 'glpi://user/{id}']);
  // Each template needs the toolset of its tools (tickets, kb, users).
  assert.deepEqual(assets.templates, []);

  const tickets = await uris({ GLPI_TOOLSETS: 'tickets' });
  assert.ok(tickets.fixed.includes('glpi://tickets/open') && tickets.fixed.includes('glpi://tickets/recent'));
  assert.ok(!tickets.fixed.includes('glpi://problems/open') && !tickets.fixed.includes('glpi://changes/pending'));
  assert.deepEqual(tickets.templates, ['glpi://ticket/{id}']);
  assert.deepEqual((await uris({ GLPI_TOOLSETS: 'kb,users' })).templates, ['glpi://kb/{id}', 'glpi://user/{id}']);

  const itil = await uris({ GLPI_TOOLSETS: 'itil', GLPI_READ_ONLY: '1' });
  assert.ok(itil.fixed.includes('glpi://problems/open') && itil.fixed.includes('glpi://changes/pending'));
  assert.ok(!itil.fixed.includes('glpi://tickets/open'));
});
