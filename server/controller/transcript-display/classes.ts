import { HIDEABLE_TOOL_GROUPS, SUMMARY_CATEGORIES, type HiddenToolGroup, type SummaryCategory } from '../../../common/transcript-display-policy.js';
import type { DisplayProfile } from '../../../common/transcript-display-contract.js';

export interface PostingClass {
  readonly role: 'member' | 'breaker';
  readonly group: HiddenToolGroup | null;
  readonly category: SummaryCategory | null;
  readonly thinking: boolean;
  readonly bash: boolean;
}

export function classId(value: PostingClass): number {
  const group = value.group === null ? 0 : HIDEABLE_TOOL_GROUPS.findIndex(group => group.id === value.group) + 1;
  const category = value.category === null ? 0 : SUMMARY_CATEGORIES.indexOf(value.category) + 1;
  return (((((value.role === 'member' ? 1 : 0) * 8 + group) * 5 + category) * 2
    + Number(value.thinking)) * 2 + Number(value.bash));
}

export function postingClass(id: number): PostingClass {
  const bash = id % 2 === 1; id = Math.floor(id / 2);
  const thinking = id % 2 === 1; id = Math.floor(id / 2);
  const category = id % 5; id = Math.floor(id / 5);
  const group = id % 8; id = Math.floor(id / 8);
  return { role: id === 1 ? 'member' : 'breaker', group: group ? HIDEABLE_TOOL_GROUPS[group - 1].id : null,
    category: category ? SUMMARY_CATEGORIES[category - 1] : null, thinking, bash };
}

export function classEligible(id: number, profile: DisplayProfile): boolean {
  const cls = postingClass(id);
  return (!cls.thinking || profile.showThinking) && (cls.group === null || !profile.hiddenToolGroups.includes(cls.group));
}
