export type DetachedTranscriptSource =
  | { kind: 'claude-jsonl'; nativePath: string }
  | { kind: 'codex-jsonl'; nativePath: string }
  | { kind: 'cursor-acp'; sessionId: string; projectPath: string }
  | { kind: 'direct-jsonl'; nativePath: string }
  | { kind: 'factory-jsonl'; nativePath: string }
  | { kind: 'opencode-api'; baseUrl: string; sessionId: string; directory: string }
  | { kind: 'pi-jsonl'; nativePath: string };

export interface CarryOverSearchDescriptor {
  filePath: string;
  chatRevision: number;
}

export interface TranscriptBuildSource {
  source: DetachedTranscriptSource;
  carryOver?: CarryOverSearchDescriptor;
  currentAgentId: string;
  currentModel: string;
}

export type SearchTranscriptLoadPlan =
  | {
      kind: 'detached';
      source: DetachedTranscriptSource;
      release?: () => void | Promise<void>;
    }
  | {
      kind: 'live-only';
      reasonCode: string;
    };

export interface SearchTranscriptLoadContext {
  chatId: string;
}
