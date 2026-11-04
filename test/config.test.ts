/**
 * Environment parsing of the GLPI connection settings (src/config.ts).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ConfigError, parseGlpiConfig } from '../src/config.js';
import { ConfigError as HttpConfigError } from '../src/http-server.js';

const base = { GLPI_URL: 'https://glpi.test', GLPI_USER_TOKEN: 'u' };

test('timeout, retries and concurrency: unset gives the client defaults', () => {
  const config = parseGlpiConfig({ ...base, GLPI_TIMEOUT_MS: '' });
  assert.equal(config.timeoutMs, undefined);
  assert.equal(config.maxRetries, undefined);
  assert.equal(config.maxConcurrency, undefined);
});

test('timeout and concurrency must be positive; retries may be 0', () => {
  const config = parseGlpiConfig({ ...base, GLPI_TIMEOUT_MS: '30000', GLPI_MAX_RETRIES: '0', GLPI_MAX_CONCURRENCY: ' 4 ' });
  assert.equal(config.timeoutMs, 30000);
  assert.equal(config.maxRetries, 0);
  assert.equal(config.maxConcurrency, 4);

  assert.throws(() => parseGlpiConfig({ ...base, GLPI_TIMEOUT_MS: '0' }), /GLPI_TIMEOUT_MS must be a positive integer, got "0"/);
  assert.throws(() => parseGlpiConfig({ ...base, GLPI_MAX_CONCURRENCY: '0' }), /GLPI_MAX_CONCURRENCY must be a positive integer/);
  assert.throws(() => parseGlpiConfig({ ...base, GLPI_MAX_RETRIES: '-1' }), /GLPI_MAX_RETRIES must be a non-negative integer/);
  assert.throws(() => parseGlpiConfig({ ...base, GLPI_TIMEOUT_MS: '15s' }), /GLPI_TIMEOUT_MS must be a positive integer/);
  assert.throws(() => parseGlpiConfig({ ...base, GLPI_MAX_CONCURRENCY: '2.5' }), /positive integer/);
});

test('URL and authentication are required', () => {
  assert.throws(() => parseGlpiConfig({ GLPI_USER_TOKEN: 'u' }), /GLPI_URL environment variable is required/);
  assert.throws(() => parseGlpiConfig({ ...base, GLPI_URL: 'not a url' }), /not a valid URL/);
  assert.throws(() => parseGlpiConfig({ GLPI_URL: base.GLPI_URL }), /No authentication configured/);
  const basic = parseGlpiConfig({ GLPI_URL: base.GLPI_URL, GLPI_USERNAME: 'a', GLPI_PASSWORD: 'b' });
  assert.equal(basic.username, 'a');
});

test('configuration errors are ConfigError (the CLI prints them without a stack trace)', () => {
  assert.throws(() => parseGlpiConfig({ ...base, GLPI_TIMEOUT_MS: 'abc' }), ConfigError);
  assert.throws(() => parseGlpiConfig({ GLPI_USER_TOKEN: 'u' }), ConfigError);
  assert.throws(() => parseGlpiConfig({ GLPI_URL: base.GLPI_URL }), ConfigError);
  // One class for the environment and the command line.
  assert.equal(HttpConfigError, ConfigError);
});
