/**
 * Search results (`search/{itemtype}`) as list envelopes with readable rows.
 */

import { ArgumentError } from '../errors.js';
import type { GlpiClient } from '../glpi-client.js';
import { VALIDATION_STATUS } from '../itil.js';
import type { SearchResponse } from '../search.js';
import { cleanTextFields, listEnvelope, type ListEnvelope, type TextOptions, withItilLabels } from '../output.js';

/** TicketValidation / ChangeValidation rows: `status_label` next to the code (2 Waiting, 3 Accepted, 4 Refused). */
function withValidationLabel(itemtype: string, row: Record<string, unknown>): Record<string, unknown> {
  if (!/^(Ticket|Change)Validation$/.test(itemtype)) return row;
  const status = Number(row.status);
  return Number.isInteger(status) && VALIDATION_STATUS[status] ? { ...row, status_label: VALIDATION_STATUS[status] } : row;
}

/** Rows keep the readable keys from search.ts, plus ITIL and validation labels and plain-text content. */
export function searchEnvelope(
  itemtype: string,
  result: SearchResponse<Record<string, unknown>>,
  opts: TextOptions = {}
): ListEnvelope<Record<string, unknown>> {
  const items = result.data.map((row) => cleanTextFields(withValidationLabel(itemtype, withItilLabels(itemtype, row)), opts));
  return listEnvelope(items, result.start, result.totalcount);
}

/** A sort argument for search/: option id, or a name/uid/column resolved through the catalogue. */
export async function resolveSearchSort(
  client: GlpiClient,
  itemtype: string,
  sort: string | number | undefined
): Promise<number | undefined> {
  if (sort === undefined) return undefined;
  if (typeof sort === 'number') return sort;
  const resolved = await client.searchOptions.resolveField(itemtype, sort);
  if (resolved === undefined) {
    throw new ArgumentError(`sort: "${sort}" is not a search option of ${itemtype} (see glpi_list_search_options)`);
  }
  return resolved;
}
