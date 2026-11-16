/**
 * Tests for GlpiSearch (range building) and SearchOptionsCache (field
 * resolution on a localized instance).
 *
 * Regression coverage for two bugs found against a live GLPI 11 (French):
 *   - search() passed `limit` as the range END: limit 5 -> "0-5" -> 6 rows.
 *   - resolveField() only matched localized labels ("Statut"), never the
 *     locale-independent column name ("status") or canonical uid.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { GlpiHttp } from '../src/http.js';
import { GlpiSearch } from '../src/search.js';
import { SearchOptionsCache } from '../src/search-options.js';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function installFetch(handler: FetchHandler) {
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(handler);
}

function authedHttp(): GlpiHttp {
  return new GlpiHttp({ url: 'https://glpi.test', userToken: 'u' });
}

test('search() builds an inclusive range: limit 5 -> range=0-4', async () => {
  let capturedRange = '';
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    capturedRange = new URL(url).searchParams.get('range') ?? '';
    return new Response(JSON.stringify({ totalcount: 100, count: 5, data: [1, 2, 3, 4, 5] }), { status: 200 });
  });

  const search = new GlpiSearch(authedHttp());
  await search.search('Ticket', { limit: 5 });
  assert.equal(capturedRange, '0-4');

  await search.search('Ticket', { start: 10, limit: 20 });
  assert.equal(capturedRange, '10-29');
});

test('count() probes with range=0-0 and returns totalcount', async () => {
  let capturedRange = '';
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    capturedRange = new URL(url).searchParams.get('range') ?? '';
    return new Response(JSON.stringify({ totalcount: 1803, count: 1, data: [{}] }), { status: 200 });
  });

  const search = new GlpiSearch(authedHttp());
  const n = await search.count('Ticket');
  assert.equal(n, 1803);
  assert.equal(capturedRange, '0-0');
});

// Catalogue shaped like a real GLPI 11 French instance (labels localized,
// field/uid locale-independent, "name" column duplicated via joined tables).
const FRENCH_TICKET_OPTIONS = {
  '1': { name: 'Titre', table: 'glpi_tickets', field: 'name', uid: 'Ticket.name', datatype: 'itemlink' },
  '2': { name: 'ID', table: 'glpi_tickets', field: 'id', uid: 'Ticket.id', datatype: 'number' },
  '4': { name: 'Demandeur', table: 'glpi_users', field: 'name', uid: 'Ticket.Ticket_User.User.name', datatype: 'dropdown' },
  '12': { name: 'Statut', table: 'glpi_tickets', field: 'status', uid: 'Ticket.status', datatype: 'specific' },
  common: 'metadata entry to be skipped',
};

function installCatalogueFetch() {
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    assert.match(url, /listSearchOptions\/Ticket/);
    return new Response(JSON.stringify(FRENCH_TICKET_OPTIONS), { status: 200 });
  });
}

test('resolveField works on a localized (French) instance', async () => {
  installCatalogueFetch();
  const cache = new SearchOptionsCache(authedHttp());

  // Locale-independent column name — the case that failed live.
  assert.equal(await cache.resolveField('Ticket', 'status'), 12);
  // Localized label still works.
  assert.equal(await cache.resolveField('Ticket', 'Statut'), 12);
  // Explicit uid.
  assert.equal(await cache.resolveField('Ticket', 'Ticket.status'), 12);
  // Numeric passthrough.
  assert.equal(await cache.resolveField('Ticket', 12), 12);
  assert.equal(await cache.resolveField('Ticket', '12'), 12);
  // Unknown stays undefined.
  assert.equal(await cache.resolveField('Ticket', 'does_not_exist'), undefined);
});

test('resolveField prefers the own-table option on column-name collisions', async () => {
  installCatalogueFetch();
  const cache = new SearchOptionsCache(authedHttp());

  // "name" exists on glpi_tickets (id 1, canonical uid Ticket.name) AND on
  // glpi_users via the requester join (id 4). The own-table one must win.
  assert.equal(await cache.resolveField('Ticket', 'name'), 1);
});

test('row searches always ask for the id column; count() does not', async () => {
  const seen: Record<string, string[]> = {};
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    const u = new URL(url);
    if (u.pathname.endsWith('/listSearchOptions/Computer')) {
      return new Response(JSON.stringify({ 2: { name: 'ID', uid: 'Computer.id', field: 'id', table: 'glpi_computers' } }), { status: 200 });
    }
    const forced = [...u.searchParams.entries()].filter(([k]) => k.startsWith('forcedisplay')).map(([, v]) => v);
    seen[u.searchParams.get('range') ?? ''] = forced;
    return new Response(JSON.stringify({ totalcount: 1, count: 1, data: [{ 1: 'PC-1', 2: 7 }] }), { status: 200 });
  });

  const search = new GlpiSearch(authedHttp(), new SearchOptionsCache(authedHttp()));
  const page = await search.search('Computer', { limit: 1, forcedisplay: [31] });
  assert.deepEqual(seen['0-0'], ['2', '31']);
  assert.equal((page.data[0] as Record<string, unknown>).id, 7);

  await search.search('Computer', { limit: 2, forcedisplay: [2, 31] });
  assert.deepEqual(seen['0-1'], ['2', '31'], 'not added twice');

  delete seen['0-0'];
  await search.count('Computer');
  assert.deepEqual(seen['0-0'], []);
});

test('without forcedisplay, GLPI default columns are sent with the id: user prefs first, by rank', async () => {
  let forced: string[] | undefined;
  let prefsFail = false;
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    const u = new URL(url);
    if (u.pathname.endsWith('/DisplayPreference')) {
      if (prefsFail) return new Response(JSON.stringify(['ERROR_RIGHT_MISSING', 'no']), { status: 403 });
      assert.equal(u.searchParams.get('searchText[itemtype]'), '^Computer$');
      return new Response(
        JSON.stringify([
          { itemtype: 'Computer', num: 4, rank: 2, users_id: 0, interface: 'central' },
          { itemtype: 'Computer', num: 31, rank: 1, users_id: 0, interface: 'central' },
          { itemtype: 'Computer', num: 45, rank: 2, users_id: 7, interface: 'central' },
          { itemtype: 'Computer', num: 5, rank: 1, users_id: 7, interface: 'central' },
          { itemtype: 'Computer', num: 9, rank: 1, users_id: 7, interface: 'helpdesk' },
        ]),
        { status: 200 }
      );
    }
    forced = [...u.searchParams.entries()].filter(([k]) => k.startsWith('forcedisplay')).map(([, v]) => v);
    return new Response(JSON.stringify({ totalcount: 0, count: 0, data: [] }), { status: 200 });
  });

  const session = async () => ({ userId: 7, interface: 'central' });
  await new GlpiSearch(authedHttp(), undefined, session).search('Computer', { limit: 1 });
  assert.deepEqual(forced, ['2', '5', '45']);

  const noUserPrefs = async () => ({ userId: 8, interface: 'central' });
  await new GlpiSearch(authedHttp(), undefined, noUserPrefs).search('Computer', { limit: 1 });
  assert.deepEqual(forced, ['2', '31', '4'], 'global prefs');

  prefsFail = true;
  await new GlpiSearch(authedHttp(), undefined, session).search('Computer', { limit: 1 });
  assert.deepEqual(forced, [], 'unreadable prefs: GLPI chooses, as before');
});

test('user ids in linked user columns become names, in one User search; logins and unknown ids stay', async () => {
  const userSearches: URLSearchParams[] = [];
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    const u = new URL(url);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.pathname.endsWith('/listSearchOptions/Ticket')) {
      return ok({
        2: { name: 'ID', uid: 'Ticket.id', field: 'id', table: 'glpi_tickets' },
        4: { name: 'Requester', uid: 'Ticket.Ticket_User.User.name', field: 'name', table: 'glpi_users' },
        22: { name: 'Writer', uid: 'Ticket.users_id_recipient.User.name', field: 'name', table: 'glpi_users' },
      });
    }
    if (u.pathname.endsWith('/listSearchOptions/User')) return ok({});
    if (u.pathname.endsWith('/DisplayPreference')) return ok([]);
    if (u.pathname.endsWith('/search/User')) {
      userSearches.push(u.searchParams);
      return ok({ totalcount: 2, count: 2, data: [{ 2: 10, 1: 'jdoe', 34: 'Doe', 9: 'Jane' }, { 2: 11, 1: 'bot', 34: null, 9: null }] });
    }
    return ok({
      totalcount: 2,
      count: 2,
      data: [
        { 2: 1, 4: ['10', '11', '99'], 22: 'jdoe' },
        { 2: 2, 4: '10', 22: null },
      ],
    });
  });

  const http = authedHttp();
  const search = new GlpiSearch(http, new SearchOptionsCache(http));
  const page = await search.search('Ticket', { limit: 2 });
  const rows = page.data as Array<Record<string, unknown>>;
  assert.deepEqual(rows, [
    { id: 1, requester_name: ['Jane Doe', 'bot', '99'], user_name: 'jdoe' },
    { id: 2, requester_name: 'Jane Doe', user_name: null },
  ]);
  assert.equal(userSearches.length, 1, 'one User search for the page');
  const crit = [...userSearches[0].entries()].filter(([k]) => /criteria\[\d+\]\[value\]/.test(k)).map(([, v]) => v).sort();
  assert.deepEqual(crit, ['10', '11', '99']);
  assert.equal(userSearches[0].get('criteria[1][link]'), 'OR');

  await search.search('Ticket', { limit: 2 });
  assert.equal(userSearches.length, 2, 'only the unknown id 99 is looked up again');
  assert.deepEqual([...userSearches[1].entries()].filter(([k]) => /\[value\]/.test(k)).map(([, v]) => v), ['99']);
});
