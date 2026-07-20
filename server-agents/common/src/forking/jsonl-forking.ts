import { promises as fs } from 'node:fs';
import type { ChatMessage } from '@garcon/common/chat-types';
import {
  AgentIntegrationError,
  getNativeMessageRevisionSource,
  orderedTranscriptDigest,
  type AgentForkRequest,
  type AgentForking,
  type AgentHost,
  type AgentStartedSession,
  type AgentTranscript,
} from '@garcon/server-agent-interface';
import type { PathNativeSessionCodec } from '../native-session/path-native-session.js';
import {
  forkJsonlTranscript,
  type ForkTranscriptEntryContext,
} from './fork-jsonl.js';

export interface JsonlForkingOptions {
  readonly host: Pick<AgentHost, 'carryOver'>;
  readonly supportsWhileRunning: boolean;
  readonly transcript: Pick<AgentTranscript, 'load' | 'revision' | 'resolveNativeSession'>;
  readonly nativeSessions: PathNativeSessionCodec;
  readonly rewriteEntry?: (
    entry: unknown,
    context: ForkTranscriptEntryContext,
  ) => unknown;
  readonly createRewriteEntry?: () => (
    entry: unknown,
    context: ForkTranscriptEntryContext,
  ) => unknown;
  readonly forkWholeSession?: (
    request: AgentForkRequest,
  ) => Promise<AgentStartedSession | null>;
}

export function createJsonlForking(options: JsonlForkingOptions): AgentForking {
  return {
    supportsAtMessage: true,
    supportsWhileRunning: options.supportsWhileRunning,
    async fork(request) {
      request.admission.signal.throwIfAborted();
      if (!request.point && options.forkWholeSession) {
        const result = await options.forkWholeSession(request);
        if (result) return result;
      }
      return forkJsonlAtPoint(options, request);
    },
  };
}

async function forkJsonlAtPoint(
  options: JsonlForkingOptions,
  request: AgentForkRequest,
): Promise<AgentStartedSession> {
  const resolvedReference = await resolveSourceReference(options, request);
  const sourceNative = options.nativeSessions.decode(resolvedReference);
  const sourceAgentSessionId = request.source.agentSessionId
    ?? sourceNative.agentSessionId;
  const sourcePath = sourceNative.path;
  if (!sourceAgentSessionId || !sourcePath) {
    throw new AgentIntegrationError(
      'TRANSCRIPT_UNAVAILABLE',
      'Source native transcript is unavailable',
      false,
    );
  }

  let cutoffLine: number | null = null;
  let leadingLineCount = 0;
  let retainedMessageCounts: ReadonlyMap<number, number> | undefined;
  let expectedForkDigest: string | null = null;
  if (request.point) {
    if (request.point.sourceRevision.carryOver !== request.source.carryOverRevision) {
      throw sourceRevisionChanged();
    }
    const carryOver = await options.host.carryOver.load({
      chatId: request.source.chatId,
      expectedRevision: request.point.sourceRevision.carryOver,
      currentAgentId: request.source.agentId,
      currentModel: request.source.model,
      signal: request.admission.signal,
    }).catch(() => {
      throw sourceRevisionChanged();
    });
    const native = await options.transcript.load({
      chat: request.source,
      signal: request.admission.signal,
    });
    if (native.revision !== request.point.sourceRevision.native) {
      throw sourceRevisionChanged();
    }
    const nativeSequence = Math.max(
      0,
      request.point.messageSequence - carryOver.messages.length,
    );
    if (nativeSequence > native.messages.length) {
      throw new AgentIntegrationError(
        'TRANSCRIPT_UNAVAILABLE',
        'Fork message is outside the source transcript',
        false,
      );
    }
    const sourceLines = native.messages
      .map((message) => getNativeMessageRevisionSource(message)?.lineNumber)
      .filter((line): line is number => line !== undefined);
    leadingLineCount = sourceLines.length > 0
      ? Math.max(0, Math.min(...sourceLines) - 1)
      : 0;
    const retainedMessages = native.messages.slice(0, nativeSequence);
    expectedForkDigest = forkTranscriptDigest(retainedMessages);
    const retainedCounts = new Map<number, number>();
    for (const message of retainedMessages) {
      const sourcePosition = getNativeMessageRevisionSource(message);
      if (!sourcePosition?.lineNumber) {
        throw new AgentIntegrationError(
          'TRANSCRIPT_UNAVAILABLE',
          'The selected transcript prefix has no provider-native fork position',
          false,
        );
      }
      retainedCounts.set(
        sourcePosition.lineNumber,
        (retainedCounts.get(sourcePosition.lineNumber) ?? 0) + 1,
      );
    }
    retainedMessageCounts = retainedCounts;
    cutoffLine = nativeSequence === 0 ? 0 : Math.max(...retainedCounts.keys());
  }

  const result = await forkJsonlTranscript({
    sourcePath,
    sourceAgentSessionId,
    cutoffLine,
    leadingLineCount,
    retainedMessageCounts,
    rewriteEntry: options.createRewriteEntry?.() ?? options.rewriteEntry,
  });
  const nativeSession = options.nativeSessions.encode({
    path: result.nativePath,
    agentSessionId: result.agentSessionId,
    modelEndpointId: request.endpoint?.endpointId ?? sourceNative.modelEndpointId,
  });

  if (request.point) {
    try {
      const current = await options.transcript.revision({
        chat: request.source,
        signal: request.admission.signal,
      });
      if (current !== request.point.sourceRevision.native) throw sourceRevisionChanged();
      const forked = await options.transcript.load({
        chat: {
          chatId: request.chatId,
          agentId: request.source.agentId,
          agentSessionId: result.agentSessionId,
          projectPath: request.projectPath,
          model: request.model,
          nativeSession,
          carryOverRevision: '',
          settings: request.settings,
        },
        signal: request.admission.signal,
      });
      if (forkTranscriptDigest(forked.messages) !== expectedForkDigest) {
        throw new AgentIntegrationError(
          'TRANSCRIPT_UNAVAILABLE',
          'The provider-native fork did not preserve the selected message prefix',
          false,
        );
      }
    } catch (error) {
      await fs.rm(result.nativePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return { agentSessionId: result.agentSessionId, nativeSession };
}

function forkTranscriptDigest(messages: readonly ChatMessage[]): string {
  return orderedTranscriptDigest(messages.map((message, index) => ({
    seq: index + 1,
    message,
  })));
}

async function resolveSourceReference(
  options: JsonlForkingOptions,
  request: AgentForkRequest,
) {
  const current = options.nativeSessions.decode(request.source.nativeSession);
  if (current.path) return request.source.nativeSession;
  return options.transcript.resolveNativeSession({
    chat: request.source,
    signal: request.admission.signal,
  });
}

function sourceRevisionChanged(): AgentIntegrationError {
  return new AgentIntegrationError(
    'SOURCE_REVISION_CHANGED',
    'Source transcript changed while the fork was being created',
    true,
  );
}
