/**
 * Ticket statistics must resolve their Ticket search options.
 *
 * `glpi_tickets_stats_by` (status, category, entity, and the entity/date
 * filters) and `GlpiClient.getTicketStats` sent GLPI's stock option ids
 * (status 12, category 7, entity 80, date 15) instead of resolving them
 * through `listSearchOptions/Ticket`, although `tool-helpers.TICKET_FIELDS`
 * documents those ids as *fallbacks* only and the month branch already
 * resolved them. On an instance where those options were renumbered, every
 * count came back as 0.
 *
 * The fake GLPI below only answers the renumbered ids (112/107/180/115), so
 * the stock ids give 0 — exactly what a live renumbered instance did.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GlpiClient } from '../src/glpi-client.js';
import { runTool } from '../src/tools/registry.js';
import { STATS_TOOLS } from '../src/tools/stats.js';

type Call = { method: string; path: string; query: URLSearchParams };

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

/** A GLPI where status/category/entity/date are renumbered search options. */
const CATALOGUE = {
  1: { name: 'Titre', table: 'glpi_tickets', field: 'name', uid: 'Ticket.name' },
  2: { name: 'ID', table: 'glpi_tickets', field: 'id', uid: 'Ticket.id' },
  107: { name: 'Catégorie', table: 'glpi_itilcategories', field: 'completename', uid: 'Ticket.ITILCategory.completename' },
  112: { name: 'Statut', table: 'glpi_tickets', field: 'status', uid: 'Ticket.status' },
  115: { name: 'Date', table: 'glpi_tickets', field: 'date', uid: 'Ticket.date' },
  180: { name: 'Entité', table: 'glpi_entities', field: 'completename', uid: 'Ticket.Entity.completename' },
};

/** totalcount per search-option id: only the ids of the chosen catalogue. */
const RENUMBERED_TOTALS: Record<string, number> = { '107': 3, '112': 2, '115': 7, '180': 4 };
const STOCK_TOTALS: Record<string, number> = { '7': 3, '12': 2, '15': 7, '80': 4 };

function installFetch(renumbered = true): Call[] {
  const calls: Call[] = [];
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/initSession')) return json({ session_token: 's' });
    const u = new URL(url);
    const call: Call = {
      method: init?.method ?? 'GET',
      path: u.pathname.replace(/^\/apirest\.php\//, ''),
      query: u.searchParams,
    };
    calls.push(call);

    if (call.path === 'listSearchOptions/Ticket') return json(renumbered ? CATALOGUE : {});
    if (call.path === 'ITILCategory') return json([{ id: 5, name: 'Matériel', completename: 'Matériel' }]);
    if (call.path === 'Entity') return json([{ id: 0, name: 'Root entity', completename: 'Root entity' }]);
    if (call.path === 'search/Ticket') {
      const totals = renumbered ? RENUMBERED_TOTALS : STOCK_TOTALS;
      const field = call.query.get('criteria[0][field]') ?? '';
      const total = totals[field] ?? 0;
      return json({ totalcount: total, count: total > 0 ? 1 : 0, data: [] });
    }
    return json([]);
  });
  return calls;
}

const statsTool = STATS_TOOLS.find((t) => t.name === 'glpi_tickets_stats_by')!;
const context = () => ({ client: new GlpiClient({ url: 'https://glpi.test', userToken: 'u', maxRetries: 0 }), options: {} });

async function stats(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await runTool(statsTool, context(), args)) as CallToolResult;
  return JSON.parse((result.content[0] as { text: string }).text);
}

const searches = (calls: Call[]) => calls.filter((c) => c.path === 'search/Ticket');

test('status dimension asks for the resolved status option', async () => {
  const calls = installFetch();
  const out = await stats({ dimension: 'status' });

  const fields = searches(calls).map((c) => c.query.get('criteria[0][field]'));
  assert.equal(fields.length, 6);
  assert.ok(fields.every((f) => f === '112'), `status field: ${fields.join(',')}`);
  assert.equal(out.counts && (out.counts as Record<string, number>).New, 2);
  assert.equal(out.total, 12);
});

test('category and entity dimensions ask for their resolved options', async () => {
  const calls = installFetch();
  const byCategory = await stats({ dimension: 'category' });
  assert.deepEqual(byCategory.counts, { Matériel: 3 });
  assert.ok(searches(calls).every((c) => c.query.get('criteria[0][field]') === '107'));

  calls.length = 0;
  const byEntity = await stats({ dimension: 'entity' });
  assert.deepEqual(byEntity.counts, { 'Root entity': 4 });
  assert.deepEqual(searches(calls).map((c) => c.query.get('criteria[0][field]')), ['180']);
});

test('the entity and date filters and the month buckets use the resolved options', async () => {
  const calls = installFetch();
  await stats({ dimension: 'status', entity_id: 0, date_from: '2026-11-01', date_to: '2026-11-30' });
  const search = searches(calls)[0];
  assert.deepEqual(
    [0, 1, 2].map((i) => search.query.get(`criteria[${i}][field]`)),
    ['112', '180', '115']
  );

  calls.length = 0;
  const month = await stats({ dimension: 'month', entity_id: 0, date_from: '2026-11-01', date_to: '2026-11-30' });
  assert.deepEqual(month.counts, { '2026-11': 7 });
  const bucket = searches(calls)[0];
  assert.deepEqual(
    [0, 1, 2].map((i) => bucket.query.get(`criteria[${i}][field]`)),
    ['115', '115', '180']
  );
});

test('GlpiClient.getTicketStats (glpi://stats/tickets) resolves the same ids', async () => {
  const calls = installFetch();
  const client = new GlpiClient({ url: 'https://glpi.test', userToken: 'u', maxRetries: 0 });
  const out = await client.getTicketStats({ entity_id: 0, date_from: '2026-11-01' });

  assert.deepEqual(out, { total: 4, new: 2, processing: 4, pending: 2, solved: 2, closed: 2 });
  const searched = searches(calls);
  // Six status probes, then the total probe (entity filter first).
  assert.deepEqual(searched.slice(0, 6).map((c) => c.query.get('criteria[0][field]')), Array(6).fill('112'));
  assert.deepEqual(
    [0, 1].map((i) => searched[6].query.get(`criteria[${i}][field]`)),
    ['180', '115']
  );
});

test('an unreadable catalogue still falls back to the stock ids', async () => {
  const calls = installFetch(false);
  const out = await stats({ dimension: 'status', entity_id: 0 });
  assert.equal(out.total, 12);
  const search = searches(calls)[0];
  assert.deepEqual(
    [0, 1].map((i) => search.query.get(`criteria[${i}][field]`)),
    ['12', '80']
  );
});
