import { resolveClaudeNativePath } from '../../../../server-agents/claude/src/agents/claude/native-path.ts';

const [projectPath, configHomeDir, nativePath] = process.argv.slice(2);
const resolved = await resolveClaudeNativePath({ projectPath, agentSessionId: 'session-1', nativePath }, { configHomeDir });
process.stdout.write(JSON.stringify(resolved));
