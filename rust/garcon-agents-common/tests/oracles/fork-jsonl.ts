import { forkJsonlTranscript } from '../../../../server-agents/common/src/forking/fork-jsonl.ts';

const [sourcePath, targetPath, mode] = process.argv.slice(2);
if (mode === 'target-path-failure' || mode === 'unused-target-path') {
  const events: string[] = [];
  let outcome: unknown;
  try {
    outcome = await forkJsonlTranscript({
      sourcePath, sourceAgentSessionId: 'synthetic-source', cutoffLine: null,
      allowUnmaterializedWholeSession: true,
      createTargetPath() {
        events.push('target');
        throw new TypeError('Synthetic target path failure');
      },
      async transformEntries({ selectedEntries }) {
        events.push('transform');
        return { entries: selectedEntries };
      },
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    outcome = { error: { name: error.name, message: error.message } };
  }
  process.stdout.write(JSON.stringify({ events, outcome }));
  process.exit(0);
}

await forkJsonlTranscript({
  sourcePath, sourceAgentSessionId: 'synthetic-source',
  cutoffLine: mode === 'point' ? 3 : null,
  createTargetPath: () => targetPath,
  ...(mode === 'point' ? {
    retainedMessageCounts: new Map([[3, 2]]),
    rewriteEntry(entry, context) {
      return context.retainedMessageCount === 2 ? { ...entry as object, id: 20 } : entry;
    },
    async transformEntries({ selectedEntries }) {
      return { entries: selectedEntries };
    },
  } : {}),
});
