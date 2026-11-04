/**
 * Live smoke test against a real GLPI instance.
 *
 * Usage:
 *   npm run smoke              # read-only checks
 *   npm run smoke -- --write   # also run the write cycle (test ticket create -> soft delete)
 *
 * Reads GLPI_URL / GLPI_APP_TOKEN / GLPI_USER_TOKEN (or GLPI_USERNAME+GLPI_PASSWORD)
 * from the environment, falling back to a .env file at the repo root.
 */

import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GlpiClient } from '../src/glpi-client.js';
import { GlpiError } from '../src/http.js';
import { createMcpServer } from '../src/server.js';

// --- tiny .env loader (no dependency) --------------------------------------
try {
  const envFile = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  // no .env file — rely on the environment
}

const WRITE = process.argv.includes('--write');

const url = process.env.GLPI_URL;
if (!url) {
  console.error('GLPI_URL missing (env or .env)');
  process.exit(1);
}

const client = new GlpiClient({
  url,
  appToken: process.env.GLPI_APP_TOKEN,
  userToken: process.env.GLPI_USER_TOKEN,
  username: process.env.GLPI_USERNAME,
  password: process.env.GLPI_PASSWORD,
  timeoutMs: process.env.GLPI_TIMEOUT_MS ? parseInt(process.env.GLPI_TIMEOUT_MS, 10) : 15000,
});

// --- harness ----------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name} (${Date.now() - t0}ms)${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (err) {
    failed++;
    const msg =
      err instanceof GlpiError
        ? `HTTP ${err.status} ${err.glpiCode ?? ''} ${err.glpiMessage ?? err.body.slice(0, 200)}`
        : err instanceof Error
          ? err.message
          : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} (${Date.now() - t0}ms) — ${msg}`);
    return false;
  }
}

// --- main -------------------------------------------------------------------
async function main() {
  console.log(`\nSmoke test against ${url} ${WRITE ? '(read + write cycle)' : '(read-only)'}\n`);

  // ---- session ----
  console.log('Session:');
  const sessionOk = await check('initSession', async () => {
    await client.initSession();
  });
  if (!sessionOk) {
    console.error('\nCannot authenticate — aborting.');
    process.exit(1);
  }

  await check('getMyProfiles', async () => {
    const profiles = (await client.getMyProfiles()) as any;
    const list = profiles?.myprofiles ?? profiles;
    const n = Array.isArray(list) ? list.length : Object.keys(list ?? {}).length;
    return `${n} profile(s)`;
  });

  // ---- search options / field resolution ----
  console.log('\nSearchOptions cache:');
  await check('searchOptions.get(Ticket)', async () => {
    const cat = await client.searchOptions.get('Ticket');
    if (cat.byId.size < 10) throw new Error(`only ${cat.byId.size} options — suspicious`);
    return `${cat.byId.size} options`;
  });
  await check('resolveField(Ticket, "status") = 12', async () => {
    const id = await client.searchOptions.resolveField('Ticket', 'status');
    if (id === undefined) throw new Error('unresolved');
    return `field_id ${id}`;
  });

  // ---- read: tickets ----
  console.log('\nTickets (read):');
  await check('count(Ticket)', async () => {
    const n = await client.search.count('Ticket');
    return `${n} tickets total`;
  });

  let sampleTicketId: number | undefined;
  await check('getTickets(limit 5, DESC)', async () => {
    const tickets = (await client.getTickets({ range: '0-4', order: 'DESC' })) as any[];
    sampleTicketId = tickets[0]?.id;
    return `${tickets.length} rows, latest id=${sampleTicketId ?? 'n/a'}`;
  });

  await check('search Ticket (status notold, forcedisplay, limit 5)', async () => {
    const res = await client.search.search('Ticket', {
      criteria: [{ field: 12, searchtype: 'equals', value: 'notold' }],
      forcedisplay: [2, 1, 12],
      limit: 5,
    });
    if (res.data.length > 5) throw new Error(`limit 5 but got ${res.data.length} rows (range off-by-one?)`);
    return `totalcount=${res.totalcount}, page=${res.data.length}`;
  });

  await check('resolveField via glpi_count path (field "status" by name)', async () => {
    const fieldId = await client.searchOptions.resolveField('Ticket', 'status');
    if (fieldId === undefined) throw new Error('unresolved');
    const n = await client.search.count('Ticket', [
      { field: fieldId, searchtype: 'equals', value: 1 },
    ]);
    return `field_id=${fieldId}, ${n} new tickets`;
  });

  await check('getTicketStats()', async () => {
    const stats = (await client.getTicketStats()) as any;
    return `total=${stats.total ?? JSON.stringify(stats).slice(0, 80)}`;
  });

  if (sampleTicketId !== undefined) {
    await check(`getTicket(${sampleTicketId}) + expand_dropdowns`, async () => {
      const t = (await client.getTicket(sampleTicketId!)) as any;
      return `"${String(t.name).slice(0, 40)}" status=${t.status}`;
    });
    await check(`timeline parts of #${sampleTicketId}`, async () => {
      const [f, ta, s] = await Promise.all([
        client.getTicketFollowups(sampleTicketId!),
        client.getTicketTasks(sampleTicketId!),
        client.getTicketSolutions(sampleTicketId!),
      ]);
      return `${(f as any[]).length} followups, ${(ta as any[]).length} tasks, ${(s as any[]).length} solutions`;
    });
  }

  // ---- read: other domains ----
  console.log('\nOther domains (read):');
  await check('getChanges(limit 3, sort "date_mod") — column-name sort (#9)', async () => {
    const changes = await client.getChanges({ range: '0-2', sort: 'date_mod', order: 'DESC' });
    return `${changes.length} rows`;
  });

  await check('getTickets(limit 3, sort 19) — search-option id resolved to column (#9)', async () => {
    const tickets = await client.getTickets({ range: '0-2', sort: 19, order: 'DESC' });
    return `${tickets.length} rows`;
  });

  await check('change tasks + validations (#9)', async () => {
    const changes = await client.getChanges({ range: '0-0' });
    if (changes.length === 0) return 'no change on this instance, skipped';
    const id = (changes[0] as { id: number }).id;
    const [tasks, validations] = await Promise.all([
      client.getChangeTasks(id),
      client.getItilValidations('Change', id),
    ]);
    return `change #${id}: ${tasks.length} task(s), ${validations.length} validation(s)`;
  });

  await check('problem tasks (#9)', async () => {
    const problems = await client.getProblems({ range: '0-0' });
    if (problems.length === 0) return 'no problem on this instance, skipped';
    const id = (problems[0] as { id: number }).id;
    const tasks = await client.getProblemTasks(id);
    return `problem #${id}: ${tasks.length} task(s)`;
  });

  await check('getUsers(active, limit 5)', async () => {
    const users = (await client.getUsers({ range: '0-4', is_active: true })) as any[];
    return `${users.length} rows`;
  });
  await check('getComputers(limit 5)', async () => {
    const c = (await client.getComputers({ range: '0-4' })) as any[];
    return `${c.length} rows`;
  });
  await check('getGroups(limit 5)', async () => {
    const g = (await client.getGroups({ range: '0-4' })) as any[];
    return `${g.length} rows`;
  });
  await check('getCategories(limit 5)', async () => {
    const cats = (await client.getCategories({ range: '0-4' })) as any[];
    return `${cats.length} rows`;
  });
  await check('getEntities()', async () => {
    const e = (await client.getEntities({ range: '0-4' })) as any[];
    return `${e.length} rows`;
  });

  await check('getItemsPage(Computer, 0-4) — total from Content-Range', async () => {
    const page = await client.getItemsPage('Computer', { range: '0-4' });
    return `${page.items.length} rows of ${page.totalcount}`;
  });

  // ---- v4 tool layer (read-only tools through an in-memory MCP client) ----
  console.log('\nTools (read-only, via MCP):');
  const server = createMcpServer({ client, options: { readOnly: true } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'smoke', version: '0' });
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await mcp.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
    if (res.isError) throw new Error(text.slice(0, 300));
    return JSON.parse(text);
  };
  await check('tools/list (read-only)', async () => `${(await mcp.listTools()).tools.length} tools`);
  let toolTicketId: number | undefined;
  await check('glpi_search_tickets open_only limit 3', async () => {
    const r = await call('glpi_search_tickets', { open_only: true, limit: 3 });
    toolTicketId = r.items[0]?.id;
    return `totalcount=${r.totalcount}, keys=${Object.keys(r.items[0] ?? {}).join(',')}`;
  });
  if (toolTicketId !== undefined) {
    await check(`glpi_get_ticket(${toolTicketId})`, async () => {
      const r = await call('glpi_get_ticket', { id: toolTicketId });
      return `status_label=${r.status_label}, counts=${JSON.stringify(r.counts)}`;
    });
    await check(`glpi_get_ticket_timeline(${toolTicketId})`, async () => {
      const r = await call('glpi_get_ticket_timeline', { id: toolTicketId });
      return `${r.count} entries (${[...new Set(r.timeline.map((e: { kind: string }) => e.kind))].join(',') || 'none'})`;
    });
  }
  await check('glpi_list_items Computer limit 2', async () => {
    const r = await call('glpi_list_items', { itemtype: 'Computer', limit: 2 });
    return `totalcount=${r.totalcount}, next_start=${r.next_start}`;
  });
  await check('glpi_search_v2 Computer name contains', async () => {
    const r = await call('glpi_search_v2', { itemtype: 'Computer', criteria: [{ field: 'name', searchtype: 'contains', value: '' }], limit: 2 });
    return `totalcount=${r.totalcount}`;
  });
  await check('glpi_list_changes limit 2', async () => {
    const r = await call('glpi_list_changes', { limit: 2 });
    return `totalcount=${r.totalcount}`;
  });
  await check('glpi_tickets_stats_by (status)', async () => {
    const r = await call('glpi_tickets_stats_by', {});
    return `total=${r.total}`;
  });
  // Projects (#14): states, then the first project with every section.
  let projectId: number | undefined;
  await check('glpi_list_items Project (state labels)', async () => {
    const r = await call('glpi_list_items', { itemtype: 'Project', limit: 3 });
    projectId = r.items[0]?.id;
    const first = r.items[0];
    if (first && !('state_is_finished' in first)) throw new Error('no state_is_finished on Project rows');
    return `totalcount=${r.totalcount}${first ? `, first state=${JSON.stringify(first.state)}` : ''}`;
  });
  await check('glpi_list_items ProjectState', async () => {
    const r = await call('glpi_list_items', { itemtype: 'ProjectState' });
    return `${r.totalcount} states, finished: ${r.items.filter((s: { is_finished: number }) => s.is_finished).map((s: { name: string }) => s.name).join(', ') || 'none'}`;
  });
  if (projectId !== undefined) {
    await check(`glpi_get_item Project ${projectId} with every section`, async () => {
      const r = await call('glpi_get_item', {
        itemtype: 'Project',
        id: projectId,
        with: ['task_details', 'team', 'tickets', 'changes', 'problems', 'costs', 'items', 'subprojects', 'documents'],
      });
      if (!r.counts) throw new Error('no counts');
      const sections = Object.keys(r).filter((k) => k.startsWith('_') && k !== '_errors');
      return `counts=${JSON.stringify(r.counts)}, sections=${sections.join(',')}${r._errors ? `, errors=${JSON.stringify(r._errors)}` : ''}`;
    });
  }
  await check('glpi_get_session_info', async () => {
    const r = await call('glpi_get_session_info', {});
    return `me=${r.me?.name ?? '?'}, profile=${r.active_profile?.name ?? '?'}, ${r.entities?.length ?? 0} entities`;
  });
  await check('legacy alias glpi_list_computers', async () => {
    const r = await call('glpi_list_computers', { limit: 1 });
    return `totalcount=${r.totalcount}`;
  });
  await mcp.close();

  // ---- write cycle ----
  if (WRITE) {
    console.log('\nWrite cycle (test ticket):');
    let testId: number | undefined;

    await check('createTicket [MCP-SMOKE]', async () => {
      const created = (await client.createTicket({
        name: `[MCP-SMOKE] test ${new Date().toISOString()}`,
        content: 'Automated smoke test from mcp-glpi. Safe to delete.',
        urgency: 1,
      })) as any;
      testId = created?.id;
      if (!testId) throw new Error(`no id in response: ${JSON.stringify(created).slice(0, 200)}`);
      return `created #${testId}`;
    });

    if (testId) {
      await check('addTicketFollowup', async () => {
        await client.addTicketFollowup(testId!, 'Smoke-test followup.');
      });
      await check('updateTicket (rename)', async () => {
        await client.updateTicket(testId!, { name: `[MCP-SMOKE] renamed ${Date.now()}` } as any);
      });
      await check('followup visible in getTicketFollowups', async () => {
        const f = (await client.getTicketFollowups(testId!)) as any[];
        if (f.length < 1) throw new Error('followup not found');
        return `${f.length} followup(s)`;
      });
      await check('deleteTicket (soft)', async () => {
        await client.deleteTicket(testId!, false);
      });
      await check('ticket flagged is_deleted', async () => {
        const t = (await client.getTicket(testId!)) as any;
        if (!t.is_deleted) throw new Error(`is_deleted=${t.is_deleted}`);
        return `#${testId} in trash`;
      });
    }
  }

  // ---- teardown ----
  console.log('\nTeardown:');
  await check('killSession', async () => {
    await client.killSession();
  });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
