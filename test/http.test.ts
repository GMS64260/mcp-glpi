/**
 * Integration tests for GlpiHttp using a mocked fetch.
 *
 * Run with: npm test
 *
 * These tests verify:
 *   - Session initialization with user_token
 *   - Auto re-authentication on 401
 *   - 5xx retry with exponential backoff
 *   - Structured error parsing of GLPI ["CODE", "message"] body
 */

import { strict as assert } from 'node:assert';
import { test, beforeEach, mock } from 'node:test';
import { GlpiHttp, GlpiError } from '../src/http.js';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function installFetch(handler: FetchHandler) {
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(handler);
}

beforeEach(() => {
  // Reset between tests
});

test('initSession with userToken stores session_token', async () => {
  installFetch(async (url) => {
    assert.match(url, /\/apirest\.php\/initSession$/);
    return new Response(JSON.stringify({ session_token: 'sess-abc' }), { status: 200 });
  });

  const http = new GlpiHttp({ url: 'https://glpi.test', userToken: 'user-123' });
  const token = await http.initSession();
  assert.equal(token, 'sess-abc');
  assert.equal(http.session, 'sess-abc');
});

test('request() re-authenticates on 401 and retries once', async () => {
  let initCalls = 0;
  let requestCalls = 0;

  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      initCalls++;
      return new Response(JSON.stringify({ session_token: `sess-${initCalls}` }), { status: 200 });
    }
    requestCalls++;
    if (requestCalls === 1) {
      return new Response('["ERROR_SESSION_TOKEN_INVALID", "session expired"]', { status: 401 });
    }
    return new Response(JSON.stringify([{ id: 42, name: 'PC-01' }]), { status: 200 });
  });

  const http = new GlpiHttp({ url: 'https://glpi.test', userToken: 'u' });
  await http.initSession();

  const result = await http.request<{ id: number; name: string }[]>('Computer');
  assert.equal(result.data[0].id, 42);
  assert.equal(initCalls, 2, 'should have re-authenticated once');
  assert.equal(requestCalls, 2);
});

test('concurrent first requests open a single GLPI session', async () => {
  let initCalls = 0;

  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      initCalls++;
      // Hold the response open so all three requests race the init.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ session_token: 'sess-shared' }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });

  const http = new GlpiHttp({ url: 'https://glpi.test', userToken: 'u' });
  await Promise.all([http.request('Computer'), http.request('Computer'), http.request('Computer')]);

  assert.equal(initCalls, 1, 'concurrent requests must share one session');
  assert.equal(http.session, 'sess-shared');
});

test('a failed init is not cached, so the next request retries', async () => {
  let initCalls = 0;

  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      initCalls++;
      if (initCalls === 1) throw new Error('connection refused');
      return new Response(JSON.stringify({ session_token: 'sess-2' }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });

  const http = new GlpiHttp({ url: 'https://glpi.test', userToken: 'u', maxRetries: 0 });
  await assert.rejects(() => Promise.all([http.request('Computer'), http.request('Computer')]));

  await http.request('Computer');
  assert.equal(initCalls, 2);
  assert.equal(http.session, 'sess-2');
});

test('5xx triggers retry with backoff', async () => {
  let attempts = 0;

  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    attempts++;
    if (attempts < 3) {
      return new Response('upstream error', { status: 503 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });

  const http = new GlpiHttp({
    url: 'https://glpi.test',
    userToken: 'u',
    maxRetries: 3,
    retryBaseDelayMs: 1,
  });
  await http.initSession();
  await http.request('Computer');
  assert.equal(attempts, 3);
});

test('429 is retried, honouring Retry-After', async () => {
  let attempts = 0;

  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    attempts++;
    if (attempts === 1) {
      return new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '0' },
      });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });

  const http = new GlpiHttp({
    url: 'https://glpi.test',
    userToken: 'u',
    retryBaseDelayMs: 1,
  });
  await http.initSession();
  await http.request('Computer');
  assert.equal(attempts, 2);
});

test('network error is retried with backoff', async () => {
  let attempts = 0;

  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    attempts++;
    if (attempts === 1) throw new TypeError('fetch failed: ECONNRESET');
    return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
  });

  const http = new GlpiHttp({
    url: 'https://glpi.test',
    userToken: 'u',
    retryBaseDelayMs: 1,
  });
  await http.initSession();
  const result = await http.request<{ id: number }[]>('Computer');
  assert.equal(result.data[0].id, 1);
  assert.equal(attempts, 2);
});

test('request aborts after timeoutMs', async () => {
  installFetch(async (url, init) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    // Simulate a hanging request that only resolves via abort signal.
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });

  const http = new GlpiHttp({
    url: 'https://glpi.test',
    userToken: 'u',
    timeoutMs: 20,
    maxRetries: 0,
  });
  await http.initSession();

  await assert.rejects(
    () => http.request('Computer'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /timeout after 20ms/);
      return true;
    }
  );
});

test('error body ["CODE","message"] is parsed into GlpiError', async () => {
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    return new Response('["ERROR_BAD_INPUT", "Missing required field"]', { status: 400 });
  });

  const http = new GlpiHttp({ url: 'https://glpi.test', userToken: 'u' });
  await http.initSession();

  await assert.rejects(
    () => http.request('Ticket', { method: 'POST', json: { input: {} } }),
    (err: unknown) => {
      assert.ok(err instanceof GlpiError);
      assert.equal(err.status, 400);
      assert.equal(err.glpiCode, 'ERROR_BAD_INPUT');
      assert.equal(err.glpiMessage, 'Missing required field');
      return true;
    }
  );
});
