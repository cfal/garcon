import { CarryOverGarbageCollector } from '../../carryover-garbage-collector.ts';

const collector = new CarryOverGarbageCollector({
  registry: { listAllChats: () => ({}) },
  journal: { roots: () => new Set() },
  store: {
    cleanupTemporary: async () => 0,
    sweep: async () => {
      process.stdout.write('sweep\n');
      return {
        reachableSegmentCount: 0,
        unreachableSegmentCount: 0,
        removedSegmentCount: 0,
        compressedBytes: 0,
        declaredUncompressedBytes: 0,
        durationMs: 0,
      };
    },
  },
});

collector.schedule();
process.stdout.write('scheduled\n');
