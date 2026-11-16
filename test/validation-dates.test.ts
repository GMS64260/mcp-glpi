/**
 * Ticket validation timestamps.
 *
 * GLPI stores datetimes in its own server timezone (the instructions and
 * `formatGlpiDate` both say so, and overdue / month filters compare them with
 * local time). The validation writes used `toISOString()`, i.e. UTC, so on a
 * server east of UTC both dates were saved one or two hours early (and late
 * west of it). Fixed by formatting them with the shared local-time helper.
 */

// Fixed offset (UTC+1 in January) so a UTC timestamp is clearly different.
process.env.TZ = 'Europe/Berlin';

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { GlpiClient, formatGlpiDate } from '../src/glpi-client.js';

type Call = { method: string; path: string; body?: { input: Record<string, unknown> } };

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
    return new Response(JSON.stringify({ id: 5 }), { status: 201 });
  });
  return calls;
}

const client = () => new GlpiClient({ url: 'https://glpi.test', userToken: 'u', maxRetries: 0 });

/** 09:30 UTC is 10:30 in Berlin: the two formats cannot be confused. */
const NOW = new Date('2026-01-15T09:30:00Z');
const LOCAL = '2026-01-15 10:30:00';
const UTC = '2026-01-15 09:30:00';

test('formatGlpiDate writes local time, not UTC', () => {
  assert.equal(formatGlpiDate(NOW), LOCAL, 'TZ=Europe/Berlin must apply to this process (10:30, not 09:30)');
  assert.equal(NOW.toISOString().slice(0, 19).replace('T', ' '), UTC);
  assert.notEqual(formatGlpiDate(NOW), UTC);
});

test('addTicketValidation sends submission_date in local time', async () => {
  const calls = installFetch();
  mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  try {
    await client().addTicketValidation(7, { users_id_validate: 3 });
  } finally {
    mock.timers.reset();
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/apirest.php/TicketValidation');
  assert.deepEqual(calls[0].body?.input, {
    tickets_id: 7,
    users_id_validate: 3,
    comment_submission: '',
    submission_date: LOCAL,
    status: 1,
  });
});

test('addTicketValidation keeps an explicit submission_date as given', async () => {
  const calls = installFetch();
  mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  try {
    await client().addTicketValidation(7, { users_id_validate: 3, submission_date: '2026-01-02 08:00:00' });
  } finally {
    mock.timers.reset();
  }
  assert.equal(calls[0].body?.input.submission_date, '2026-01-02 08:00:00');
});

test('setTicketValidationStatus sends validation_date in local time', async () => {
  const calls = installFetch();
  mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  try {
    await client().setTicketValidationStatus(5, 2, 'agreed');
  } finally {
    mock.timers.reset();
  }

  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].path, '/apirest.php/TicketValidation/5');
  assert.deepEqual(calls[0].body?.input, {
    id: 5,
    status: 2,
    comment_validation: 'agreed',
    validation_date: LOCAL,
  });
});
