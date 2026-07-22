import type { AgentLogger } from '@garcon/server-agent-interface';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';

type ProcessStream = ReturnType<typeof Bun.spawn>['stdout'];

interface StreamContext {
  stream: ProcessStream;
  logger: AgentLogger;
  sessionId: string;
  processId: number | null;
  isProcessKilled: () => boolean;
}

interface StdoutContext<Message> extends StreamContext {
  onMessage: (message: Message) => void;
}

interface ProcessOutputContext<Message> {
  process: ReturnType<typeof Bun.spawn>;
  logger: AgentLogger;
  sessionId: string;
  onMessage: (message: Message) => void;
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  }

  buffer += decoder.decode();
  onLine(buffer);
}

async function readClaudeStdout<Message>(context: StdoutContext<Message>): Promise<void> {
  if (!context.stream || typeof context.stream === 'number') return;

  try {
    await readLines(context.stream, line => {
      if (!line.trim()) return;
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        context.logger.warn('Claude CLI emitted invalid JSON', {
          sessionId: context.sessionId.slice(0, 8),
          processId: context.processId,
        });
        return;
      }
      context.onMessage(message);
    });
  } catch (error) {
    if (!context.isProcessKilled()) {
      context.logger.error('Claude CLI stdout read failed', {
        sessionId: context.sessionId.slice(0, 8),
        processId: context.processId,
        error: errorMessage(error),
      });
    }
  }
}

async function readClaudeStderr(context: StreamContext): Promise<void> {
  if (!context.stream || typeof context.stream === 'number') return;

  try {
    await readLines(context.stream, line => {
      if (!line.trim()) return;
      context.logger.info('Claude CLI stderr', {
        sessionId: context.sessionId.slice(0, 8),
        processId: context.processId,
        line,
      });
    });
  } catch (error) {
    if (!context.isProcessKilled()) {
      context.logger.warn('Claude CLI stderr read failed', {
        sessionId: context.sessionId.slice(0, 8),
        processId: context.processId,
        error: errorMessage(error),
      });
    }
  }
}

export function pipeClaudeProcessOutput<Message>(context: ProcessOutputContext<Message>): void {
  const streamContext = {
    logger: context.logger,
    sessionId: context.sessionId,
    processId: context.process.pid ?? null,
    isProcessKilled: () => context.process.killed,
  };
  void readClaudeStdout({
    ...streamContext,
    stream: context.process.stdout,
    onMessage: context.onMessage,
  });
  void readClaudeStderr({ ...streamContext, stream: context.process.stderr });
}
