/**
 * Problems and changes. Followups/tasks/solutions on them go through the
 * ticket write tools with `itemtype`, their timeline through
 * glpi_get_ticket_timeline with `itemtype`.
 */

import { z } from 'zod';
import { ArgumentError } from '../errors.js';
import { compactItem, listEnvelope, text } from '../output.js';
import { defineTool, type ToolDef } from './registry.js';
import { readItilRelations } from './itil-relations.js';
import {
  IMPACT_DESC,
  PRIORITY_DESC,
  STATUS_CHANGE_DESC,
  STATUS_PROBLEM_DESC,
  URGENCY_DESC,
  defined,
  id,
  listShape,
  optId,
  optInt,
  optStr,
  textShape,
  toListOptions,
  verbose,
} from './common.js';

/** Keys of a problem/change in list results (no content). */
export const ITIL_LIST_FIELDS = [
  'id', 'name', 'status', 'status_label', 'urgency', 'urgency_label', 'priority', 'priority_label',
  'itilcategories_id', 'entities_id', 'date', 'date_mod', 'solvedate', 'closedate',
];

/** Arguments of glpi_update_problem / glpi_update_change. */
function itilUpdateShape(statusDesc: string) {
  return {
    id: id(),
    name: optStr('Title'),
    content: optStr(),
    status: optInt(statusDesc),
    urgency: optInt(URGENCY_DESC),
    impact: optInt(IMPACT_DESC),
    priority: optInt(PRIORITY_DESC),
    itilcategories_id: optId(),
  };
}

/** Fields glpi_update_problem / glpi_update_change change; glpi_update_item allows the same. */
export const ITIL_UPDATE_FIELDS: readonly string[] = Object.keys(itilUpdateShape('')).filter((k) => k !== 'id');

function itilTools(itemtype: 'Problem' | 'Change'): ToolDef[] {
  const lower = itemtype.toLowerCase();
  const plural = `${lower}s`;
  const statusDesc = itemtype === 'Problem' ? STATUS_PROBLEM_DESC : STATUS_CHANGE_DESC;

  const list = defineTool({
    name: `glpi_list_${plural}`,
    title: `List ${plural}`,
    toolset: 'itil',
    description: `List ${plural}, newest first, with status labels. To filter use glpi_search_v2.`,
    inputSchema: {
      ...listShape,
      verbose,
    },
    handler: async ({ client }, a) => {
      const { opts, start } = toListOptions(a, 'DESC');
      const page = await client.getItemsPage<Record<string, unknown>>(itemtype, opts);
      const items = page.items.map((row) =>
        compactItem(itemtype, row, a.verbose ? { verbose: true } : { fields: ITIL_LIST_FIELDS })
      );
      return text(listEnvelope(items, start, page.totalcount));
    },
  });

  const get = defineTool({
    name: `glpi_get_${lower}`,
    title: `Get ${lower}`,
    toolset: 'itil',
    description: `One ${lower}: labels, plain-text content, actors, links, counts.`,
    inputSchema: {
      id: id(),
      verbose,
      ...textShape,
    },
    handler: async ({ client }, a) => {
      const [obj, counts, relations] = await Promise.all([
        client.getItem(itemtype, a.id),
        client.countItilChildren(itemtype, a.id, itemtype === 'Change'),
        readItilRelations(client, itemtype, a.id),
      ]);
      return text({ ...compactItem(itemtype, obj, a), ...relations, counts });
    },
  });

  const create = defineTool({
    name: `glpi_create_${lower}`,
    title: `Create ${lower}`,
    toolset: 'itil',
    description: `Create a ${lower} and return its id.`,
    inputSchema: {
      name: z.string().min(1).describe('Title'),
      content: z.string().min(1).describe('Description'),
      urgency: optInt(URGENCY_DESC),
      impact: optInt(IMPACT_DESC),
      priority: optInt(PRIORITY_DESC),
      category_id: optId('ITILCategory id'),
      entity_id: optId('Entity id (default active)'),
    },
    handler: async ({ client }, a) => {
      const result = await client.createItem(
        itemtype,
        defined({
          name: a.name,
          content: a.content,
          urgency: a.urgency,
          impact: a.impact,
          priority: a.priority,
          itilcategories_id: a.category_id,
          entities_id: a.entity_id,
        })
      );
      return text({ success: true, ...result });
    },
  });

  const update = defineTool({
    name: `glpi_update_${lower}`,
    title: `Update ${lower}`,
    toolset: 'itil',
    description: `Change the given fields of a ${lower}.`,
    inputSchema: itilUpdateShape(statusDesc),
    handler: async ({ client }, a) => {
      const { id: itemId, ...fields } = a;
      const updates = defined(fields);
      if (Object.keys(updates).length === 0) {
        throw new ArgumentError('nothing to update: pass at least one field besides id');
      }
      await client.updateItem(itemtype, itemId, updates);
      return text({ success: true, id: itemId });
    },
  });

  return [list, get, create, update];
}

export const ITIL_TOOLS: ToolDef[] = [...itilTools('Problem'), ...itilTools('Change')];
