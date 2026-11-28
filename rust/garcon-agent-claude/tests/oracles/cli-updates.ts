import { readClaudeReleaseChannel } from '../../../../server-agents/claude/src/agents/claude/cli-updates.ts';

const [home, managed] = process.argv.slice(2);
process.stdout.write(await readClaudeReleaseChannel({ configHomeDir: () => home }, managed));
