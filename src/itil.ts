/**
 * ITIL constants shared by the tool layer.
 *
 * Status values are GLPI's `CommonITILObject` constants. Ticket, Problem and
 * Change share the same numbering (INCOMING=1 ... CLOSED=6, then the
 * object-specific statuses from 7 upward); the labels below follow
 * `Ticket::getAllStatusArray()`, `Problem::getAllStatusArray()` and
 * `Change::getAllStatusArray()` on the GLPI 10.0 and 11 branches. The numbers
 * are NOT the display order of GLPI's dropdowns — do not renumber them.
 */

export type ItilItemtype = 'Ticket' | 'Change' | 'Problem';
export const ITIL_ITEMTYPES: readonly ItilItemtype[] = ['Ticket', 'Change', 'Problem'];

export function isItilItemtype(value: unknown): value is ItilItemtype {
  return typeof value === 'string' && (ITIL_ITEMTYPES as readonly string[]).includes(value);
}

export const TICKET_STATUS: Record<number, string> = {
  1: 'New',
  2: 'Processing (assigned)',
  3: 'Processing (planned)',
  4: 'Pending',
  5: 'Solved',
  6: 'Closed',
};

/** `Problem::getAllStatusArray()` — shares 1..6 with tickets, then 7/8. */
export const PROBLEM_STATUS: Record<number, string> = {
  1: 'New',
  2: 'Processing (assigned)',
  3: 'Processing (planned)',
  4: 'Pending',
  5: 'Solved',
  6: 'Closed',
  7: 'Accepted',
  8: 'Under observation',
};

/**
 * `Change::getAllStatusArray()`. Note the irregular numbering: Evaluation=9,
 * Approval=10, Accepted=7, Testing=11, Qualification=12, Applied=5
 * (= SOLVED), Review=8 (= OBSERVED), Refused=13, Cancelled=14.
 */
export const CHANGE_STATUS: Record<number, string> = {
  1: 'New',
  2: 'Processing (assigned)',
  3: 'Processing (planned)',
  4: 'Pending',
  5: 'Applied (solved)',
  6: 'Closed',
  7: 'Accepted',
  8: 'Review (under observation)',
  9: 'Evaluation',
  10: 'Approval',
  11: 'Testing',
  12: 'Qualification',
  13: 'Refused',
  14: 'Cancelled',
};

/**
 * `CommonITILValidation` constants (GLPI 10 and 11): NONE=1, WAITING=2,
 * ACCEPTED=3, REFUSED=4. Used by a validation's `status` and by the
 * `global_validation` of a ticket or change. Until 4.2.0 this table was
 * shifted by one (1 Waiting, 2 Granted, 3 Refused), so an accepted
 * validation read as refused and answering "refused" accepted it.
 */
export const VALIDATION_STATUS: Record<number, string> = {
  1: 'None',
  2: 'Waiting',
  3: 'Accepted',
  4: 'Refused',
};

export const VALIDATION_ACCEPTED = 3;
export const VALIDATION_REFUSED = 4;
export type ValidationAnswer = typeof VALIDATION_ACCEPTED | typeof VALIDATION_REFUSED;

export const TICKET_URGENCY: Record<number, string> = {
  1: 'Very low',
  2: 'Low',
  3: 'Medium',
  4: 'High',
  5: 'Very high',
};

/**
 * `CommonITILObject::getPriorityName()`: priority shares the 1..5 scale of
 * urgency/impact but adds 6 = Major (set manually).
 */
export const TICKET_PRIORITY: Record<number, string> = {
  1: 'Very low',
  2: 'Low',
  3: 'Medium',
  4: 'High',
  5: 'Very high',
  6: 'Major',
};

export const STATUS_BY_ITEMTYPE: Record<ItilItemtype, Record<number, string>> = {
  Ticket: TICKET_STATUS,
  Problem: PROBLEM_STATUS,
  Change: CHANGE_STATUS,
};
