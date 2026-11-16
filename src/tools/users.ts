/**
 * Users, groups membership, and the GLPI session (who am I, active
 * entity/profile).
 */

import { z } from 'zod';
import type { GlpiUser } from '../glpi-client.js';
import { compactItem, listEnvelope, stripLinks, text } from '../output.js';
import { defineTool, type ToolDef } from './registry.js';
import { defined, entityIdArg, id, listShape, optBool, optId, optStr, toListOptions, verbose } from './common.js';

const listUsers = defineTool({
  name: 'glpi_list_users',
  title: 'List users',
  toolset: 'users',
  description: 'List users, active ones by default. To find one person prefer glpi_find_user.',
  inputSchema: {
    ...listShape,
    active_only: optBool('Default true'),
    verbose,
  },
  handler: async ({ client }, a) => {
    const { opts, start } = toListOptions(a);
    if (a.active_only !== false) opts.searchText = { is_active: '^1$' };
    const page = await client.getItemsPage<Record<string, unknown>>('User', opts);
    return text(listEnvelope(page.items.map((u) => compactItem('User', u, a)), start, page.totalcount));
  },
});

const getUser = defineTool({
  name: 'glpi_get_user',
  title: 'Get user',
  toolset: 'users',
  description: 'One user by id. To look a person up by name use glpi_find_user.',
  inputSchema: {
    id: id(),
    verbose,
  },
  handler: async ({ client }, a) => text(compactItem('User', await client.getUser(a.id), a)),
});

const findUser = defineTool({
  name: 'glpi_find_user',
  title: 'Find user',
  toolset: 'users',
  description: 'Find users by login, last name or first name substring, exact login first.',
  inputSchema: {
    query: z.string().min(1).describe('Login, last name or first name'),
    exact: optBool('That exact login only (or null)'),
    limit: z.number().int().min(1).max(50).optional().describe('Default 10'),
  },
  handler: async ({ client }, a) => {
    if (a.exact) {
      const user = await client.getUserByName(a.query);
      return text(user ? compactItem('User', user) : null);
    }
    const limit = a.limit ?? 10;
    const q = a.query.trim();
    const range = `0-${limit - 1}`;
    const [byLogin, byLast, byFirst] = await Promise.all(
      (['name', 'realname', 'firstname'] as const).map((column) =>
        client.getItems<GlpiUser>('User', { range, expand_dropdowns: true, searchText: { [column]: q } })
      )
    );
    const seen = new Set<number>();
    const merged: GlpiUser[] = [];
    const lower = q.toLowerCase();
    const exactFirst = [...byLogin].sort(
      (x, y) =>
        Number(String(y.name ?? '').trim().toLowerCase() === lower) - Number(String(x.name ?? '').trim().toLowerCase() === lower)
    );
    for (const u of [...exactFirst, ...byLast, ...byFirst]) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      merged.push(u);
    }
    const items = merged.slice(0, limit).map((u) => compactItem('User', u));
    return text({ query: q, count: items.length, items });
  },
});

const createUser = defineTool({
  name: 'glpi_create_user',
  title: 'Create user',
  toolset: 'admin',
  description: 'Create a user account; no password (LDAP/SSO, invitation or an admin sets it).',
  inputSchema: {
    name: z.string().min(1).describe('Login'),
    realname: optStr('Last name'),
    firstname: optStr(),
    email: optStr(),
    phone: optStr(),
    profiles_id: optId('Default profile'),
    entities_id: optId('Default entity'),
  },
  handler: async ({ client }, a) => {
    const result = await client.createUser(defined(a) as Parameters<typeof client.createUser>[0]);
    return text({ success: true, ...result });
  },
});

const addUserToGroup = defineTool({
  name: 'glpi_add_user_to_group',
  title: 'Add user to group',
  toolset: 'admin',
  description: 'Make a user a member, or a manager, of a group.',
  inputSchema: {
    user_id: id(),
    group_id: id(),
    is_manager: optBool(),
  },
  handler: async ({ client }, a) => {
    const result = await client.addUserToGroup(a.user_id, a.group_id, a.is_manager ?? false);
    return text({ success: true, ...result });
  },
});

// ---- session -----------------------------------------------------------------

function pickName(obj: unknown): { id?: unknown; name?: unknown } | unknown {
  if (!obj || typeof obj !== 'object') return obj;
  const o = obj as Record<string, unknown>;
  return defined({ id: o.id, name: o.name ?? o.completename, interface: o.interface });
}

const getSessionInfo = defineTool({
  name: 'glpi_get_session_info',
  title: 'Get session info',
  toolset: 'core',
  description: 'Connected user (me), active profile and entity, and the profiles and entities available.',
  inputSchema: {
    verbose,
  },
  handler: async ({ client }, a) => {
    const [active, profiles, entities, full] = await Promise.all([
      client.getActiveProfile(),
      client.getMyProfiles(),
      client.getMyEntities(),
      client.getFullSession().catch(() => undefined),
    ]);
    if (a.verbose) {
      return text(stripLinks({ active_profile: active, available_profiles: profiles, entities, session: full }));
    }
    const session = ((full as Record<string, unknown> | undefined)?.session ?? {}) as Record<string, unknown>;
    const activeProfile = (active as Record<string, unknown> | undefined)?.active_profile ?? active;
    const profileList = ((profiles as unknown as Record<string, unknown>)?.myprofiles ?? profiles) as unknown[];
    const entityList = ((entities as unknown as Record<string, unknown>)?.myentities ?? entities) as unknown[];
    return text({
      me: defined({
        id: session.glpiID,
        name: session.glpiname,
        realname: session.glpirealname,
        firstname: session.glpifirstname,
      }),
      active_profile: pickName(activeProfile),
      available_profiles: Array.isArray(profileList) ? profileList.map(pickName) : profileList,
      active_entity: defined({
        id: session.glpiactive_entity,
        name: session.glpiactive_entity_name ?? session.glpiactive_entity_shortname,
        recursive: session.glpiactive_entity_recursive,
      }),
      entities: Array.isArray(entityList) ? entityList.map(pickName) : entityList,
    });
  },
});

const SHARED_SESSION_NOTE = ' of the session shared by all clients.';

const setActiveEntity = defineTool({
  name: 'glpi_set_active_entity',
  title: 'Set active entity',
  toolset: 'session',
  annotations: { destructiveHint: false },
  description: 'Switch the active entity' + SHARED_SESSION_NOTE,
  inputSchema: {
    entity_id: entityIdArg('Entity id (0 = root), or "all"'),
    is_recursive: optBool('With sub-entities'),
  },
  handler: async ({ client }, a) => {
    await client.changeActiveEntities(a.entity_id, a.is_recursive ?? false);
    return text({ success: true, entity_id: a.entity_id, is_recursive: a.is_recursive ?? false });
  },
});

const setActiveProfile = defineTool({
  name: 'glpi_set_active_profile',
  title: 'Set active profile',
  toolset: 'session',
  annotations: { destructiveHint: false },
  description: 'Switch the active profile' + SHARED_SESSION_NOTE,
  inputSchema: {
    profile_id: id(),
  },
  handler: async ({ client }, a) => {
    await client.changeActiveProfile(a.profile_id);
    return text({ success: true, profile_id: a.profile_id });
  },
});

export const USER_TOOLS: ToolDef[] = [
  listUsers,
  getUser,
  findUser,
  createUser,
  addUserToGroup,
  getSessionInfo,
  setActiveEntity,
  setActiveProfile,
];
