/**
 * GLPI connection settings from the environment (GLPI_URL, tokens, timeout,
 * retries, concurrency). Kept out of index.ts, which starts the server on
 * import, so it can be tested.
 */

import type { GlpiConfig } from './glpi-client.js';

/**
 * Invalid configuration (environment or command line). The CLI prints the
 * message alone, without a stack trace, and exits with status 2.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Integer environment variable, or undefined when unset or empty.
 * `min: 1` for values where 0 makes no sense (timeout, concurrency),
 * `min: 0` where 0 is meaningful (retries: none).
 */
export function envInt(env: NodeJS.ProcessEnv, name: string, min: 0 | 1): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min) {
    throw new ConfigError(`${name} must be a ${min === 1 ? 'positive' : 'non-negative'} integer, got "${raw}"`);
  }
  return n;
}

export function parseGlpiConfig(env: NodeJS.ProcessEnv = process.env): GlpiConfig {
  const url = env.GLPI_URL;
  if (!url) throw new ConfigError('GLPI_URL environment variable is required');
  try {
    new URL(url);
  } catch {
    throw new ConfigError(`GLPI_URL is not a valid URL: "${url}"`);
  }

  const userToken = env.GLPI_USER_TOKEN;
  const username = env.GLPI_USERNAME;
  const password = env.GLPI_PASSWORD;
  if (!userToken && !(username && password)) {
    throw new ConfigError('No authentication configured. Set GLPI_USER_TOKEN, or GLPI_USERNAME + GLPI_PASSWORD.');
  }

  return {
    url,
    appToken: env.GLPI_APP_TOKEN,
    userToken,
    username,
    password,
    timeoutMs: envInt(env, 'GLPI_TIMEOUT_MS', 1),
    maxRetries: envInt(env, 'GLPI_MAX_RETRIES', 0),
    maxConcurrency: envInt(env, 'GLPI_MAX_CONCURRENCY', 1),
  };
}
