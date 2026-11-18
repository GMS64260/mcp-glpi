/**
 * glpi_get_item_logs: one page of `{itemtype}/{id}/Log`, total from Content-Range.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GlpiClient } from '../src/glpi-client.js';
import { createMcpServer } from '../src/server.js';

test('glpi_get_item_logs reads one page of the item history', async () => {
  const calls: URL[] = [];
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/initSession')) return Response.json({ session_token: 's' });
    calls.push(u);
    return Response.json([{ id: 7, linked_action: 0 }, { id: 6, linked_action: 0 }], {
      status: 206,
      headers: { 'Content-Range': '20-21/53210' },
    });
  });
  const server = createMcpServer({ client: new GlpiClient({ url: 'https://glpi.test', userToken: 'u', maxRetries: 0 }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const result = (await client.callTool({
    name: 'glpi_get_item_logs',
    arguments: { itemtype: 'Computer', id: 3, start: 20, limit: 2 },
  })) as CallToolResult;
  await client.close();

  assert.ok(!result.isError);
  const out = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(out.totalcount, 53210);
  assert.deepEqual(out.items.map((r: { id: number }) => r.id), [7, 6]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/apirest.php/Computer/3/Log');
  assert.equal(calls[0].searchParams.get('range'), '20-21');
  assert.equal(calls[0].searchParams.get('with_logs'), null);
});
