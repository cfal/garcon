import type { TranscriptNoticeDetail } from '../../common/transcript-notice-details.js';
import type { CarriedContext } from '../../common/transcript-seed.js';

export type CarryOverOutcome =
  | { readonly kind: 'no-history' }
  | { readonly kind: 'complete'; readonly context: CarriedContext }
  | {
      readonly kind: 'compacted';
      readonly context: CarriedContext;
      readonly summary: string;
    };

interface CarryOverNotice {
  readonly title: string;
  readonly content: string;
  readonly detail?: TranscriptNoticeDetail;
}

interface ResolvedCarryOverOutcome {
  readonly context: CarriedContext | null;
  readonly notice: CarryOverNotice | null;
}

export function resolveCarryOverOutcome(
  outcome: CarryOverOutcome,
): ResolvedCarryOverOutcome {
  if (outcome.kind === 'no-history') {
    return { context: null, notice: null };
  }
  if (outcome.kind === 'complete') {
    return {
      context: outcome.context,
      notice: {
        title: 'History carried without compaction',
        content: 'Earlier chat history was small enough to carry over as context.',
      },
    };
  }
  return {
    context: outcome.context,
    notice: {
      title: 'Handoff summary',
      content: outcome.summary,
      detail: { type: 'handoff-summary' },
    },
  };
}
