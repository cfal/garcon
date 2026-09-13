import { AgentInstanceDirectory } from '../../server/agents/instance-directory.js';
import type { ProviderHistoryImportRequest } from '../../server/execution-nodes/provider-history-import.js';
import { parseNodeBulkFrameText } from '../../server/execution-nodes/transport/bulk-channel-wire.js';
import { createNodeSessionFixture } from './node-session-handshake-fixture.js';
import { createNodeHistoryRecord, recoverHistoryConnection, remoteHistoryImporter, type NodeHistoryFixture } from './node-history-fixture.js';
import { TlsCertificates } from './tls-certificates.js';

const mode = process.env.GARCON_TEST_REMOTE_HISTORY;
if (mode !== 'late-capacity' && mode !== 'corrupt-row' && mode !== 'lost-eof') throw new Error('Remote history fixture requires a fault mode');
const ordinary = AgentInstanceDirectory.prototype.nativeHistoryImportFor;
AgentInstanceDirectory.prototype.nativeHistoryImportFor = function (owner) {
  const local = ordinary.call(this, owner);
  if (!local || owner.agentId !== 'direct-openai-compatible') return local;
  return { read(request, signal) { return readRemote(structuredClone(request), signal); } };
};

async function* readRemote(request: ProviderHistoryImportRequest, caller: AbortSignal) {
  const certificates = await TlsCertificates.create();
  let fixture: NodeHistoryFixture | null = null;
  const cancellation = new AbortController();
  const signal = AbortSignal.any([caller, cancellation.signal]);
  let receivedRows = 0;
  try {
    const certificate = await certificates.selfSigned('remote-history-reload');
    fixture = await createNodeSessionFixture(certificate, certificate.trust, {
      instance: { agentId: request.chat.agentId, environment: {} },
      ...(mode === 'late-capacity' ? { historyTransportMemoryBytes: 32 * 1024 } : {}),
    });
    signal.throwIfAborted();
    const controller = await fixture.controller(await fixture.connect().ready);
    await recoverHistoryConnection(controller);
    const record = await createNodeHistoryRecord(fixture, { agentId: request.chat.agentId,
      sessionId: request.chat.agentSessionId!, content: 'Synthetic remote replacement input',
      response: mode === 'late-capacity' ? 'Synthetic remote response '.repeat(3000) : 'Synthetic remote replacement response' });
    fixture.controllerFrames.add((frame) => {
      if (mode !== 'lost-eof' || frame.type !== 'node-worker-service-result'
        || frame.result.kind !== 'provider-history-result' || frame.result.operation !== 'eof') return true;
      cancellation.abort(new Error('Synthetic remote EOF cancellation'));
      return false;
    });
    fixture.controllerBulkFrames.add((frame) => {
      if (mode !== 'corrupt-row' || frame.type !== 'node-history-bulk' || frame.sequence !== 2) return true;
      const payload = parseNodeBulkFrameText(frame.payload)!;
      if (payload.type !== 'node-bulk-credit-chunk') return true;
      const bytes = Buffer.from(payload.data, 'base64'); bytes[0] = bytes[0]! ^ 1;
      const corrupted = { ...frame, payload: JSON.stringify({ ...payload, data: bytes.toString('base64') }) };
      for (const listener of controller.bulkReceived) listener(corrupted);
      return false;
    });
    const service = await remoteHistoryImporter(fixture, controller, record.instanceId);
    try {
      for await (const batch of service.read({ chat: { ...request.chat, nativeSession: record.request.chat.nativeSession } }, signal)) {
        receivedRows += batch.length;
        yield batch;
      }
      throw new Error('Synthetic remote fault did not interrupt import');
    } catch (error) {
      if (receivedRows !== (mode === 'lost-eof' ? 2 : 1)) throw new Error('Synthetic remote fault reached the wrong row boundary', { cause: error });
      if (fixture.historyPool.reservedBytes !== 0) throw new Error('Synthetic remote history leaked transport memory', { cause: error });
      throw error;
    }
  } finally {
    try { await fixture?.dispose(); }
    finally { await certificates.dispose(); }
  }
}
