/**
 * Knowledge base visibility: who may read an article. GLPI keeps it in four
 * link itemtypes (targets): KnowbaseItem_Profile, Group_KnowbaseItem,
 * KnowbaseItem_User and Entity_KnowbaseItem.
 *
 * glpi_get_item on a KnowbaseItem reads them with `with: ["visibility"]`;
 * glpi_create_item / glpi_delete_item add and remove targets (items.ts).
 */

import type { GlpiClient } from '../glpi-client.js';
import { linkRows, rawRows, sectionError } from './projects.js';

type Row = Record<string, unknown>;

/** Link itemtype -> target itemtype and the column holding the target id. */
export const KB_VISIBILITY_LINKS = [
  { link: 'KnowbaseItem_Profile', itemtype: 'Profile', key: 'profiles_id' },
  { link: 'Group_KnowbaseItem', itemtype: 'Group', key: 'groups_id' },
  { link: 'KnowbaseItem_User', itemtype: 'User', key: 'users_id' },
  { link: 'Entity_KnowbaseItem', itemtype: 'Entity', key: 'entities_id' },
] as const;

/**
 * `_visibility`: one row per target, `{ id, link, itemtype, items_id, name }`
 * plus the entity restriction (entities_id, is_recursive) of profile and group
 * targets. `id` is the link row, the one glpi_delete_item removes (itemtype
 * `link`). A target list GLPI refuses goes to `_errors`.
 */
export async function readKbVisibility(client: GlpiClient, id: number): Promise<Row> {
  const errors: Record<string, string> = {};
  const parts = await Promise.all(
    KB_VISIBILITY_LINKS.map(async (l) => {
      try {
        const raw = await rawRows(client, `KnowbaseItem/${id}/${l.link}`);
        const described = await linkRows(client, raw, (r) => ({ itemtype: l.itemtype, items_id: Number(r[l.key]) }));
        return described.map((row, i) => {
          const out: Row = { id: row.id, link: l.link, itemtype: row.itemtype, items_id: row.items_id, name: row.name };
          if (l.itemtype !== 'Entity' && raw[i].entities_id !== undefined) out.entities_id = raw[i].entities_id;
          if (raw[i].is_recursive !== undefined && l.itemtype !== 'User') out.is_recursive = raw[i].is_recursive;
          return out;
        });
      } catch (err) {
        errors[l.link] = sectionError(err);
        return [];
      }
    })
  );
  const out: Row = { _visibility: parts.flat() };
  if (Object.keys(errors).length) out._errors = errors;
  return out;
}
