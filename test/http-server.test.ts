/**
 * Tests for the Streamable HTTP transport and its configuration.
 *
 * Run with: npm test
 *
 * These tests verify:
 *   - transport selection from CLI flags / environment (stdio stays the default)
 *   - the JSON-RPC endpoint: initialize, tools/list, tools/call, stateless reuse
 *   - HTTP edge cases: wrong path, GET/DELETE, malformed and oversize bodies
 *   - optional bearer auth and Host-header (DNS rebinding) validation
 *
 * The MCP server under test is a two-tool stub, so nothing here touches GLPI.
 */

import { strict as assert } from 'node:assert';
import http from 'node:http';
import { test } from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ConfigError,
  type HttpTransportConfig,
  parseTransportConfig,
  startHttpMcpServer,
} from '../src/http-server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG: HttpTransportConfig = {
  host: '127.0.0.1',
  port: 0,
  path: '/mcp',
  allowedHosts: ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'],
  maxBodyBytes: 8 * 1024 * 1024,
};

/** Minimal MCP server: one `echo` tool, so tests need no GLPI. */
function createTestServer(): Server {
  const server = new Server(
    { name: 'test-server', version: '0.0.1' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echo back the text argument.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'echo') {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
    const args = (request.params.arguments ?? {}) as { text?: string };
    return { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] };
  });

  return server;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Raw http.request, so tests control headers (Host included) and body framing. */
function request(
  port: number,
  options: {
    method: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
    /** Send without Content-Length (chunked), to exercise the streaming path. */
    chunked?: boolean;
  }
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const body = options.body;
    const headers: Record<string, string> = { ...options.headers };
    if (body !== undefined && !options.chunked) {
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method,
        path: options.path ?? '/mcp',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );

    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const JSON_RPC_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

function postJsonRpc(
  port: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<RawResponse> {
  return request(port, {
    method: 'POST',
    headers: { ...JSON_RPC_HEADERS, ...extraHeaders },
    body: JSON.stringify(payload),
  });
}

/** Runs `fn` against a freshly started server and always shuts it down. */
async function withServer<T>(
  overrides: Partial<HttpTransportConfig>,
  fn: (port: number) => Promise<T>
): Promise<T> {
  const running = await startHttpMcpServer({
    config: { ...BASE_CONFIG, ...overrides },
    createServer: createTestServer,
  });
  try {
    return await fn(running.port);
  } finally {
    await running.close();
  }
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0' },
  },
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('transport defaults to stdio', () => {
  const config = parseTransportConfig([], {});
  assert.equal(config.mode, 'stdio');
  // HTTP defaults are still resolved, so --help/env dumps can show them.
  assert.equal(config.http.host, '127.0.0.1');
  assert.equal(config.http.port, 3000);
  assert.equal(config.http.path, '/mcp');
  assert.equal(config.http.authToken, undefined);
});

test('--http and MCP_TRANSPORT=http both select the HTTP transport', () => {
  assert.equal(parseTransportConfig(['--http'], {}).mode, 'http');
  assert.equal(parseTransportConfig(['--transport', 'http'], {}).mode, 'http');
  assert.equal(parseTransportConfig(['--transport=http'], {}).mode, 'http');
  assert.equal(parseTransportConfig([], { MCP_TRANSPORT: 'http' }).mode, 'http');
});

test('CLI flags win over environment variables', () => {
  const config = parseTransportConfig(
    ['--transport', 'stdio', '--port', '1234'],
    { MCP_TRANSPORT: 'http', MCP_HTTP_PORT: '9999', MCP_HTTP_HOST: '0.0.0.0' }
  );
  assert.equal(config.mode, 'stdio');
  assert.equal(config.http.port, 1234);
  assert.equal(config.http.host, '0.0.0.0');
});

test('HTTP port falls back to PORT (container platforms) and accepts 0', () => {
  assert.equal(parseTransportConfig([], { PORT: '8080' }).http.port, 8080);
  assert.equal(parseTransportConfig(['--port', '0'], {}).http.port, 0);
  assert.equal(parseTransportConfig([], { MCP_HTTP_PORT: '5000', PORT: '8080' }).http.port, 5000);
});

test('invalid ports are rejected with a helpful message', () => {
  assert.throws(() => parseTransportConfig(['--port', 'nope'], {}), ConfigError);
  assert.throws(() => parseTransportConfig(['--port', '70000'], {}), ConfigError);
  assert.throws(() => parseTransportConfig(['--transport', 'sse'], {}), ConfigError);
  assert.throws(() => parseTransportConfig(['--nope'], {}), ConfigError);
  assert.throws(() => parseTransportConfig(['stray-arg'], {}), ConfigError);
});

test('the endpoint path is normalized', () => {
  assert.equal(parseTransportConfig(['--path', 'glpi'], {}).http.path, '/glpi');
  assert.equal(parseTransportConfig(['--path', '/glpi/'], {}).http.path, '/glpi');
  assert.equal(parseTransportConfig([], { MCP_HTTP_PATH: '/a/b' }).http.path, '/a/b');
});

test('Host validation applies to loopback binds only, and can be overridden', () => {
  const loopback = parseTransportConfig([], {});
  assert.ok(loopback.http.allowedHosts?.includes('127.0.0.1'));
  // Docker Desktop's alias for the host — the documented Open WebUI setup.
  assert.ok(loopback.http.allowedHosts?.includes('host.docker.internal'));

  // Bound to a public interface we cannot know the legitimate names.
  assert.equal(parseTransportConfig(['--host', '0.0.0.0'], {}).http.allowedHosts, undefined);

  const custom = parseTransportConfig([], { MCP_HTTP_ALLOWED_HOSTS: 'Glpi.Example.COM, localhost' });
  assert.deepEqual(custom.http.allowedHosts, ['glpi.example.com', 'localhost']);
});

test('the auth token comes from the environment only', () => {
  assert.equal(parseTransportConfig([], { MCP_HTTP_AUTH_TOKEN: '  s3cret  ' }).http.authToken, 's3cret');
  assert.equal(parseTransportConfig([], { MCP_HTTP_AUTH_TOKEN: '   ' }).http.authToken, undefined);
});

// ---------------------------------------------------------------------------
// Endpoint behaviour
// ---------------------------------------------------------------------------

test('initialize answers with server info and issues no session id (stateless)', async () => {
  await withServer({}, async (port) => {
    const res = await postJsonRpc(port, INITIALIZE);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json');
    assert.equal(res.headers['mcp-session-id'], undefined);

    const body = JSON.parse(res.body);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.result.serverInfo.name, 'test-server');
    assert.ok(body.result.protocolVersion);
  });
});

test('tools/list and tools/call round-trip over plain JSON-RPC POSTs', async () => {
  await withServer({}, async (port) => {
    // No session id is carried between requests — each POST stands alone.
    const list = JSON.parse((await postJsonRpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body);
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ['echo']);

    const call = JSON.parse(
      (
        await postJsonRpc(port, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'echo', arguments: { text: 'hi' } },
        })
      ).body
    );
    assert.equal(call.result.content[0].text, 'echo:hi');
  });
});

test('a tool failure comes back as a JSON-RPC error, not a dead connection', async () => {
  await withServer({}, async (port) => {
    const res = await postJsonRpc(port, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'does_not_exist', arguments: {} },
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).error.code, ErrorCode.MethodNotFound);
  });
});

test('requests are independent: one client cannot break another', async () => {
  await withServer({}, async (port) => {
    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map((id) => postJsonRpc(port, { ...INITIALIZE, id }))
    );
    for (const [index, res] of responses.entries()) {
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).id, index + 1);
    }
  });
});

test('only POST is served on the MCP endpoint', async () => {
  await withServer({}, async (port) => {
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const res = await request(port, { method, headers: JSON_RPC_HEADERS });
      assert.equal(res.status, 405, `${method} should be rejected`);
      assert.equal(JSON.parse(res.body).error.code, -32000);
    }
  });
});

test('unknown paths 404 and /health answers without auth', async () => {
  await withServer({}, async (port) => {
    const missing = await postJsonRpc(port, INITIALIZE, {});
    assert.equal(missing.status, 200); // sanity: the real path works

    const wrongPath = await request(port, {
      method: 'POST',
      path: '/nope',
      headers: JSON_RPC_HEADERS,
      body: JSON.stringify(INITIALIZE),
    });
    assert.equal(wrongPath.status, 404);
    assert.equal(JSON.parse(wrongPath.body).error.code, -32601);

    const health = await request(port, { method: 'GET', path: '/health' });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).status, 'ok');
  });
});

test('malformed bodies are reported as JSON-RPC parse errors', async () => {
  await withServer({}, async (port) => {
    const res = await request(port, {
      method: 'POST',
      headers: JSON_RPC_HEADERS,
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error.code, -32700);
  });
});

test('oversize bodies are rejected instead of buffered', async () => {
  await withServer({ maxBodyBytes: 64 }, async (port) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', pad: 'x'.repeat(200) });

    // Declared length: rejected before reading anything.
    const declared = await request(port, { method: 'POST', headers: JSON_RPC_HEADERS, body: payload });
    assert.equal(declared.status, 413);
    assert.equal(JSON.parse(declared.body).error.code, -32000);

    // Chunked (no length known upfront): the response still arrives intact.
    const streamed = await request(port, {
      method: 'POST',
      headers: JSON_RPC_HEADERS,
      body: payload,
      chunked: true,
    });
    assert.equal(streamed.status, 413);
    assert.equal(JSON.parse(streamed.body).error.code, -32000);
  });
});

// ---------------------------------------------------------------------------
// Auth and Host validation
// ---------------------------------------------------------------------------

test('with MCP_HTTP_AUTH_TOKEN set, only a matching bearer token is served', async () => {
  await withServer({ authToken: 's3cret' }, async (port) => {
    const anonymous = await postJsonRpc(port, INITIALIZE);
    assert.equal(anonymous.status, 401);
    assert.match(String(anonymous.headers['www-authenticate']), /Bearer/);

    const wrong = await postJsonRpc(port, INITIALIZE, { Authorization: 'Bearer nope' });
    assert.equal(wrong.status, 401);

    const accepted = await postJsonRpc(port, INITIALIZE, { Authorization: 'Bearer s3cret' });
    assert.equal(accepted.status, 200);

    // Liveness probes must not require the token (container healthchecks).
    const health = await request(port, { method: 'GET', path: '/health' });
    assert.equal(health.status, 200);
  });
});

test('Host headers outside the allowlist are refused (DNS rebinding)', async () => {
  await withServer({}, async (port) => {
    const rebinding = await postJsonRpc(port, INITIALIZE, { Host: 'attacker.example' });
    assert.equal(rebinding.status, 403);
    assert.equal(JSON.parse(rebinding.body).error.code, -32000);

    // The Docker Desktop alias stays allowed for the documented setup.
    const docker = await postJsonRpc(port, INITIALIZE, { Host: 'host.docker.internal' });
    assert.equal(docker.status, 200);
  });
});

test('a public bind address disables Host validation', async () => {
  // The bind address says nothing about which names are legitimate, so the
  // allowlist is dropped (startup logs a warning about it).
  await withServer({ host: '0.0.0.0', allowedHosts: undefined }, async (port) => {
    const res = await postJsonRpc(port, INITIALIZE, { Host: 'glpi.internal' });
    assert.equal(res.status, 200);
  });
});
