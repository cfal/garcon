import { forkJsonlTranscript } from '../../../../server-agents/common/src/forking/fork-jsonl.ts';

const [sourcePath, targetPath, mode] = process.argv.slice(2);
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
