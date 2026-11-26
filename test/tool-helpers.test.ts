/**
 * Tool-layer helpers (src/tool-helpers.ts), v3.5.0 fixes.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArgumentError } from '../src/errors.js';
import { GlpiClient } from '../src/glpi-client.js';
import {
  MAX_UPLOAD_BYTES,
  closestOptions,
  monthBuckets,
  monthCriteria,
  parseValidationStatus,
  requireId,
  resolveCriteria,
  resolveLinkArgs,
  resolveUploadSource,
  searchByStatuses,
  statusInCriteria,
  ticketField,
} from '../src/tool-helpers.js';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function installFetch(handler: FetchHandler): string[] {
  const calls: string[] = [];
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    calls.push(url);
    return handler(url, init);
  });
  return calls;
}

const client = () => new GlpiClient({ url: 'https://glpi.test', userToken: 'u' });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const isInvalid = (re: RegExp) => (err: unknown) => {
  assert.ok(err instanceof ArgumentError, `expected ArgumentError, got ${err}`);
  assert.match(err.message, re);
  return true;
};

// Catalogue where the dynamic ids differ from the static fallbacks.
const SHIFTED_TICKET_OPTIONS = {
  1: { name: 'Title', field: 'name', uid: 'Ticket.name' },
  2: { name: 'ID', field: 'id', uid: 'Ticket.id' },
  112: { name: 'Status', field: 'status', uid: 'Ticket.status' },
  118: { name: 'Time to resolve', field: 'time_to_resolve', uid: 'Ticket.time_to_resolve' },
  80: { name: 'Entity', field: 'completename', uid: 'Ticket.Entity.completename' },
  7: { name: 'Category', field: 'completename', uid: 'Ticket.ITILCategory.completename' },
  4: { name: 'Requester', field: 'name', uid: 'Ticket.Ticket_User.User.name' },
};

// --- month buckets ----------------------------------------------------------

function withTz<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

for (const tz of ['Europe/Paris', 'UTC']) {
  test(`monthBuckets uses local midnight boundaries (TZ=${tz})`, () => {
    withTz(tz, () => {
      const buckets = monthBuckets('2026-01-15', '2026-04-02');
      assert.deepEqual(buckets.map((b) => b.key), ['2026-01', '2026-02', '2026-03', '2026-04']);
      const march = buckets[2];
      assert.equal(march.start, '2026-03-01 00:00:00');
      assert.equal(march.end, '2026-04-01 00:00:00');
      // morethan is strict: one second before the 1st catches a midnight ticket.
      assert.equal(march.afterValue, '2026-02-28 23:59:59');
      assert.deepEqual(monthCriteria(march, 15), [
        { field: 15, searchtype: 'morethan', value: '2026-02-28 23:59:59' },
        { field: 15, searchtype: 'lessthan', value: '2026-04-01 00:00:00', link: 'AND' },
      ]);
      assert.equal(buckets[0].afterValue, '2025-12-31 23:59:59');
    });
  });

  test(`monthBuckets defaults to the last 6 months (TZ=${tz})`, () => {
    withTz(tz, () => {
      const now = new Date(2026, 0, 1, 0, 30); // local 2026-01-01 00:30
      const keys = monthBuckets(undefined, undefined, now).map((b) => b.key);
      assert.deepEqual(keys, ['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01']);
    });
  });
}

test('monthBuckets caps the range at 36 months', () => {
  assert.equal(monthBuckets('2023-01-01', '2025-12-31').length, 36);
  assert.throws(() => monthBuckets('2023-01-01', '2026-01-01'), isInvalid(/37 months; the maximum is 36/));
  assert.throws(() => monthBuckets('2026-05-01', '2026-01-01'), isInvalid(/before/));
});

// --- criteria resolution ----------------------------------------------------

test('resolveCriteria rejects unknown fields with the closest option names', async () => {
  installFetch(async () => json(SHIFTED_TICKET_OPTIONS));
  const c = client();
  const ok = await resolveCriteria(c, 'Ticket', [{ field: 'status', searchtype: 'equals', value: 1 }]);
  assert.equal(ok[0].field, 112);
  await assert.rejects(
    () => resolveCriteria(c, 'Ticket', [{ field: 'stauts', searchtype: 'equals', value: 1 }]),
    isInvalid(/"stauts" is not a search option of Ticket\. Closest: Status \(112, Ticket\.status\)/)
  );
});

test('closestOptions returns at most 5 names', async () => {
  installFetch(async () => json(SHIFTED_TICKET_OPTIONS));
  const cat = await client().searchOptions.get('Ticket');
  const near = closestOptions(cat, 'time');
  assert.ok(near.length <= 5);
  assert.match(near[0], /^Time to resolve \(118/);
});

test('ticketField resolves dynamically, caches, and falls back to static ids', async () => {
  const calls = installFetch(async () => json(SHIFTED_TICKET_OPTIONS));
  const c = client();
  assert.equal(await ticketField(c, 'time_to_resolve'), 118);
  assert.equal(await ticketField(c, 'status'), 112);
  assert.equal(await ticketField(c, 'technician_user'), 5, 'joined actor fields keep the static id');
  assert.equal(await ticketField(c, 'requester_user'), 4, 'even when the catalogue lists the shared actor uid');
  assert.equal(await ticketField(c, 'observer_user'), 66, 'observer: static id 66');
  assert.equal(await ticketField(c, 'urgency'), 10, 'unknown column -> static id');
  await ticketField(c, 'status');
  assert.equal(calls.length, 1);

  installFetch(async () => new Response('["ERROR_RIGHT_MISSING",""]', { status: 403 }));
  assert.equal(await ticketField(client(), 'time_to_resolve'), 18);
});

test('searchByStatuses builds OR-linked status criteria, newest first, 50 rows', async () => {
  assert.deepEqual(statusInCriteria(12, [1, 2]), [
    { field: 12, searchtype: 'equals', value: 1 },
    { field: 12, searchtype: 'equals', value: 2, link: 'OR' },
  ]);
  let params: URLSearchParams | undefined;
  installFetch(async (url) => {
    if (url.includes('listSearchOptions/Change')) {
      return json({
        12: { name: 'Status', field: 'status', uid: 'Change.status' },
        19: { name: 'Last update', field: 'date_mod', uid: 'Change.date_mod' },
      });
    }
    params = new URL(url).searchParams;
    return json({ totalcount: 0, data: [] });
  });
  await searchByStatuses(client(), 'Change', [1, 2, 3, 4, 7, 9, 10, 11, 12]);
  const values = [...params!.entries()].filter(([k]) => /criteria\[\d+\]\[value\]/.test(k)).map(([, v]) => v);
  assert.deepEqual(values, ['1', '2', '3', '4', '7', '9', '10', '11', '12']);
  assert.equal(params!.get('criteria[1][link]'), 'OR');
  assert.equal(params!.get('sort'), '19');
  assert.equal(params!.get('order'), 'DESC');
  assert.equal(params!.get('range'), '0-49');
});

// --- links ------------------------------------------------------------------

test('resolveLinkArgs: new form with relation or GLPI link_type', () => {
  assert.deepEqual(resolveLinkArgs({ ticket_id: 1, other_ticket_id: 2, relation: 'child_of' }), {
    ticketId: 1, otherTicketId: 2, relation: 'child_of',
  });
  assert.equal(resolveLinkArgs({ ticket_id: 1, other_ticket_id: 2, link_type: 3 }).relation, 'child_of');
  assert.equal(resolveLinkArgs({ ticket_id: 1, other_ticket_id: 2, link_type: 4 }).relation, 'parent_of');
  assert.equal(resolveLinkArgs({ ticket_id: 1, other_ticket_id: 2 }).relation, 'link');
  assert.throws(() => resolveLinkArgs({ ticket_id: 1, other_ticket_id: 2, relation: 'sibling' }), isInvalid(/relation/));
  assert.throws(() => resolveLinkArgs({ ticket_id: 1, other_ticket_id: 1 }), isInvalid(/itself/));
  assert.throws(() => resolveLinkArgs({ ticket_id: 1 }), isInvalid(/other_ticket_id is required/));
});

test('resolveLinkArgs: legacy parent_id/child_id keep "parent_id is the parent"', () => {
  assert.deepEqual(resolveLinkArgs({ parent_id: 10, child_id: 20, link_type: 3 }), {
    ticketId: 10, otherTicketId: 20, relation: 'parent_of',
  });
  assert.equal(resolveLinkArgs({ parent_id: 10, child_id: 20, link_type: 4 }).relation, 'parent_of');
  assert.equal(resolveLinkArgs({ parent_id: 10, child_id: 20, link_type: 2 }).relation, 'duplicate');
  assert.equal(resolveLinkArgs({ parent_id: 10, child_id: 20 }).relation, 'link');
});

// --- validation -------------------------------------------------------------

test('requireId rejects missing or malformed ids', () => {
  assert.equal(requireId({ id: '12' }, 'id'), 12);
  assert.throws(() => requireId({}, 'id'), isInvalid(/id is required/));
  assert.throws(() => requireId({ id: 0 }, 'id'), isInvalid(/positive integer/));
  assert.throws(() => requireId({ id: 'abc' }, 'id'), isInvalid(/positive integer/));
});

test('parseValidationStatus takes "accepted" / "refused" and refuses the ambiguous numbers', () => {
  // GLPI: WAITING 2, ACCEPTED 3, REFUSED 4 (CommonITILValidation).
  assert.equal(parseValidationStatus('accepted'), 3);
  assert.equal(parseValidationStatus(' Refused '), 4);
  assert.equal(parseValidationStatus('granted'), 3);
  assert.equal(parseValidationStatus('reject'), 4);
  // Until 4.2.0 the tool documented 2 = granted, 3 = refused: a number cannot be trusted.
  for (const legacy of [2, 3, 4, '2', '3', undefined, 'waiting']) {
    assert.throws(() => parseValidationStatus(legacy), isInvalid(/"accepted" or "refused"/));
  }
});

// --- upload -----------------------------------------------------------------

test('resolveUploadSource: file_path is disabled without GLPI_UPLOAD_DIR', async () => {
  await assert.rejects(() => resolveUploadSource({ file_path: '/etc/passwd' }, {}), isInvalid(/disabled.*GLPI_UPLOAD_DIR/));
});

test('resolveUploadSource: only files inside GLPI_UPLOAD_DIR (symlinks resolved)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-glpi-upload-'));
  try {
    const dir = join(root, 'uploads');
    await mkdir(dir);
    await writeFile(join(dir, 'shot.png'), Buffer.from([1, 2, 3]));
    await writeFile(join(root, 'secret.txt'), 'secret');
    await symlink(join(root, 'secret.txt'), join(dir, 'link.txt'));
    const env = { GLPI_UPLOAD_DIR: dir };

    const ok = await resolveUploadSource({ file_path: join(dir, 'shot.png') }, env);
    assert.equal(ok.filename, 'shot.png');
    assert.equal(ok.mimeType, 'image/png');
    assert.deepEqual([...ok.data], [1, 2, 3]);
    assert.equal((await resolveUploadSource({ file_path: 'shot.png' }, env)).filename, 'shot.png');

    await assert.rejects(() => resolveUploadSource({ file_path: join(root, 'secret.txt') }, env), isInvalid(/inside GLPI_UPLOAD_DIR/));
    await assert.rejects(() => resolveUploadSource({ file_path: '../secret.txt' }, env), isInvalid(/inside GLPI_UPLOAD_DIR/));
    await assert.rejects(() => resolveUploadSource({ file_path: 'link.txt' }, env), isInvalid(/inside GLPI_UPLOAD_DIR/));
    await assert.rejects(() => resolveUploadSource({ file_path: dir }, env), isInvalid(/inside GLPI_UPLOAD_DIR|regular file/));

    await writeFile(join(dir, 'big.bin'), '');
    await truncate(join(dir, 'big.bin'), MAX_UPLOAD_BYTES + 1);
    await assert.rejects(() => resolveUploadSource({ file_path: 'big.bin' }, env), isInvalid(/maximum is 20971520/));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveUploadSource: content_base64 + filename bypasses the path rule', async () => {
  const src = await resolveUploadSource({ content_base64: Buffer.from('hello').toString('base64'), filename: 'note.txt' }, {});
  assert.equal(src.filename, 'note.txt');
  assert.equal(Buffer.from(src.data).toString(), 'hello');
  assert.equal(src.mimeType, 'text/plain');
  await assert.rejects(() => resolveUploadSource({ content_base64: 'aGk=' }, {}), isInvalid(/filename is required/));
  await assert.rejects(() => resolveUploadSource({ content_base64: 'aGk=', filename: '../x.txt' }, {}), isInvalid(/bare file name/));
  await assert.rejects(() => resolveUploadSource({ content_base64: '###', filename: 'x.txt' }, {}), isInvalid(/not valid base64/));
  const tooBig = 'A'.repeat(Math.ceil(((MAX_UPLOAD_BYTES + 10) * 4) / 3));
  await assert.rejects(() => resolveUploadSource({ content_base64: tooBig, filename: 'x.bin' }, {}), isInvalid(/maximum/));
});
