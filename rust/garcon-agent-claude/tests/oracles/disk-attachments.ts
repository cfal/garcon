import { basename } from 'node:path';
import type { AgentAttachment } from '../../../../common/agent-execution.ts';
import { materializeClaudeDiskAttachments } from '../../../../server-agents/claude/src/agents/claude/disk-attachments.ts';

const [filename] = process.argv.slice(2);
const input = await Bun.file(filename).json() as { command: string; attachments: AgentAttachment[] };
const result = await materializeClaudeDiskAttachments(input.command, input.attachments);
try {
  let command = result.command;
  const files = await Promise.all(result.filePaths.map(async (path) => {
    const name = basename(path);
    command = command.replace(path, () => `<temp>/${name}`);
    return { name, content: await Bun.file(path).text() };
  }));
  process.stdout.write(JSON.stringify({
    command,
    inlineNames: result.inlineAttachments.map(({ name }) => name),
    files,
  }));
} finally {
  await result.cleanup();
}
