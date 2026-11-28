import { convertCodexCustomToolCall as convert } from '../../../../server-agents/codex/src/agents/codex/jsonl-tool-use-converter.ts';

export function convertCodexCustomToolCall(timestamp: string, payload: unknown) {
  return convert(timestamp, payload, input => ({
    file_path: '/fixture/file.js',
    old_string: input,
    new_string: 'synthetic update',
  }));
}
