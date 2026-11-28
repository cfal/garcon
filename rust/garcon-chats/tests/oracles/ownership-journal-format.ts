export { emptyOwnershipJournalV5, isEmptyEarlierJournal, isJournalV5 }
  from '../../../../server/controller/chats/agent-ownership-journal-format.ts';
export { createPreambleBoundaryBinding } from '../../../../server/controller/preambles/boundary.ts';

export function acceptsLifecycleKind(raw: unknown) {
  return ['new-chat', 'fork', 'continuation', 'agent-switch'].includes(raw as string);
}

export function acceptsEpoch(raw: unknown) { return typeof raw === 'string'; }
