import mime from 'mime-types';
import { win32 } from 'node:path';
import type { ExecutionFilesService } from '@garcon/server-agent-interface';
import { createEmptyAgentSettings } from '../../../common/agent-settings.js';
import type { AutomationSignal, AutomationSignalDecision, AutomationStartInput, AutomationResult } from '../../../common/automation.js';
import type { JsonValue } from '../../../common/json.js';
import type { WorkflowLocation } from '../../../common/workflow-runs.js';
import type { WorkflowAttachment } from '../../../common/workflow-definition.js';
import { ValidationDomainError, isDomainError } from '../../common/domain-error.js';
import type { AutomationExecutionPort } from '../automation/service.js';
import { MAX_ATTACHMENT_TOTAL_BYTES, validateCommandAttachments } from '../attachments/validation.js';
import type { WorkflowAttemptCallbacks, WorkflowAttemptRequest, WorkflowAttemptResult, WorkflowRunner } from './runner.js';

function emit(event: AutomationSignal, request: Extract<WorkflowAttemptRequest, {kind: 'agent'}>, callbacks: WorkflowAttemptCallbacks): AutomationSignalDecision {
  const candidate = event.candidate;
  if (candidate.kind === 'invalid') return { kind: 'rejected', message: candidate.reason };
  const prefix = request.stepId + '.';
  const name = candidate.name.startsWith(prefix) ? candidate.name.slice(prefix.length) : candidate.name;
  const definition = Object.hasOwn(request.signals, name) ? request.signals[name] : undefined;
  if (!definition) return { kind: 'rejected', message: `Step "${request.stepId}" does not declare signal "${candidate.name}".` };
  if (candidate.payload.contentType !== null && candidate.payload.contentType !== definition.payload) {
    return { kind: 'rejected', message: `Signal "${name}" expects ${definition.payload}.` };
  }
  let payload: JsonValue | undefined;
  if (definition.payload === 'json') {
    try { payload = JSON.parse(candidate.payload.text); }
    catch { return { kind: 'rejected', message: `Signal "${name}" requires valid JSON.` }; }
  } else if (definition.payload === 'text') payload = candidate.payload.text;
  else if (candidate.payload.text.trim()) return { kind: 'rejected', message: `Signal "${name}" takes no payload.` };
  try { callbacks.emit({ signal: name, ...(payload === undefined ? {} : { payload }) }); }
  catch (error) {
    // Storage and shutdown failures must poison successful closure, not masquerade as a rejected user value.
    if (isDomainError(error) && error.status < 500) return { kind: 'rejected', message: error.message };
    throw error;
  }
  return { kind: 'accepted' };
}

function terminal(result: AutomationResult, command: boolean): WorkflowAttemptResult {
  if (result.kind === 'unavailable') return { kind: 'unknown', reason: result.reason };
  if (result.kind === 'interrupted') return { kind: result.termination === 'requested' ? 'unknown' : 'failed', reason: 'The managed turn was interrupted.' };
  if (result.kind === 'failed') {
    const exit = result.commandOutcome;
    const unsuccessfulExit = exit && exit.outcome !== 'unknown'
      && (exit.signal !== null || (exit.exitCode !== null && exit.exitCode !== 0));
    // Shell can publish a failed receipt after losing the result of an already executed command.
    const uncertain = result.certainty === 'unknown'
      || (command && result.certainty !== 'not-started' && !unsuccessfulExit);
    return { kind: uncertain ? 'unknown' : 'failed', reason: result.detail };
  }
  if (command) {
    const evidence = result.commandOutcome;
    if (!evidence || evidence.outcome === 'unknown') return { kind: 'unknown', reason: 'No exact shell exit was confirmed.' };
    if (evidence.outcome !== 'finished' || evidence.exitCode !== 0 || evidence.signal !== null) {
      return { kind: 'failed', reason: `Shell did not exit successfully (exit ${evidence.exitCode}, signal ${evidence.signal}).` };
    }
  }
  return { kind: 'succeeded', output: result.completeText === null ? { kind: 'incomplete' } : { kind: 'complete', text: result.completeText } };
}

type Files = (executorId: string) => Promise<Pick<ExecutionFilesService, 'read'>>;

async function attachments(files: Files, location: WorkflowLocation, items: readonly WorkflowAttachment[] | undefined, signal: AbortSignal) {
  if (!items?.length) return undefined;
  const service = await files(location.executorId);
  const images = [];
  let total = 0;
  for (const item of items) {
    signal.throwIfAborted();
    const result = await service.read({ projectPath: location.projectPath, filePath: item.path }, { signal, timeoutMs: 30_000 });
    total += result.bytes.byteLength;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new ValidationDomainError('Workflow attachments exceed the combined upload limit.');
    const name = win32.basename(result.path), mimeType = mime.lookup(name) || 'application/octet-stream';
    images.push({ name, mimeType, data: `data:${mimeType};base64,${Buffer.from(result.bytes).toString('base64')}` });
  }
  return validateCommandAttachments(images);
}

function offline(code: string): boolean {
  return code === 'EXECUTOR_UNAVAILABLE' || code === 'EXECUTOR_RECONNECTING';
}

export function createWorkflowRunner(automation: AutomationExecutionPort, files: Files): WorkflowRunner {
  return {
    async run(request, callbacks) {
      const { executorId, projectPath } = request.location;
      let input: AutomationStartInput;
      try {
        if (request.kind === 'agent') {
          const { agentId, model, permissionMode, thinkingMode, agentSettings, orderedPreambleIds, apiProviderId,
            modelEndpointId, modelProtocol, providerRevision, tags } = request.settings;
          if (!agentId || !model || !permissionMode || !thinkingMode || !agentSettings) {
            throw new ValidationDomainError('Workflow agent execution settings are incomplete.');
          }
          input = { agentId, model, permissionMode, thinkingMode, agentSettings, apiProviderId, modelEndpointId, modelProtocol, providerRevision, orderedPreambleIds,
            tags: tags ? [...tags] : undefined, images: await attachments(files, request.location, request.settings.attachments, callbacks.signal),
            projectPath, executorId, clientRequestId: request.attemptId, command: request.prompt, title: request.stepId };
        } else {
          input = { agentId: 'shell', model: request.shell ?? 'sh', permissionMode: 'default', thinkingMode: 'none',
            agentSettings: createEmptyAgentSettings('shell'), projectPath, executorId, clientRequestId: request.attemptId,
            orderedPreambleIds: [], command: request.command, title: request.stepId };
        }
      } catch (error) {
        return { kind: isDomainError(error) && offline(error.code) ? 'unavailable' : 'failed', reason: error instanceof Error ? error.message : 'Could not prepare workflow input.' };
      }
      callbacks.signal.throwIfAborted();
      const prepared = await automation.prepare(input, request.kind === 'agent' && Object.keys(request.signals).length
        ? { onSignal: event => emit(event, request, callbacks) } : {});
      if (prepared.kind !== 'prepared') return { kind: offline(prepared.code) ? 'unavailable' : 'failed', reason: prepared.message };
      const { turn } = prepared;
      try {
        try {
          callbacks.signal.throwIfAborted();
          callbacks.attachChat(turn.key.chatId, turn.key.turnId);
        } catch (error) {
          await turn.cancel();
          throw error;
        }
        const started = await turn.start();
        switch (started.kind) {
          case 'unknown':
            return { kind: 'unknown', reason: started.reason };
          case 'not-started':
            if (started.inputPublished) {
              callbacks.confirmChat();
              return { kind: 'unknown', reason: started.code };
            }
            return { kind: offline(started.code) ? 'unavailable' : 'failed', reason: started.code };
          case 'published':
            callbacks.confirmChat();
            return terminal(await automation.waitForTerminal(turn.key, callbacks.signal), request.kind === 'command');
        }
      } finally {
        turn.release();
      }
    },
  };
}
