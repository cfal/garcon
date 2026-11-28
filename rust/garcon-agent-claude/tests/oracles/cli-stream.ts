import {
  convertCLIMessageToChatMessages,
  type ClaudeCLIMessage,
} from '../../../../server-agents/claude/src/agents/claude/cli-protocol.ts';
import {
  getNativeMessageRevisionSource,
} from '../../../../server-agents/interface/src/native-message-source.ts';

export function convertCliStreamFrame(frame: ClaudeCLIMessage) {
  const actual = globalThis.Date;
  // The converter creates timestamps; all other behavior runs unchanged.
  globalThis.Date = new Proxy(actual, {
    construct(target, args, newTarget) {
      return Reflect.construct(
        target, args.length === 0 ? ['2026-01-01T00:00:00.000Z'] : args, newTarget,
      );
    },
  });
  try {
    return convertCLIMessageToChatMessages(frame).map((message) => ({
      message,
      source: getNativeMessageRevisionSource(message) ?? null,
    }));
  } finally {
    globalThis.Date = actual;
  }
}
