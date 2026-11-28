import { assertAttachmentsSupported, type AttachmentAgentCapabilities } from '../../../../server/controller/attachments/support.ts';
import { CommandValidationError } from '../../../../server/controller/lib/command-validation-error.ts';

export function attachmentAdmissionTrace(scenario: string, fileData = 'data:text/csv;base64,YWJj') {
  const calls: unknown[] = [];
  const endpoint = scenario.startsWith('endpoint-');
  const executorId = endpoint || scenario === 'offline' ? 'remote-1' : null;
  const agents: AttachmentAgentCapabilities = {
    assertExecutorReady(id) {
      calls.push(['ready', id]);
      if (scenario === 'offline') throw new Error('Executor unavailable');
    },
    modelSupportsImages({ executorId, agentId, model, apiProviderId, modelEndpointId }) {
      calls.push(['model', executorId, agentId, model, apiProviderId, modelEndpointId]);
      if (scenario.endsWith('-lookup-fails')) throw new Error('endpoint unassigned');
      return scenario !== 'endpoint-unsupported';
    },
    supportsImages(agentId, id) {
      calls.push(['agent', agentId, id]);
      return scenario !== 'native-unsupported' && !endpoint;
    },
    fileAttachmentAdmission(agentId, file, id) {
      calls.push(['file', agentId, file.mimeType, file.sizeBytes, id]);
      return scenario === 'file-unsupported' ? { kind: 'unsupported-type' }
        : scenario === 'file-too-large' || scenario === 'file-too-large-unnamed' ? { kind: 'text-too-large', maxBytes: 120999 }
        : { kind: 'accepted' };
    },
  };
  const image = { data: 'data:image/png;base64,AAAA', name: 'screen.png', mimeType: ' IMAGE/PNG ' };
  const file = { data: fileData, mimeType: ' TEXT/CSV\u00a0', name: scenario === 'file-too-large-unnamed' ? undefined : 'table.csv' };
  const attachments = scenario === 'empty' ? [] : scenario === 'missing-mime' ? [image, { data: 'x' }]
    : scenario === 'mixed' ? [file, image] : scenario.startsWith('file-') ? [file] : [image];
  let error: unknown = null;
  try {
    assertAttachmentsSupported(agents, {
      executorId, agentId: 'synthetic', model: scenario === 'empty' || scenario === 'missing-model' ? null : 'model',
      apiProviderId: endpoint ? 'profile' : null, modelEndpointId: endpoint ? 'endpoint' : null, attachments,
    });
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    error = e instanceof CommandValidationError
      ? { name: e.name, message: e.message, code: e.code, status: e.status, retryable: e.retryable }
      : { name: e.name, message: e.message };
  }
  return { error, calls };
}
