import type { BodyDependencyRequest, BodyDependencyResponse, RowDetails } from '../../../common/transcript-display-contract.js';
import { decodeStoredLedgerRow, type StoredLedgerRow } from '../ledger/codec.js';
import { ledgerRowToMessage } from '../ledger/presentation.js';
import { DisplayStore } from './store.js';
import type { DisplayFeature } from './query.js';

export interface BodyReadPlan {
  readonly details: readonly RowDetails[];
  readonly ordinals: readonly number[];
  readonly deferredOrdinals: readonly number[];
  readonly nonRenderedOrdinals: readonly number[];
  readonly oversizedOrdinal: number | null;
}

export function planBodyRead(store: DisplayStore, request: BodyDependencyRequest): BodyReadPlan {
  const { watermark } = request.certificate;
  const features = new Map<number, DisplayFeature>();
  const getFeature = (ordinal: number) => {
    const feature = features.get(ordinal) ?? store.get<DisplayFeature>('SELECT * FROM feature WHERE ordinal = ? AND ordinal <= ?', ordinal, watermark);
    if (feature) features.set(ordinal, feature);
    return feature;
  };
  const closure = new Set<number>(), nonRenderedOrdinals: number[] = [], details: RowDetails[] = [];
  for (const ordinal of new Set(request.seedOrdinals)) {
    const feature = getFeature(ordinal);
    if (!feature?.message_type) { nonRenderedOrdinals.push(ordinal); continue; }
    const pair = store.get<{ use_ordinal: number; result_ordinal: number; wrapper_ordinal: number | null }>(
      'SELECT use_ordinal, result_ordinal, wrapper_ordinal FROM tool_pair WHERE use_ordinal = ? AND evidence_ordinal <= ?', ordinal, watermark)
      ?? store.get<{ use_ordinal: number; result_ordinal: number; wrapper_ordinal: number | null }>(
        'SELECT use_ordinal, result_ordinal, wrapper_ordinal FROM tool_pair WHERE result_ordinal = ? AND evidence_ordinal <= ?', ordinal, watermark);
    const wrapper = pair?.wrapper_ordinal ? getFeature(pair.wrapper_ordinal) : null;
    const occurrence = feature.permission_occurrence ?? wrapper?.permission_occurrence;
    const terminal = occurrence ? store.get<{ ordinal: number }>('SELECT ordinal FROM permission_terminal WHERE occurrence_id = ? AND ordinal <= ? ORDER BY ordinal DESC LIMIT 1', occurrence, watermark) : null;
    let commandFormat: RowDetails['commandFormat'] = null;
    if (feature.message_type === 'command-output') {
      const evidence = store.get<{ first_output_ordinal: number | null; stdout_count: number; result_count: number; last_result_ordinal: number | null; last_result_complete: number; last_gap_at_result: number }>(
        'SELECT * FROM command_evidence WHERE command_id = ? AND evidence_ordinal <= ? ORDER BY evidence_ordinal DESC LIMIT 1', feature.command_id, watermark);
      commandFormat = feature.command_markdown && evidence?.stdout_count === 1 && evidence.result_count === 1
        && evidence.last_result_complete && evidence.last_result_ordinal! > ordinal
        && evidence.last_gap_at_result < evidence.first_output_ordinal! ? 'markdown' : 'plain';
    }
    details.push({ ordinal, pairedUse: pair?.use_ordinal ?? null, pairedResult: pair?.result_ordinal ?? null,
      questionWrapper: pair?.wrapper_ordinal ?? null, permissionTerminal: terminal?.ordinal ?? null, commandFormat });
    for (const dependency of [ordinal, pair?.use_ordinal, pair?.result_ordinal, pair?.wrapper_ordinal, terminal?.ordinal]) {
      if (dependency && dependency <= watermark) closure.add(dependency);
    }
  }
  const resident = new Set(request.residentOrdinals), ordinals: number[] = [], deferredOrdinals: number[] = [];
  let bytes = 0, oversizedOrdinal: number | null = null;
  for (const ordinal of closure) {
    if (resident.has(ordinal)) continue;
    const feature = getFeature(ordinal);
    if (!feature?.message_type) { nonRenderedOrdinals.push(ordinal); continue; }
    if (ordinals.length >= request.limitBodies || (ordinals.length && bytes + feature.estimated_body_bytes > request.estimatedByteBudget)) {
      deferredOrdinals.push(ordinal); continue;
    }
    if (feature.estimated_body_bytes > request.estimatedByteBudget) oversizedOrdinal = ordinal;
    ordinals.push(ordinal); bytes += feature.estimated_body_bytes;
  }
  return { details, ordinals, deferredOrdinals, nonRenderedOrdinals, oversizedOrdinal };
}

export function hydrateBodyRead(request: BodyDependencyRequest, plan: BodyReadPlan, rows: readonly StoredLedgerRow[]): BodyDependencyResponse {
  const wanted = new Set(plan.ordinals);
  const bodies: BodyDependencyResponse['bodies'][number][] = [];
  for (const stored of rows) {
    if (stored.view_id !== request.certificate.transcriptViewId || !wanted.delete(stored.ordinal)) throw new TypeError('Invalid body frame identity');
    const row = decodeStoredLedgerRow(stored);
    const message = ledgerRowToMessage(row);
    if (!message) throw new TypeError('Private row in body plan');
    bodies.push({ ordinal: row.ordinal, message, submissionClientMessageId: row.kind === 'user-input' ? row.detail.clientMessageId : null });
  }
  if (wanted.size) throw new Error('Display body source is incomplete');
  return { certificate: request.certificate, details: plan.details, bodies, deferredOrdinals: plan.deferredOrdinals,
    nonRenderedOrdinals: plan.nonRenderedOrdinals, oversizedOrdinal: plan.oversizedOrdinal };
}
