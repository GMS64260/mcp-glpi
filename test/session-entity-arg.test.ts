/**
 * glpi_set_active_entity: the active entity is an id like any other.
 *
 * `glpi_set_active_profile` (and every other id argument) coerces a numeric
 * string through `numericString`, and the README says "Ids must be positive
 * integers (numeric strings are accepted)". `glpi_set_active_entity` built its
 * schema from a bare `z.union([number, 'all'])`, so `{"entity_id": "3"}` came
 * back as a *protocol* error ("Invalid arguments ... entity_id: Invalid
 * input") instead of switching the entity, while `3` and `"all"` worked.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GlpiClient } from '../src/glpi-client.js';
import { runTool } from '../src/tools/registry.js';
import { USER_TOOLS } from '../src/tools/users.js';

type Call = { method: string; path: string; body?: unknown };

function installFetch(): Call[] {
  const calls: Call[] = [];
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    calls.push({
      method: init?.method ?? 'GET',
      path: new URL(url).pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify([]), { status: 200 });
  });
  return calls;
}

const setActiveEntity = USER_TOOLS.find((t) => t.name === 'glpi_set_active_entity')!;

const context = () => ({
  client: new GlpiClient({ url: 'https://glpi.test', userToken: 'u', maxRetries: 0 }),
  options: {},
});

const payload = (result: CallToolResult) => JSON.parse((result.content[0] as { text: string }).text);

test('a numeric-string entity id is coerced instead of rejected', async () => {
  const calls = installFetch();
  const result = await runTool(setActiveEntity, context(), { entity_id: '3', is_recursive: true });

  assert.deepEqual(payload(result), { success: true, entity_id: 3, is_recursive: true });
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/apirest.php/changeActiveEntities',
      body: { entities_id: 3, is_recursive: true },
    },
  ]);
});

test('a number and "all" keep working', async () => {
  const calls = installFetch();
  await runTool(setActiveEntity, context(), { entity_id: 0 });
  await runTool(setActiveEntity, context(), { entity_id: 'all' });

  assert.deepEqual(calls.map((c) => c.body), [
    { entities_id: 0, is_recursive: false },
    { entities_id: 'all', is_recursive: false },
  ]);
});

test('anything else is still refused, naming the argument', async () => {
  installFetch();
  await assert.rejects(
    () => runTool(setActiveEntity, context(), { entity_id: '3abc' }),
    (error: unknown) => error instanceof McpError && /entity_id/.test(error.message)
  );
});
