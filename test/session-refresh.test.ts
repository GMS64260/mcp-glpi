/**
 * Session renewal (issue #13) and restoration of the session context.
 *
 *   - A read answered 403 ERROR_RIGHT_MISSING renews a session older than
 *     rightsRefreshIntervalMs, closes the old one and retries once.
 *   - A young session, a write, or a second 403 is not retried.
 *   - Every new session (renewal or 401 re-authentication) gets back the
 *     profile and entity chosen with changeActiveProfile / changeActiveEntities.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { GlpiError, GlpiHttp } from '../src/http.js';
import { GlpiClient } from '../src/glpi-client.js';

interface Call {
  path: string;
  method: string;
  token?: string;
  body?: unknown;
}

const RIGHT_MISSING = '["ERROR_RIGHT_MISSING","You don\'t have permission to perform this action."]';

/**
 * Fake GLPI: initSession hands out sess-1, sess-2...; `handle` answers the
 * other calls (undefined -> 200 []). Every call is recorded.
 */
function fakeGlpi(handle: (call: Call, sessions: number) => Response | undefined) {
  const calls: Call[] = [];
  let sessions = 0;
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/apirest\.php\//, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      path,
      method: init?.method ?? 'GET',
      token: headers['Session-Token'],
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (path === 'initSession') {
      sessions++;
      return new Response(JSON.stringify({ session_token: `sess-${sessions}` }), { status: 200 });
    }
    return handle(call, sessions) ?? new Response('[]', { status: 200 });
  });
  return { calls };
}

const forbiddenWith = (token: string) => (call: Call) =>
  call.path === 'Entity/42' && call.token === token ? new Response(RIGHT_MISSING, { status: 403 }) : undefined;

test('403 ERROR_RIGHT_MISSING on a read renews an old session, closes the old one and retries', async () => {
  const { calls } = fakeGlpi((call) =>
    forbiddenWith('sess-1')(call) ??
    (call.path === 'Entity/42' ? new Response('{"id":42,"name":"New entity"}', { status: 200 }) : undefined)
  );
  const http = new GlpiHttp({ url: 'https://glpi.test', userToken: 'u', rightsRefreshIntervalMs: 0 });
  await http.initSession();

  const { data } = await http.request<{ id: number }>('Entity/42');
  assert.equal(data.id, 42);
  assert.equal(http.session, 'sess-2');
  const reads = calls.filter((c) => c.path === 'Entity/42').map((c) => c.token);
  assert.deepEqual(reads, ['sess-1', 'sess-2']);
  // The abandoned session is closed, with its own token.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.some((c) => c.path === 'killSession' && c.token === 'sess-1'));
});

test('a session younger than rightsRefreshIntervalMs is kept: the 403 is a real missing right', async () => {
  const { calls } = fakeGlpi(forbiddenWith('sess-1'));
  const http = new GlpiHttp({ url: 'https://glpi.test', userToken: 'u' }); // default 60 s
  await http.initSession();

  await assert.rejects(http.request('Entity/42'), (err: unknown) => {
    assert.ok(err instanceof GlpiError);
    assert.equal(err.status, 403);
    assert.equal(err.glpiCode, 'ERROR_RIGHT_MISSING');
    return true;
  });
  assert.equal(calls.filter((c) => c.path === 'initSession').length, 1);
  assert.equal(calls.filter((c) => c.path === 'Entity/42').length, 1);
});

test('the renewal is tried once: a 403 on the new session is returned', async () => {
  const { calls } = fakeGlpi((call) => (call.path === 'Entity/42' ? new Response(RIGHT_MISSING, { status: 403 }) : undefined));
  const http = new GlpiHttp({ url: 'https://glpi.test', userToken: 'u', rightsRefreshIntervalMs: 0 });
  await http.initSession();

  await assert.rejects(http.request('Entity/42'), GlpiError);
  assert.equal(calls.filter((c) => c.path === 'initSession').length, 2);
  assert.equal(calls.filter((c) => c.path === 'Entity/42').length, 2);
});

test('writes and other 403 codes do not renew the session', async () => {
  const { calls } = fakeGlpi((call) => {
    if (call.path === 'Project' && call.method === 'POST') return new Response(RIGHT_MISSING, { status: 403 });
    if (call.path === 'Entity/7') return new Response('["ERROR_NOT_ALLOWED_IP","nope"]', { status: 403 });
    return undefined;
  });
  const http = new GlpiHttp({ url: 'https://glpi.test', userToken: 'u', rightsRefreshIntervalMs: 0 });
  await http.initSession();

  await assert.rejects(http.request('Project', { method: 'POST', json: { input: { name: 'x' } } }), GlpiError);
  await assert.rejects(http.request('Entity/7'), GlpiError);
  assert.equal(calls.filter((c) => c.path === 'initSession').length, 1);
});

test('concurrent 403s open a single new session', async () => {
  const { calls } = fakeGlpi((call) => (call.path.startsWith('Entity/') && call.token === 'sess-1' ? new Response(RIGHT_MISSING, { status: 403 }) : undefined));
  const http = new GlpiHttp({ url: 'https://glpi.test', userToken: 'u', rightsRefreshIntervalMs: 0 });
  await http.initSession();

  await Promise.all([http.request('Entity/1'), http.request('Entity/2'), http.request('Entity/3')]);
  assert.equal(calls.filter((c) => c.path === 'initSession').length, 2);
  assert.equal(http.session, 'sess-2');
});

test('a new session gets back the chosen profile, then entity (401 re-authentication and 403 renewal)', async () => {
  let expireNext = false;
  const { calls } = fakeGlpi((call) => {
    if (call.path === 'Ticket' && expireNext) {
      expireNext = false;
      return new Response('["ERROR_SESSION_TOKEN_INVALID","expired"]', { status: 401 });
    }
    return forbiddenWith('sess-2')(call);
  });
  const client = new GlpiClient({ url: 'https://glpi.test', userToken: 'u', rightsRefreshIntervalMs: 0 });
  await client.initSession();
  await client.changeActiveProfile(4);
  await client.changeActiveEntities(12, true);

  const restoredWith = (token: string) =>
    calls.filter((c) => c.token === token && c.path.startsWith('changeActive')).map((c) => [c.path, c.body]);

  expireNext = true;
  await client.http.request('Ticket');
  assert.deepEqual(restoredWith('sess-2'), [
    ['changeActiveProfile', { profiles_id: 4 }],
    ['changeActiveEntities', { entities_id: 12, is_recursive: true }],
  ]);

  await client.http.request('Entity/42');
  assert.equal(client.http.session, 'sess-3');
  assert.deepEqual(restoredWith('sess-3'), restoredWith('sess-2'));
});

test('changing the profile forgets the chosen entity (GLPI resets it)', async () => {
  const { calls } = fakeGlpi(() => undefined);
  const client = new GlpiClient({ url: 'https://glpi.test', userToken: 'u' });
  await client.initSession();
  await client.changeActiveEntities(12);
  await client.changeActiveProfile(4);
  await client.http.killSession();
  await client.initSession();
  const restored = calls.filter((c) => c.token === 'sess-2').map((c) => c.path);
  assert.deepEqual(restored, ['changeActiveProfile']);
});

test('a failed restoration does not fail the session', async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  try {
    fakeGlpi((call) => (call.path === 'changeActiveProfile' && call.token === 'sess-2' ? new Response('["ERROR","gone"]', { status: 400 }) : undefined));
    const client = new GlpiClient({ url: 'https://glpi.test', userToken: 'u' });
    await client.initSession();
    await client.changeActiveProfile(9);
    await client.http.killSession();
    assert.equal(await client.initSession(), 'sess-2');
    assert.match(String(errors[0]), /could not restore the session context/);
  } finally {
    console.error = original;
  }
});
