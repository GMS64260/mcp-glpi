/**
 * Streamable HTTP transport for the MCP server (Open WebUI and other web clients).
 *
 * The stdio transport wired up in index.ts serves exactly one local client.
 * This module adds the second MCP transport: a Streamable HTTP endpoint that
 * speaks JSON-RPC over POST so browser-based / multi-tenant clients — Open
 * WebUI only supports "MCP (Streamable HTTP)", never stdio or SSE — can reach
 * the same tools.
 *
 * Two decisions worth knowing before editing:
 *
 * - **Stateless.** `Protocol.connect()` throws if a transport is already
 *   attached, so a single `Server` instance serves exactly one connection. Web
 *   clients send each JSON-RPC message as its own HTTP request, and the SDK
 *   additionally refuses to let a stateless transport handle more than one
 *   request. So every POST gets a fresh `Server` + transport pair. All of them
 *   share the module-level `GlpiClient`, i.e. exactly one GLPI session per
 *   process — requests are not isolated per MCP client.
 * - **JSON responses** (`enableJsonResponse`). Nothing in this server pushes
 *   messages to the client (no progress or logging notifications), so an SSE
 *   stream would only add buffering and disconnect edge cases. One JSON body
 *   per POST is also trivial to reproduce with curl.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export type TransportMode = 'stdio' | 'http';

export interface HttpTransportConfig {
  host: string;
  port: number;
  path: string;
  /** When set, every MCP request must send `Authorization: Bearer <token>`. */
  authToken?: string;
  /** Host-header allowlist (DNS-rebinding protection). Undefined = disabled. */
  allowedHosts?: string[];
  maxBodyBytes: number;
}

export interface TransportConfig {
  mode: TransportMode;
  http: HttpTransportConfig;
}

export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 3000;
export const DEFAULT_HTTP_PATH = '/mcp';
export const HEALTH_PATH = '/health';
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Bind addresses that mean "this machine only". */
const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']);
/** Host headers accepted when bound to loopback — plus the Docker Desktop
 *  alias, which is how a containerised Open WebUI reaches the host. */
const DOCKER_HOST_ALIAS = 'host.docker.internal';
const LOOPBACK_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]', DOCKER_HOST_ALIAS];

export class ConfigError extends Error {}

export const USAGE = `Usage: mcp-glpi [options]

Transports:
  stdio (default)   MCP over stdin/stdout — Claude Desktop, Claude Code, Cursor
  http              MCP Streamable HTTP — Open WebUI, other web clients

Options:
  --http                 Shorthand for --transport http
  --transport <mode>     stdio | http
  --host <host>          HTTP bind address (default ${DEFAULT_HTTP_HOST})
  --port <port>          HTTP port, 0 picks a free port (default ${DEFAULT_HTTP_PORT})
  --path <path>          HTTP endpoint path (default ${DEFAULT_HTTP_PATH})
  -h, --help             Show this help

Environment (CLI flags win):
  MCP_TRANSPORT, MCP_HTTP_HOST, MCP_HTTP_PORT, MCP_HTTP_PATH,
  MCP_HTTP_AUTH_TOKEN, MCP_HTTP_ALLOWED_HOSTS (comma-separated)
  GLPI_URL, GLPI_APP_TOKEN, GLPI_USER_TOKEN | GLPI_USERNAME + GLPI_PASSWORD

HTTP mode:
  POST ${DEFAULT_HTTP_PATH}      JSON-RPC (MCP Streamable HTTP)
  GET  ${HEALTH_PATH}   liveness probe
  GET  ${DEFAULT_HTTP_PATH}      not supported (this server is stateless)`;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parseFlags(argv: readonly string[]): Map<string, string | true> {
  const known = new Set(['http', 'transport', 'host', 'port', 'path', 'help']);
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      throw new ConfigError(`Unexpected argument "${arg}"`);
    }
    const [rawName, inlineValue] = splitFlag(arg);
    const name = rawName.replace(/^--?/, '');
    if (!known.has(name)) {
      throw new ConfigError(`Unknown option "${rawName}"`);
    }
    if (name === 'http' || name === 'help') {
      if (inlineValue !== undefined) throw new ConfigError(`Option "${rawName}" takes no value`);
      flags.set(name, true);
      continue;
    }
    const value = inlineValue ?? argv[++i];
    if (value === undefined) throw new ConfigError(`Option "${rawName}" requires a value`);
    flags.set(name, value);
  }

  return flags;
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=');
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

function parsePort(value: string, source: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`Invalid ${source}: "${value}" (expected an integer 0-65535)`);
  }
  return port;
}

function normalizePath(raw: string): string {
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const trimmed = withLeadingSlash.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Host-header allowlist for DNS-rebinding protection.
 *
 * Only meaningful when we know which names are legitimate: bound to loopback
 * we do, bound to `0.0.0.0` any public name may arrive and the check has to be
 * switched off (a warning is printed at startup).
 */
function resolveAllowedHosts(explicit: string | undefined, host: string): string[] | undefined {
  const listed = (explicit ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (listed.length > 0) return listed;

  return LOOPBACK_BIND_HOSTS.has(host.toLowerCase()) ? [...LOOPBACK_ALLOWED_HOSTS] : undefined;
}

/**
 * Resolve the transport from CLI flags and environment, CLI winning.
 *
 * Defaults to stdio so existing `npx mcp-glpi` configs keep working untouched.
 */
export function parseTransportConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): TransportConfig {
  const flags = parseFlags(argv);

  const requested = flags.get('transport') ?? env.MCP_TRANSPORT ?? 'stdio';
  if (requested !== 'stdio' && requested !== 'http') {
    throw new ConfigError(`Unknown transport "${String(requested)}" (expected "stdio" or "http")`);
  }
  const mode: TransportMode = flags.has('http') ? 'http' : requested;

  const host = String(flags.get('host') ?? env.MCP_HTTP_HOST ?? DEFAULT_HTTP_HOST);

  const rawPort = flags.get('port') ?? env.MCP_HTTP_PORT ?? env.PORT;
  const port =
    rawPort === undefined || rawPort === ''
      ? DEFAULT_HTTP_PORT
      : parsePort(String(rawPort), flags.has('port') ? '--port' : 'MCP_HTTP_PORT/PORT');

  const path = normalizePath(String(flags.get('path') ?? env.MCP_HTTP_PATH ?? DEFAULT_HTTP_PATH));

  return {
    mode,
    http: {
      host,
      port,
      path,
      authToken: (env.MCP_HTTP_AUTH_TOKEN ?? '').trim() || undefined,
      allowedHosts: resolveAllowedHosts(env.MCP_HTTP_ALLOWED_HOSTS, host),
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export interface StartHttpMcpServerOptions {
  config: HttpTransportConfig;
  /** Builds a fresh MCP server; called once per POST. */
  createServer: () => Server;
  /** Diagnostics sink — must not be stdout in stdio mode terms, but stderr. */
  log?: (message: string) => void;
}

export interface RunningHttpServer {
  server: HttpServer;
  /** Full MCP endpoint, e.g. `http://127.0.0.1:3000/mcp`. */
  url: string;
  /** Actual bound port (differs from `config.port` when 0 was requested). */
  port: number;
  close(): Promise<void>;
}

interface HandlerContext {
  config: HttpTransportConfig;
  createServer: () => Server;
  log: (message: string) => void;
}

export async function startHttpMcpServer(
  options: StartHttpMcpServerOptions
): Promise<RunningHttpServer> {
  const context: HandlerContext = {
    config: options.config,
    createServer: options.createServer,
    log: options.log ?? (() => {}),
  };

  const server = createHttpServer((req, res) => {
    handleRequest(context, req, res).catch((error) => {
      context.log(`unhandled error on ${req.method} ${req.url}: ${describe(error)}`);
      sendJsonRpcError(res, 500, -32603, 'Internal server error');
    });
  });

  // Malformed requests must not take the process down.
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(context.config.port, context.config.host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : context.config.port;
  const urlHost = context.config.host.includes(':') ? `[${context.config.host}]` : context.config.host;

  return {
    server,
    port,
    url: `http://${urlHost}:${port}${context.config.path}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Keep-alive sockets would otherwise hold the close() callback open.
        server.closeAllConnections?.();
      }),
  };
}

async function handleRequest(
  context: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const { config } = context;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = normalizePath(url.pathname);

  // Liveness probe: no auth, no GLPI round-trip. Used by container healthchecks.
  if (path === HEALTH_PATH) {
    sendJson(res, 200, { status: 'ok', transport: 'streamable-http', uptime: process.uptime() });
    return;
  }

  if (path !== config.path) {
    sendJsonRpcError(res, 404, -32601, `Not found: ${path} (MCP endpoint is ${config.path})`);
    return;
  }

  if (!isAuthorized(req, config.authToken)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="mcp-glpi"');
    context.log(`rejected ${req.method} ${config.path}: missing or invalid bearer token`);
    sendJsonRpcError(res, 401, -32001, 'Unauthorized');
    return;
  }

  if (!isHostAllowed(url, config)) {
    context.log(`rejected ${req.method} ${config.path}: host header "${req.headers.host}" not allowed`);
    sendJsonRpcError(res, 403, -32000, `Invalid Host header: ${req.headers.host ?? '(missing)'}`);
    return;
  }

  if (req.method !== 'POST') {
    // This server never initiates messages, so there is no session to open an
    // SSE stream for and none to delete. Say so instead of leaving a GET
    // stream hanging, which some clients would wait on forever.
    sendJsonRpcError(
      res,
      405,
      -32000,
      `Method not allowed: ${req.method ?? '(unknown)'}. This endpoint is stateless — POST JSON-RPC messages to ${config.path}.`
    );
    return;
  }

  const body = await readJsonBody(req, res, config.maxBodyBytes);
  if (!body.ok) return; // response already sent

  const server = context.createServer();
  const transport = new StreamableHTTPServerTransport({
    // undefined = stateless: no session id issued, none expected on requests.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const cleanup = () => {
    void Promise.resolve(transport.close()).catch(() => {});
    void Promise.resolve(server.close()).catch(() => {});
  };

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body.value);
  } catch (error) {
    context.log(`request failed: ${describe(error)}`);
    if (res.headersSent) res.end();
    else sendJsonRpcError(res, 500, -32603, 'Internal server error');
  } finally {
    // Nothing survives the request, so tear both down as soon as the response
    // is on the wire (or the client went away).
    if (res.writableEnded) cleanup();
    else res.on('close', cleanup);
  }
}

type BodyResult = { ok: true; value: unknown } | { ok: false };

function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number
): Promise<BodyResult> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      sendJsonRpcError(res, 413, -32000, `Request body exceeds ${maxBytes} bytes`);
      resolve({ ok: false });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    // Once the limit is hit we answer and drop the rest: still reading keeps a
    // keep-alive connection usable, and unlike destroying the socket it cannot
    // truncate the response we just sent.
    let overLimit = false;

    req.on('data', (chunk: Buffer) => {
      if (overLimit) return;
      size += chunk.length;
      if (size > maxBytes) {
        overLimit = true;
        chunks.length = 0;
        sendJsonRpcError(res, 413, -32000, `Request body exceeds ${maxBytes} bytes`);
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => resolve({ ok: false }));

    req.on('end', () => {
      if (overLimit) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        // Let the transport report the protocol error for an empty body.
        resolve({ ok: true, value: undefined });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(raw) });
      } catch {
        sendJsonRpcError(res, 400, -32700, 'Parse error: body is not valid JSON');
        resolve({ ok: false });
      }
    });
  });
}

function isAuthorized(req: IncomingMessage, expected?: string): boolean {
  if (!expected) return true;
  const header = req.headers.authorization;
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? secretEquals(match[1], expected) : false;
}

/** Length-independent comparison, so a wrong token leaks nothing about the right one. */
function secretEquals(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function isHostAllowed(url: URL, config: HttpTransportConfig): boolean {
  if (!config.allowedHosts || config.allowedHosts.length === 0) return true;
  const hostname = url.hostname.toLowerCase();
  return config.allowedHosts.some((allowed) => allowed.toLowerCase() === hostname);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(res: ServerResponse | undefined, status: number, payload: unknown): void {
  if (!res || res.writableEnded || res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendJsonRpcError(
  res: ServerResponse | undefined,
  status: number,
  code: number,
  message: string
): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}
