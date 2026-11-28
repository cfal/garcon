import { isRecord } from '../../../../common/json.ts';
import { carryOverRevision } from '../../../../server/controller/chats/carryover/segments.ts';
import { projectChatActivityStatus } from '../../../../server/controller/chats/chat-activity-status.ts';
import { classifyOrderGroup } from '../../../../server/controller/chats/chat-list-projector.ts';
import { resolveChatTitle } from '../../../../server/controller/chats/chat-title.ts';
import { parseCarryOverSegmentRefs } from '../../../../server/controller/chats/registry-entry-codec.ts';

export { carryOverRevision, projectChatActivityStatus, resolveChatTitle };

export function classify(chatId: string, groups: { pinned: string[]; normal: string[]; archived: string[] }) {
  return classifyOrderGroup(chatId, {
    pinned: new Set(groups.pinned), normal: new Set(groups.normal), archived: new Set(groups.archived),
  });
}

export function acceptsRefs(raw: unknown) {
  try { return Array.isArray(raw) && parseCarryOverSegmentRefs(raw).length === raw.length; }
  catch { return false; }
}

export function acceptsQuarantine(raw: unknown) {
  return raw == null || (isRecord(raw) && typeof raw.artifactId === 'string' && typeof raw.errorCode === 'string');
}

export function acceptsStatus(raw: unknown) {
  return isRecord(raw) && typeof raw.pendingUserAction === 'boolean'
    && [null, 'running', 'stopping', 'reconnecting'].includes(raw.processingPhase)
    && [null, 'finished', 'failed', 'interrupted'].includes(raw.lastRunOutcome);
}

export function acceptsNullableString(raw: unknown) { return raw == null || typeof raw === 'string'; }
export function acceptsString(raw: unknown) { return typeof raw === 'string'; }
export function acceptsGroups(raw: unknown) {
  return isRecord(raw) && [raw.pinned, raw.normal, raw.archived].every(group => Array.isArray(group) && group.every(acceptsString));
}
