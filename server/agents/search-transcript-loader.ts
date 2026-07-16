import type { ChatMessage } from '../../common/chat-types.js';
import type { DetachedTranscriptSource } from '../chats/search/source-types.js';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';

export interface SearchTranscriptLoadOptions {
  signal: AbortSignal;
  batchSize: number;
}

function hashDescriptor(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function probeDetachedSearchSource(
  source: DetachedTranscriptSource,
): Promise<string | null> {
  if (source.kind === 'cursor-acp') {
    const { probeCursorSearchTranscript } = await import('./cursor/search-transcript-source.js');
    return probeCursorSearchTranscript(source);
  }
  if (source.kind === 'opencode-api') {
    const { probeOpenCodeSearchTranscript } = await import('./opencode/search-transcript-source.js');
    return probeOpenCodeSearchTranscript(source);
  }
  const stat = await fs.stat(source.nativePath);
  return `${source.kind}:${hashDescriptor(source)}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

export async function* loadDetachedSearchMessageBatches(
  source: DetachedTranscriptSource,
  options: SearchTranscriptLoadOptions,
): AsyncGenerator<ChatMessage[]> {
  switch (source.kind) {
    case 'claude-jsonl': {
      const { loadClaudeSearchTranscript } = await import('./claude/search-transcript-source.js');
      yield* loadClaudeSearchTranscript(source, options);
      return;
    }
    case 'codex-jsonl': {
      const { loadCodexSearchTranscript } = await import('./codex/search-transcript-source.js');
      yield* loadCodexSearchTranscript(source, options);
      return;
    }
    case 'cursor-acp': {
      const { loadCursorSearchTranscript } = await import('./cursor/search-transcript-source.js');
      yield* loadCursorSearchTranscript(source, options);
      return;
    }
    case 'direct-jsonl': {
      const { loadDirectSearchTranscript } = await import('./direct/search-transcript-source.js');
      yield* loadDirectSearchTranscript(source, options);
      return;
    }
    case 'factory-jsonl': {
      const { loadFactorySearchTranscript } = await import('./factory/search-transcript-source.js');
      yield* loadFactorySearchTranscript(source, options);
      return;
    }
    case 'opencode-api': {
      const { loadOpenCodeSearchTranscript } = await import('./opencode/search-transcript-source.js');
      yield* loadOpenCodeSearchTranscript(source, options);
      return;
    }
    case 'pi-jsonl': {
      const { loadPiSearchTranscript } = await import('./pi/search-transcript-source.js');
      yield* loadPiSearchTranscript(source, options);
      return;
    }
  }
}
