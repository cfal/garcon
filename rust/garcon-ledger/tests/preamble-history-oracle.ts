import { decodeLedgerRow } from '../../../server/controller/ledger/codec.ts';
import { transcriptViewId } from '../../../server/controller/ledger/contracts.ts';
import { collectPreambleHistoryEvidence, PreambleHistoryCollector, retainedPreambleHistoryMetadata } from '../../../server/controller/ledger/preamble-history.ts';
import type { JsonObject } from '../../../common/json.ts';

export function preambleHistoryFixture(
  specs: readonly (readonly [string, unknown, JsonObject?])[],
  before?: number,
) {
  const rows = specs.map(([kind, value, providerMeta], index) => decodeLedgerRow({
    kind, ordinal: index + 1, at: 'synthetic-time', view_id: transcriptViewId('evidence-view'),
    client_message_id: null, payload_json: JSON.stringify({ providerMeta: providerMeta ?? null, value }),
  }));
  const evidence = before === undefined ? collectPreambleHistoryEvidence(rows) : (() => {
    const collector = new PreambleHistoryCollector();
    for (const row of rows) collector.add([row]);
    return collector.finishBefore(before);
  })();
  return { evidence, metadata: retainedPreambleHistoryMetadata(evidence) };
}
