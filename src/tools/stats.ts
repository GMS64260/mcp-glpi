/**
 * Reporting: ticket counts by dimension, asset totals.
 */

import { z } from 'zod';
import type { GlpiClient } from '../glpi-client.js';
import type { SearchCriterion } from '../search.js';
import { TICKET_STATUS } from '../itil.js';
import { text } from '../output.js';
import { TICKET_FIELDS, monthBuckets, monthCriteria, ticketField } from '../tool-helpers.js';
import { defineTool, type ToolDef } from './registry.js';
import { DATE, optId, optStr } from './common.js';

const ticketsStatsBy = defineTool({
  name: 'glpi_tickets_stats_by',
  title: 'Ticket statistics',
  toolset: 'stats',
  description:
    'Ticket counts by status, category, technician, entity or month, or delays (take into account, solve, close, deadline), per entity and opening period.',
  inputSchema: {
    dimension: z
      .enum(['status', 'category', 'technician', 'entity', 'month', 'delays'])
      .optional()
      .describe('Default status; month: last 6 by default, max 36'),
    date_from: optStr(`Opened after ${DATE}`),
    date_to: optStr(`Opened before ${DATE}`),
    entity_id: optId('Entity id (0 = root)'),
  },
  handler: async ({ client }, a) => {
    const dimension = a.dimension ?? 'status';
    // Search-option ids are resolved through the catalogue (stock GLPI ids are
    // only the fallback): a renumbered option must not report zeros.
    const [entityField, dateField] = await Promise.all([
      ticketField(client, 'entity'),
      ticketField(client, 'date'),
    ]);
    const base: SearchCriterion[] = [];
    if (a.entity_id !== undefined) base.push({ field: entityField, searchtype: 'equals', value: a.entity_id });
    if (a.date_from) base.push({ field: dateField, searchtype: 'morethan', value: a.date_from });
    if (a.date_to) base.push({ field: dateField, searchtype: 'lessthan', value: a.date_to });
    const withBase = (first: SearchCriterion): SearchCriterion[] => [first, ...base.map((b) => ({ ...b, link: 'AND' as const }))];

    if (dimension === 'delays') return text(await delayStats(client, base));

    const counts: Record<string, number> = {};
    if (dimension === 'status') {
      const statusField = await ticketField(client, 'status');
      for (const [statusId, label] of Object.entries(TICKET_STATUS)) {
        counts[label] = await client.search.count(
          'Ticket',
          withBase({ field: statusField, searchtype: 'equals', value: Number(statusId) })
        );
      }
    } else if (dimension === 'category') {
      const categoryField = await ticketField(client, 'category');
      const cats = await client.getCategories({ range: '0-199' });
      for (const cat of cats) {
        const n = await client.search.count('Ticket', withBase({ field: categoryField, searchtype: 'equals', value: cat.id }));
        if (n > 0) counts[cat.completename ?? cat.name] = n;
      }
    } else if (dimension === 'technician') {
      // The actor options (requester 4, technician 5, observer 66) share one
      // uid, so they keep GLPI's standard ids: see TICKET_FIELD_REFS.
      const users = await client.getUsers({ range: '0-199', is_active: true });
      for (const u of users) {
        const n = await client.search.count('Ticket', withBase({ field: TICKET_FIELDS.technician_user, searchtype: 'equals', value: u.id }));
        if (n > 0) counts[`${u.firstname ?? ''} ${u.realname ?? ''} (${u.name})`.trim()] = n;
      }
    } else if (dimension === 'entity') {
      const entities = await client.getEntities({ range: '0-99' });
      for (const e of entities) {
        const n = await client.search.count('Ticket', withBase({ field: entityField, searchtype: 'equals', value: e.id }));
        if (n > 0) counts[e.completename ?? e.name] = n;
      }
    } else {
      const buckets = monthBuckets(a.date_from, a.date_to);
      for (const bucket of buckets) {
        const c = monthCriteria(bucket, dateField);
        if (a.entity_id !== undefined) {
          c.push({ field: entityField, searchtype: 'equals', value: a.entity_id, link: 'AND' });
        }
        counts[bucket.key] = await client.search.count('Ticket', c);
      }
    }
    return text({ dimension, counts, total: Object.values(counts).reduce((s, n) => s + n, 0) });
  },
});

/** Rows read for dimension "delays", at most. */
export const DELAY_MAX_ROWS = 10_000;

const DELAY_FIELDS = {
  takeintoaccount: ['Ticket.takeintoaccount_delay_stat', 150],
  solve: ['Ticket.solve_delay_stat', 154],
  close: ['Ticket.close_delay_stat', 152],
} as const;

/** count, mean, median and 90th percentile, in hours (1 decimal); null when empty. */
export function summarizeSeconds(values: number[]): Record<string, number> | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const hours = (s: number) => Math.round((s / 3600) * 10) / 10;
  return {
    count: sorted.length,
    avg_hours: hours(sorted.reduce((n, v) => n + v, 0) / sorted.length),
    median_hours: hours(at(0.5)),
    p90_hours: hours(at(0.9)),
  };
}

/**
 * Delays of the tickets matching `base`, from GLPI's own delay columns
 * (seconds, counted on the entity calendar when there is one): take into
 * account, solve and close; and how many solved tickets met their
 * time_to_resolve deadline.
 */
async function delayStats(client: GlpiClient, base: SearchCriterion[]) {
  const ids = await Promise.all(
    Object.values(DELAY_FIELDS).map(([uid, fallback]) =>
      client.searchOptions.resolveField('Ticket', uid).then((id) => id ?? fallback, () => fallback)
    )
  );
  const [solvedate, ttr] = await Promise.all([ticketField(client, 'solvedate'), ticketField(client, 'time_to_resolve')]);
  const criteria = base.map((c, i) => (i === 0 ? { ...c, link: undefined } : { ...c, link: 'AND' as const }));
  const result = await client.search.search<Record<string, unknown>>('Ticket', {
    criteria,
    forcedisplay: [...ids, solvedate, ttr],
    fetchAll: true,
    maxRows: DELAY_MAX_ROWS,
    limit: 500,
  });
  const rows = result.data;
  // Rows are keyed by column name, or by option id when the catalogue is unreadable.
  const value = (r: Record<string, unknown>, column: string, optionId: number) => r[column] ?? r[String(optionId)];
  const [tiaId, solveId, closeId] = ids;
  const seconds = (column: string, optionId: number) =>
    rows.map((r) => Number(value(r, column, optionId))).filter((n) => Number.isFinite(n) && n > 0);
  let late = 0;
  let onTime = 0;
  for (const r of rows) {
    const solved = value(r, 'solvedate', solvedate);
    const deadline = value(r, 'time_to_resolve', ttr);
    if (typeof solved !== 'string' || !solved || typeof deadline !== 'string' || !deadline) continue;
    if (solved > deadline) late++;
    else onTime++;
  }
  return {
    dimension: 'delays',
    tickets: result.totalcount,
    ...(rows.length < result.totalcount ? { rows_read: rows.length, truncated: true } : {}),
    take_into_account: summarizeSeconds(seconds('takeintoaccount_delay_stat', tiaId)),
    solve: summarizeSeconds(seconds('solve_delay_stat', solveId)),
    close: summarizeSeconds(seconds('close_delay_stat', closeId)),
    deadline: {
      solved_with_deadline: late + onTime,
      solved_late: late,
      late_rate: late + onTime ? Math.round((late / (late + onTime)) * 1000) / 10 : null,
    },
  };
}

const assetStats = defineTool({
  name: 'glpi_get_asset_stats',
  title: 'Asset statistics',
  toolset: 'stats',
  description: 'Count computers, monitors, printers, network equipment, phones and software.',
  inputSchema: {},
  handler: async ({ client }) => {
    const stats = await client.getAssetStats();
    return text({
      ...stats,
      total: stats.computers + stats.monitors + stats.printers + stats.networkEquipments + stats.phones,
    });
  },
});

export const STATS_TOOLS: ToolDef[] = [ticketsStatsBy, assetStats];
