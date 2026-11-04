#!/usr/bin/env node

/**
 * mcp-glpi CLI entry: configuration, transport selection, shutdown.
 * Tools live in src/tools/*, the server factory in src/server.ts.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, parseGlpiConfig } from './config.js';
import { GlpiClient } from './glpi-client.js';
import {
  HttpTransportConfig,
  USAGE,
  parseTransportConfig,
  startHttpMcpServer,
} from './http-server.js';
import { SERVER_VERSION, type ServerOptions, createMcpServer, parseServerOptions, promptStartupNote } from './server.js';

/**
 * The GLPI client is process-wide: one GLPI session shared by every MCP
 * connection (one stdio client, or every request to the HTTP endpoint).
 */
let client: GlpiClient;
let serverOptions: ServerOptions;

/** Set in HTTP mode so shutdown can stop accepting requests. */
let runningHttpServer: { close: () => Promise<void> } | undefined;
let shuttingDown = false;

async function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`Shutting down (${reason})...`);
  try {
    await runningHttpServer?.close();
  } catch (error) {
    console.error('Warning: HTTP server close failed:', error instanceof Error ? error.message : error);
  }
  try {
    await client.killSession();
  } catch (error) {
    console.error('Warning: killSession failed during shutdown:', error instanceof Error ? error.message : error);
  }
  process.exit(0);
}

/** MCP over stdin/stdout — one client, the default (Claude Desktop/Code, Cursor). */
async function startStdioTransport() {
  const server = createMcpServer({ client, options: serverOptions });
  // When the client goes away (stdin EOF / transport closed), close the GLPI
  // session and exit instead of lingering as an orphan process.
  server.server.onclose = () => void shutdown('stdio transport closed');
  process.stdin.once('end', () => void shutdown('stdin ended'));
  process.stdin.once('close', () => void shutdown('stdin closed'));
  await server.connect(new StdioServerTransport());
  console.error(`MCP GLPI Server v${SERVER_VERSION} running on stdio`);
}

/** MCP Streamable HTTP — web clients such as Open WebUI. */
async function startHttpTransport(config: HttpTransportConfig) {
  const running = await startHttpMcpServer({
    config,
    createServer: () => createMcpServer({ client, options: serverOptions }),
    log: (message) => console.error(`[mcp-http] ${message}`),
  });
  runningHttpServer = running;

  console.error(`MCP GLPI Server v${SERVER_VERSION} listening on ${running.url}`);
  console.error('  transport: streamable HTTP (stateless, JSON responses)');
  console.error(
    `  auth: ${config.authToken ? 'bearer token required' : 'none — bind to loopback or set MCP_HTTP_AUTH_TOKEN before exposing this port'}`
  );
  if (!config.allowedHosts) {
    console.error(
      `  warning: Host header validation is off because the server is bound to ${config.host}; ` +
        'set MCP_HTTP_ALLOWED_HOSTS to restrict it'
    );
  }
  if (process.env.GLPI_READ_ONLY === undefined) {
    console.error('  warning: GLPI_READ_ONLY is not set: every HTTP client can write to GLPI; set GLPI_READ_ONLY=1 unless writes are intended');
  }
}

async function main() {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
      console.error(USAGE);
      process.exit(0);
    }

    let transportConfig;
    let config;
    try {
      transportConfig = parseTransportConfig(argv, process.env);
      config = parseGlpiConfig(process.env);
      serverOptions = parseServerOptions(process.env);
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(`Configuration error: ${error.message}\n\nRun mcp-glpi --help for the options and environment variables.`);
        process.exit(2);
      }
      throw error;
    }

    const promptNote = promptStartupNote(serverOptions);
    if (promptNote) console.error(promptNote);
    client = new GlpiClient(config);

    // Try to open the session eagerly, but don't die if GLPI is momentarily
    // unreachable: the HTTP layer re-authenticates lazily on first request.
    try {
      await client.initSession();
      console.error('GLPI session initialized');
    } catch (error) {
      console.error(
        `Warning: could not reach GLPI at startup (${error instanceof Error ? error.message : error}). ` +
          'The session will be established on the first request.'
      );
    }

    if (transportConfig.mode === 'http') {
      await startHttpTransport(transportConfig.http);
    } else {
      await startStdioTransport();
    }

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    // The stack only helps when debugging the server itself.
    const detail = process.env.GLPI_DEBUG || !(error instanceof Error) ? error : error.message;
    console.error('Failed to start server:', detail);
    process.exit(1);
  }
}

void main();
