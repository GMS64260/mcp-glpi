/**
 * 4.3.0, issue #21, through the real McpServer and a fake GLPI:
 *   - validation codes as GLPI writes them (2 Waiting, 3 Accepted, 4 Refused);
 *   - sub-resources read to the end (GLPI's default is one page), and a paged timeline;
 *   - actors and links of tickets, problems and changes;
 *   - glpi_assign_ticket add / replace / remove;
 *   - search rows of itemtypes GLPI has no display preference or id option for;
 *   - project tasks by team member.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GlpiClient, SUB_ITEMS_PAGE } from '../src/glpi-client.js';
import { createMcpServer } from '../src/server.js';

interface FetchCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: { input: Record<string, unknown> };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

function installFetch(route: (c: FetchCall) => Response | undefined): FetchCall[] {
  const calls: FetchCall[] = [];
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/apirest\.php\//, '');
    if (path === 'initSession') return json({ session_token: 's' });
    const call: FetchCall = {
      method: init?.method ?? 'GET',
      path,
      query: u.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return route(call) ?? json([]);
  });
  return calls;
}

const glpiClient = () => new GlpiClient({ url: 'https://glpi.test', userToken: 'u', maxRetries: 0 });

async function call(name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ client: glpiClient() });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  await client.close();
  const text = (result.content[0] as { text: string }).text;
  return { result, text, json: () => JSON.parse(text) };
}

const forcedisplay = (c: FetchCall) => [...c.query.entries()].filter(([k]) => k.startsWith('forcedisplay')).map(([, v]) => Number(v));
const writes = (calls: FetchCall[]) => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

// ---- validation codes ---------------------------------------------------------

/** A GLPI that stores the answer of a validation, like the approver's own session. */
function validationGlpi(stored: { status: number }, accepts = true) {
  return (c: FetchCall): Response | undefined => {
    if (!/^(Ticket|Change)Validation\/5$/.test(c.path)) return undefined;
    if (c.method === 'PUT') {
      if (accepts) stored.status = Number(c.body!.input.status);
      return json([{ '5': true }]);
    }
    return json({ id: 5, status: stored.status });
  };
}
const puts = (calls: FetchCall[]) => calls.filter((c) => c.method === 'PUT');

test('glpi_set_validation_status: accepted is GLPI 3, refused is 4 and needs a comment, numbers are refused', async () => {
  const calls = installFetch(validationGlpi({ status: 2 }));

  const accepted = (await call('glpi_set_validation_status', { validation_id: 5, status: 'accepted' })).json();
  assert.deepEqual([accepted.status, accepted.status_label, accepted.verified], [3, 'Accepted', true]);
  assert.equal(puts(calls).at(-1)!.body!.input.status, 3);

  const noReason = await call('glpi_set_validation_status', { validation_id: 5, status: 'refused' });
  assert.ok(noReason.result.isError);
  assert.match(noReason.text, /comment_validation is required/);

  const refused = (await call('glpi_set_validation_status', { validation_id: 5, status: 'refused', comment_validation: 'No budget' })).json();
  assert.equal(refused.status_label, 'Refused');
  assert.deepEqual([puts(calls).at(-1)!.body!.input.status, puts(calls).at(-1)!.body!.input.comment_validation], [4, 'No budget']);

  // 4.2.0 documented "2 Granted, 3 Refused": GLPI read them as Waiting and Accepted.
  for (const legacy of [2, 3, '3']) {
    const r = await call('glpi_set_validation_status', { validation_id: 5, status: legacy, comment_validation: 'x' });
    assert.ok(r.result.isError, `status ${JSON.stringify(legacy)} is refused`);
    assert.match(r.text, /"accepted" or "refused"/);
  }
  assert.deepEqual(writes(calls), ['PUT TicketValidation/5', 'PUT TicketValidation/5']);
});

test('glpi_set_validation_status: a change validation is answered in its own table, and an ignored answer is an error', async () => {
  // Ticket and change validations have separate ids: 5 here is a ChangeValidation.
  const onChange = installFetch(validationGlpi({ status: 2 }));
  const ok = (await call('glpi_set_validation_status', { validation_id: 5, itemtype: 'Change', status: 'accepted' })).json();
  assert.deepEqual(writes(onChange), ['PUT ChangeValidation/5']);
  assert.deepEqual([ok.itemtype, ok.verified], ['Change', true]);

  // GLPI answers 200 to an account that is not the approver, and keeps the validation waiting.
  installFetch(validationGlpi({ status: 2 }, false));
  const ignored = await call('glpi_set_validation_status', { validation_id: 5, status: 'accepted' });
  assert.ok(ignored.result.isError);
  assert.match(ignored.text, /did not record the answer: TicketValidation 5 is still "Waiting"/);

  // The library method refuses the codes of the old convention too.
  await assert.rejects(() => glpiClient().setTicketValidationStatus(5, 2 as never), /3 \(accepted\) or 4 \(refused\)/);
});

test('validation codes are labelled as GLPI defines them, in the timeline and on the object', async () => {
  installFetch((c) => {
    if (c.path === 'Ticket/7/TicketValidation') {
      return json([
        { id: 1, status: 2, submission_date: '2026-01-01 08:00:00' },
        { id: 2, status: 3, submission_date: '2026-01-02 08:00:00', comment_validation: '<p>Go ahead</p>' },
        { id: 3, status: 4, submission_date: '2026-01-03 08:00:00' },
      ]);
    }
    if (c.path === 'Change/4') return json({ id: 4, name: 'Upgrade', status: 10, global_validation: 3, rolloutplancontent: '<p>Step 1</p>' });
    return undefined;
  });
  const timeline = (await call('glpi_get_ticket_timeline', { id: 7, kinds: ['validation'] })).json();
  assert.deepEqual(timeline.timeline.map((v: Record<string, unknown>) => v.status_label), ['Waiting', 'Accepted', 'Refused']);
  assert.equal(timeline.timeline[1].comment_validation, 'Go ahead');

  const change = (await call('glpi_get_change', { id: 4 })).json();
  assert.equal(change.global_validation_label, 'Accepted');
  assert.equal(change.rolloutplancontent, 'Step 1');
});

// ---- sub-resources and the timeline -------------------------------------------

const stamp = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString().slice(0, 19).replace('T', ' ');

/** A ticket with `total` followups, served by range like GLPI (Content-Range, 206). */
function longTicket(total: number) {
  return (c: FetchCall): Response | undefined => {
    if (c.path !== 'Ticket/9/ITILFollowup') return undefined;
    const [start, end] = (c.query.get('range') ?? '0-49').split('-').map(Number);
    const rows = [];
    for (let i = start; i <= Math.min(end, total - 1); i++) rows.push({ id: i + 1, date_creation: stamp(i), content: `f${i + 1}` });
    return json(rows, { status: 206, headers: { 'Content-Range': `${start}-${start + rows.length - 1}/${total}` } });
  };
}

test('glpi_get_ticket_timeline reads every row and pages the result', async () => {
  const calls = installFetch(longTicket(450));
  const args = { id: 9, kinds: ['followup'] };

  const first = (await call('glpi_get_ticket_timeline', args)).json();
  assert.deepEqual([first.totalcount, first.start, first.count, first.next_start], [450, 0, 50, 50]);
  assert.equal(first.timeline[0].id, 1);
  // Without a range GLPI answers one page (15 to 50 rows): every page is asked for.
  assert.deepEqual(calls.map((c) => c.query.get('range')), ['0-199', '200-399', '400-599']);

  const newest = (await call('glpi_get_ticket_timeline', { ...args, order: 'DESC', limit: 2 })).json();
  assert.deepEqual(newest.timeline.map((e: { id: number }) => e.id), [450, 449]);
  assert.equal(newest.next_start, 2);

  const last = (await call('glpi_get_ticket_timeline', { ...args, start: 448, limit: 500 })).json();
  assert.deepEqual([last.count, last.next_start], [2, null]);
  assert.deepEqual(last.timeline.map((e: { id: number }) => e.id), [449, 450]);
});

test('getSubItems stops on a short page, and on a range past the end when GLPI sent no total', async () => {
  const calls = installFetch((c) => {
    if (c.path !== 'Ticket/1/ITILFollowup') return undefined;
    if (c.query.get('range') === `0-${SUB_ITEMS_PAGE - 1}`) return json(Array.from({ length: SUB_ITEMS_PAGE }, (_, i) => ({ id: i + 1 })));
    return json(['ERROR_RANGE_EXCEED_TOTAL', 'Provided range exceed total count of data: 200'], { status: 400 });
  });
  const rows = await glpiClient().getSubItems('Ticket/1/ITILFollowup');
  assert.equal(rows.length, SUB_ITEMS_PAGE);
  assert.equal(calls.length, 2);

  // No total and a full page: the next page is asked for, and an empty one ends the read.
  const exact = installFetch((c) => {
    if (c.path !== 'Ticket/3/ITILFollowup') return undefined;
    return c.query.get('range') === `0-${SUB_ITEMS_PAGE - 1}` ? json(Array.from({ length: SUB_ITEMS_PAGE }, (_, i) => ({ id: i + 1 }))) : json([]);
  });
  assert.equal((await glpiClient().getSubItems('Ticket/3/ITILFollowup')).length, SUB_ITEMS_PAGE);
  assert.deepEqual(exact.map((c) => c.query.get('range')), [`0-${SUB_ITEMS_PAGE - 1}`, `${SUB_ITEMS_PAGE}-${2 * SUB_ITEMS_PAGE - 1}`]);

  const short = installFetch((c) => (c.path === 'Ticket/2/ITILFollowup' ? json([{ id: 1 }, { id: 2 }]) : undefined));
  assert.equal((await glpiClient().getSubItems('Ticket/2/ITILFollowup')).length, 2);
  assert.equal(short.length, 1);
});

// ---- actors and links ---------------------------------------------------------

function problemGlpi(c: FetchCall): Response | undefined {
  switch (c.path) {
    case 'Problem/3':
      return json({ id: 3, name: 'Mail outage', status: 2, content: '<p>Mail is down</p>', causecontent: '<p>Disk full</p>' });
    case 'Problem/3/Problem_User':
      return json([
        { id: 1, problems_id: 3, users_id: 12, type: 2 },
        { id: 2, problems_id: 3, users_id: 0, type: 1, alternative_email: 'caller@example.test' },
      ]);
    case 'Problem/3/Group_Problem':
      return json([{ id: 5, problems_id: 3, groups_id: 4, type: 2 }]);
    case 'Problem/3/Problem_Supplier':
      return json(['ERROR_RIGHT_MISSING', 'no'], { status: 403 });
    case 'Problem/3/Problem_Ticket':
      return json([
        { id: 1, problems_id: 3, tickets_id: 4976 },
        { id: 2, problems_id: 3, tickets_id: 4980 },
      ]);
    case 'search/User':
      return json({ totalcount: 1, count: 1, data: [{ '2': 12, '1': 'jdupont', '34': 'Dupont', '9': 'Jean' }] });
    case 'Group/4':
      return json({ id: 4, name: 'N2', completename: 'Support > N2' });
    case 'listSearchOptions/Ticket':
      return json({ 1: option('Ticket.name', 'name'), 2: option('Ticket.id', 'id'), 12: option('Ticket.status', 'status') });
    case 'search/Ticket':
      // 4980 is not returned: trashed, or outside the active entity.
      return json({ totalcount: 1, count: 1, data: [{ '2': 4976, '1': 'Mailbox full', '12': 4 }] });
  }
  return undefined;
}

test('glpi_get_problem: actors by role with names, linked tickets with status, refused lists in _errors', async () => {
  const calls = installFetch(problemGlpi);
  const p = (await call('glpi_get_problem', { id: 3 })).json();

  assert.deepEqual(p.actors, {
    requester: [{ itemtype: 'User', id: 0, name: null, email: 'caller@example.test' }],
    assigned: [
      { itemtype: 'User', id: 12, name: 'Jean Dupont' },
      { itemtype: 'Group', id: 4, name: 'Support > N2' },
    ],
    observer: [],
  });
  assert.deepEqual(p.links, {
    tickets: [{ id: 4976, name: 'Mailbox full', status: 4, status_label: 'Pending' }, { id: 4980 }],
    changes: [],
  });
  assert.match(p._errors.Problem_Supplier, /403 ERROR_RIGHT_MISSING/);
  assert.equal(p.causecontent, 'Disk full');
  assert.deepEqual(p.counts, { followups: 0, tasks: 0, solutions: 0 });
  // One search for the two linked tickets (id = 4976 OR id = 4980), not one read each.
  const searches = calls.filter((c) => c.path === 'search/Ticket');
  assert.equal(searches.length, 1);
  assert.deepEqual(
    [0, 1].map((i) => [searches[0].query.get(`criteria[${i}][field]`), searches[0].query.get(`criteria[${i}][searchtype]`), searches[0].query.get(`criteria[${i}][value]`)]),
    [['2', 'equals', '4976'], ['2', 'equals', '4980']]
  );
  assert.equal(searches[0].query.get('criteria[1][link]'), 'OR');
  assert.equal(calls.filter((c) => /^Ticket\/\d+$/.test(c.path)).length, 0);
});

test('glpi_get_ticket: linked problems, changes and tickets, each ticket link read from its side', async () => {
  const calls = installFetch((c) => {
    if (c.path === 'Ticket/7') return json({ id: 7, name: 'Printer', status: 2 });
    if (c.path === 'Ticket/7/Problem_Ticket') return json([{ id: 1, problems_id: 3, tickets_id: 7 }]);
    if (c.path === 'Ticket_Ticket') {
      if (c.query.get('searchText[tickets_id_1]') === '^7$') return json([{ id: 1, tickets_id_1: 7, tickets_id_2: 9, link: 2 }]);
      if (c.query.get('searchText[tickets_id_2]') === '^7$') return json([{ id: 2, tickets_id_1: 11, tickets_id_2: 7, link: 3 }]);
    }
    return undefined;
  });
  const t = (await call('glpi_get_ticket', { id: 7 })).json();
  assert.deepEqual(t.links, {
    // 11 is a child of 7: seen from 7, "7 parent_of 11".
    tickets: [{ id: 9, relation: 'duplicate' }, { id: 11, relation: 'parent_of' }],
    problems: [{ id: 3 }],
    changes: [],
  });
  assert.deepEqual(t.actors, { requester: [], assigned: [], observer: [] });
  assert.equal(t._errors, undefined);
  // Ticket/7/Ticket_Ticket would return every link of the database.
  assert.ok(!calls.some((c) => c.path === 'Ticket/7/Ticket_Ticket'));
});

// ---- glpi_assign_ticket -------------------------------------------------------

function actorsGlpi(c: FetchCall): Response | undefined {
  if (c.method === 'GET' && c.path === 'Ticket/7/Ticket_User') {
    return json([
      { id: 31, tickets_id: 7, users_id: 12, type: 2 },
      { id: 32, tickets_id: 7, users_id: 99, type: 1 },
      { id: 33, tickets_id: 7, users_id: 14, type: 2 },
    ]);
  }
  if (c.method === 'GET' && c.path === 'Ticket/7/Group_Ticket') return json([{ id: 51, tickets_id: 7, groups_id: 4, type: 2 }]);
  if (c.method === 'GET' && c.path === 'Ticket/8/Ticket_User') {
    return json([
      { id: 61, tickets_id: 8, users_id: 0, type: 1, alternative_email: 'caller@example.test' },
      { id: 62, tickets_id: 8, users_id: 9, type: 1 },
    ]);
  }
  // Ids tell the user link (40) from the group link (41).
  if (c.method === 'POST') return json({ id: /_User$/.test(c.path) ? 40 : 41 }, { status: 201 });
  if (c.method === 'DELETE') return json([{ ok: true }]);
  return undefined;
}

test('glpi_assign_ticket replace: the new technician is added first, then the others of the role leave', async () => {
  const calls = installFetch(actorsGlpi);
  const r = (await call('glpi_assign_ticket', { ticket_id: 7, user_id: 20, mode: 'replace' })).json();
  assert.deepEqual(writes(calls), ['POST Ticket_User', 'DELETE Ticket_User/31', 'DELETE Ticket_User/33']);
  assert.deepEqual(calls.find((c) => c.method === 'POST')!.body!.input, { tickets_id: 7, users_id: 20, type: 2 });
  assert.deepEqual([r.added, r.removed, r.user_assignment_id], [1, 2, 40]);

  // Already assigned: nothing to add, the other technician leaves; the requester (type 1) stays.
  const again = installFetch(actorsGlpi);
  await call('glpi_assign_ticket', { ticket_id: 7, user_id: 12, mode: 'replace' });
  assert.deepEqual(writes(again), ['DELETE Ticket_User/33']);
});

test('glpi_assign_ticket replace: every add comes before the first removal, e-mail requesters stay, a late failure says what was done', async () => {
  const both = installFetch(actorsGlpi);
  await call('glpi_assign_ticket', { ticket_id: 7, user_id: 20, group_id: 6, mode: 'replace' });
  assert.deepEqual(writes(both), ['POST Ticket_User', 'POST Group_Ticket', 'DELETE Ticket_User/31', 'DELETE Ticket_User/33', 'DELETE Group_Ticket/51']);

  // Requester known by e-mail only (users_id 0): not a user the new requester replaces.
  const requester = installFetch(actorsGlpi);
  await call('glpi_assign_ticket', { ticket_id: 8, user_id: 5, type: 1, mode: 'replace' });
  assert.deepEqual(writes(requester), ['POST Ticket_User', 'DELETE Ticket_User/62']);

  // GLPI has no transaction: the removal that fails leaves the adds in place, and the error says so.
  const failing = installFetch((c) =>
    c.method === 'DELETE' && c.path === 'Ticket_User/33' ? json(['ERROR_GLPI_DELETE', 'no'], { status: 400 }) : actorsGlpi(c)
  );
  const r = await call('glpi_assign_ticket', { ticket_id: 7, user_id: 20, mode: 'replace' });
  assert.ok(r.result.isError);
  assert.match(r.text, /ERROR_GLPI_DELETE/);
  assert.match(r.text, /Partly applied on Ticket 7 before this failure: added Ticket_User 40; removed Ticket_User 31\./);
  assert.deepEqual(writes(failing), ['POST Ticket_User', 'DELETE Ticket_User/31', 'DELETE Ticket_User/33']);

  // A refused add removes nobody, and is reported as it is.
  const refused = installFetch((c) => (c.method === 'POST' ? json(['ERROR_GLPI_ADD', 'no'], { status: 400 }) : actorsGlpi(c)));
  const none = await call('glpi_assign_ticket', { ticket_id: 7, user_id: 20, mode: 'replace' });
  assert.ok(none.result.isError);
  assert.doesNotMatch(none.text, /Partly applied/);
  assert.deepEqual(writes(refused), ['POST Ticket_User']);
});

test('glpi_assign_ticket remove: takes the actor off, refuses one that does not hold the role', async () => {
  const calls = installFetch(actorsGlpi);
  const wrong = await call('glpi_assign_ticket', { ticket_id: 7, user_id: 50, mode: 'remove' });
  assert.ok(wrong.result.isError);
  assert.match(wrong.text, /User 50 is not assigned of Ticket 7 \(User ids with that role: 12, 14\)/);
  assert.deepEqual(writes(calls), []);

  const ok = (await call('glpi_assign_ticket', { ticket_id: 7, user_id: 12, mode: 'remove' })).json();
  assert.deepEqual(writes(calls), ['DELETE Ticket_User/31']);
  assert.deepEqual([ok.added, ok.removed], [0, 1]);
});

test('glpi_assign_ticket add: as before on a ticket, and on a problem through its own link tables', async () => {
  const calls = installFetch(actorsGlpi);
  const t = (await call('glpi_assign_ticket', { ticket_id: 7, user_id: 5, group_id: 6 })).json();
  assert.deepEqual(writes(calls), ['POST Ticket_User', 'POST Group_Ticket']);
  assert.ok(!calls.some((c) => c.method === 'GET'), 'add reads nothing first');
  assert.deepEqual([t.assignment_id, t.user_assignment_id, t.group_assignment_id], [40, 40, 41]);

  const onProblem = installFetch(actorsGlpi);
  await call('glpi_assign_ticket', { ticket_id: 3, itemtype: 'Problem', group_id: 4, type: 3 });
  const post = onProblem.find((c) => c.method === 'POST')!;
  assert.equal(post.path, 'Group_Problem');
  assert.deepEqual(post.body!.input, { problems_id: 3, groups_id: 4, type: 3 });
});

// ---- search rows --------------------------------------------------------------

const option = (uid: string, field: string, extra: Record<string, unknown> = {}) => ({ name: uid, uid, field, ...extra });

test('glpi_search_v2 on a link table: the catalogue gives the columns GLPI has no preference for', async () => {
  let refuseJoins = false;
  const calls = installFetch((c) => {
    if (c.path === 'listSearchOptions/Problem_Ticket') {
      return json({
        2: option('Problem_Ticket.id', 'id'),
        3: option('Problem_Ticket.Problem.id', 'id'),
        4: option('Problem_Ticket.Ticket.id', 'id'),
        // GLPI answers 400 to a forced column marked nodisplay: never asked for.
        9: option('Problem_Ticket.Ticket.content', 'content', { nodisplay: true }),
      });
    }
    if (c.path === 'search/Problem_Ticket') {
      const cols = forcedisplay(c);
      if (refuseJoins && cols.length > 1) return json(['ERROR_GLPI', 'unknown column'], { status: 400 });
      const row: Record<string, number> = { 2: 1, 3: 1, 4: 4976 };
      return json({ totalcount: 1, count: 1, data: [Object.fromEntries(cols.map((id) => [id, row[id]]))] });
    }
    return undefined; // DisplayPreference: none
  });
  const rows = (await call('glpi_search_v2', { itemtype: 'Problem_Ticket' })).json();
  assert.deepEqual(rows.items, [{ id: 1, problem_id: 1, ticket_id: 4976 }]);
  assert.deepEqual(forcedisplay(calls.find((c) => c.path === 'search/Problem_Ticket')!), [2, 3, 4]);

  // Guessed columns never cost a search that worked before: retried with the id only.
  refuseJoins = true;
  const fallback = (await call('glpi_search_v2', { itemtype: 'Problem_Ticket' })).json();
  assert.deepEqual(fallback.items, [{ id: 1 }]);
});

test('glpi_search_v2 on an itemtype without an id option: ids from withindexes, unless a sort is asked', async () => {
  // ChangeValidation on GLPI 10: no id option, and option 2 is a comment.
  const calls = installFetch((c) => {
    if (c.path === 'listSearchOptions/ChangeValidation') {
      return json({
        1: option('ChangeValidation.comment_submission', 'comment_submission'),
        2: option('ChangeValidation.comment_validation', 'comment_validation'),
        3: option('ChangeValidation.status', 'status'),
        4: option('ChangeValidation.submission_date', 'submission_date'),
      });
    }
    if (c.path === 'search/ChangeValidation') {
      const rows = { 8: { 1: 'Please review', 2: 'OK for me', 3: 3, 4: '2026-01-02 08:00:00' }, 12: { 1: 'Again', 2: null, 3: 2, 4: '2026-01-05 08:00:00' } };
      return json({ totalcount: 2, count: 2, data: c.query.get('withindexes') ? rows : Object.values(rows) });
    }
    return undefined;
  });
  const rows = (await call('glpi_search_v2', { itemtype: 'ChangeValidation', order: 'DESC' })).json();
  assert.deepEqual(rows.items, [
    { id: 12, comment_submission: 'Again', comment_validation: null, status: 2, status_label: 'Waiting', submission_date: '2026-01-05 08:00:00' },
    { id: 8, comment_submission: 'Please review', comment_validation: 'OK for me', status: 3, status_label: 'Accepted', submission_date: '2026-01-02 08:00:00' },
  ]);
  const search = calls.find((c) => c.path === 'search/ChangeValidation')!;
  assert.deepEqual(forcedisplay(search), [1, 2, 3, 4], 'option 2 is not taken for the id');
  assert.equal(search.query.get('withindexes'), 'true');

});

test('a sorted search on an itemtype without an id option keeps GLPI order and asks no withindexes', async () => {
  const calls = installFetch((c) => {
    if (c.path === 'listSearchOptions/ChangeValidation') {
      return json({ 1: option('ChangeValidation.comment_submission', 'comment_submission'), 3: option('ChangeValidation.status', 'status') });
    }
    if (c.path === 'search/ChangeValidation') return json({ totalcount: 2, count: 2, data: [{ 1: 'b', 3: 4 }, { 1: 'a', 3: 2 }] });
    return undefined;
  });
  const rows = (await call('glpi_search_v2', { itemtype: 'ChangeValidation', sort: 'status', order: 'DESC' })).json();
  assert.deepEqual(rows.items.map((r: Record<string, unknown>) => [r.id, r.comment_submission, r.status_label]), [
    [undefined, 'b', 'Refused'],
    [undefined, 'a', 'Waiting'],
  ]);
  const search = calls.find((c) => c.path === 'search/ChangeValidation')!;
  assert.equal(search.query.get('withindexes'), null);
  assert.equal(search.query.get('sort'), '3');
});

test('a GLPI that ignores withindexes gives rows without id, never numbered by position', async () => {
  installFetch((c) => {
    if (c.path === 'listSearchOptions/ChangeValidation') return json({ 1: option('ChangeValidation.comment_submission', 'comment_submission') });
    if (c.path === 'search/ChangeValidation') return json({ totalcount: 2, count: 2, data: [{ 1: 'a' }, { 1: 'b' }] });
    return undefined;
  });
  const rows = (await call('glpi_search_v2', { itemtype: 'ChangeValidation' })).json();
  assert.deepEqual(rows.items, [{ comment_submission: 'a' }, { comment_submission: 'b' }]);
});

test('ProjectTask search rows name the parent task', async () => {
  installFetch((c) => {
    if (c.path === 'listSearchOptions/ProjectTask') {
      return json({ 1: option('ProjectTask.name', 'name'), 13: option('ProjectTask.name', 'name') });
    }
    if (c.path === 'search/ProjectTask') return json({ totalcount: 1, count: 1, data: { 11: { 1: 'Pull cables', 13: 'Cabling' } } });
    return undefined;
  });
  const rows = (await call('glpi_search_v2', { itemtype: 'ProjectTask' })).json();
  assert.deepEqual(rows.items, [{ id: 11, name: 'Pull cables', parent_task: 'Cabling' }]);
});

// ---- project tasks by team member ---------------------------------------------

test('glpi_get_item User with project_tasks: the tasks whose team holds the user', async () => {
  const calls = installFetch((c) => {
    switch (c.path) {
      case 'User/7':
        return json({ id: 7, name: 'jdoe' });
      case 'ProjectTaskTeam':
        return json([
          { id: 1, projecttasks_id: 10, itemtype: 'User', items_id: 7 },
          { id: 2, projecttasks_id: 11, itemtype: 'User', items_id: 7 },
        ]);
      case 'ProjectTask/10':
        return json({ id: 10, name: 'Cabling', projects_id: 5, projectstates_id: 2, percent_done: 40, plan_end_date: '2026-12-01 00:00:00', content: '<p>long</p>' });
      case 'ProjectTask/11':
        return json(['ERROR_ITEM_NOT_FOUND', 'Item not found'], { status: 404 });
      case 'Project/5':
        return json({ id: 5, name: 'Office move' });
      case 'ProjectState':
        return json([{ id: 2, name: 'Processing', is_finished: 0 }]);
    }
    return undefined;
  });
  const user = (await call('glpi_get_item', { itemtype: 'User', id: 7, with: ['project_tasks'] })).json();
  assert.deepEqual(user._project_tasks[0], {
    id: 10,
    name: 'Cabling',
    projects_id: 5,
    project: 'Office move',
    state: 'Processing',
    state_is_finished: false,
    percent_done: 40,
    plan_end_date: '2026-12-01 00:00:00',
  });
  assert.equal(user._project_tasks[1].id, 11);
  assert.match(user._project_tasks[1].unreadable, /404 ERROR_ITEM_NOT_FOUND/);
  // The team is filtered by member, exactly (12 must not match 112).
  const team = calls.find((c) => c.path === 'ProjectTaskTeam')!;
  assert.deepEqual([team.query.get('searchText[itemtype]'), team.query.get('searchText[items_id]')], ['^User$', '^7$']);
  assert.equal(calls.find((c) => c.path === 'User/7')!.query.get('with_project_tasks'), null);

  installFetch(() => undefined);
  const wrong = await call('glpi_get_item', { itemtype: 'Computer', id: 1, with: ['project_tasks'] });
  assert.ok(wrong.result.isError);
  assert.match(wrong.text, /User or Group only/);
});
