import type { DisplayAuxiliaryIdentity, DisplayAuxiliaryRequest, SubagentSummaryPage, UserRowPage, UserRowSummary } from '../../../common/transcript-display-auxiliary.js';
import { parseUserMessagePresentation } from '../../../common/user-message-presentation.js';
import type { SubagentReductionEntry } from '../../../common/subagent-management.js';
import { DisplayStore } from './store.js';

interface UserRecord { ordinal: number; preview: string; timestamp: string; attachment_count: number; presentation_json: string | null }
const userSummary = (row: UserRecord): UserRowSummary => ({ ordinal: row.ordinal, preview: row.preview, timestamp: row.timestamp,
  attachmentCount: row.attachment_count, presentation: row.presentation_json ? parseUserMessagePresentation(JSON.parse(row.presentation_json)) : undefined });

export function queryUserRows(store: DisplayStore, request: DisplayAuxiliaryRequest, identity: DisplayAuxiliaryIdentity): UserRowPage {
  store.requirePrepared(identity.watermark);
  const recall = request.mode === 'recall';
  const rows = store.all<UserRecord>(`SELECT * FROM user_navigation ${recall ? 'INDEXED BY user_recall' : ''}
    WHERE ordinal < ? ${recall ? 'AND nonblank = 1' : ''} ORDER BY ordinal DESC LIMIT ?`,
    Math.min(request.beforeOrdinal ?? identity.watermark + 1, identity.watermark + 1), request.limit + 1);
  return { ...identity, kind: 'available', rows: rows.slice(0, request.limit).map(userSummary),
    nextBeforeOrdinal: rows.length > request.limit ? rows[request.limit - 1].ordinal : null };
}

export function querySubagents(store: DisplayStore, request: DisplayAuxiliaryRequest, identity: DisplayAuxiliaryIdentity): SubagentSummaryPage {
  return store.db.transaction(() => {
  const control = store.get<{ published: number; generation: number }>('SELECT published, generation FROM auxiliary_control')!;
  if (identity.watermark < control.generation || identity.watermark > control.published) throw Object.assign(new Error('Subagent generation changed'), { code: 'DISPLAY_STALE_WATERMARK' });
  const rows = store.all<{ payload_json: string; created_order: number }>(`SELECT payload_json, created_order FROM auxiliary_entry
    WHERE generation = ? AND created_order > ? ORDER BY created_order LIMIT ?`, control.generation, request.afterOrder ?? 0, request.limit + 1);
  const entries = rows.slice(0, request.limit).map(row => {
    const entry = (JSON.parse(row.payload_json) as SubagentReductionEntry).entry;
    return { ...entry, name: entry.name.slice(0, 300), path: entry.path?.slice(0, 300), model: entry.model?.slice(0, 300), message: entry.message?.slice(0, 300) };
  });
  return { ...identity, kind: 'available', entries, nextAfterOrder: rows.length > request.limit ? rows[request.limit - 1].created_order : null } satisfies SubagentSummaryPage;
  })();
}
