interface RssProofOptions {
  readonly proofPath: string;
  readonly operations: readonly string[];
  readonly shapes: readonly string[];
  readonly ceilingBytes: number;
}

interface RssMeasurement {
  readonly operation: string;
  readonly shape: string;
  readonly rssBefore: number;
  readonly rssAfter: number;
  readonly hwmBefore: number;
  readonly hwmAfter: number;
}

export function runTranscriptSearchV8RssProof(options: RssProofOptions): {
  readonly ceilingBytes: number;
  readonly results: readonly (RssMeasurement & {
    readonly rssDelta: number;
    readonly hwmDelta: number;
  })[];
} {
  const results = [];
  for (const shape of options.shapes) {
    for (const operation of options.operations) {
      const child = Bun.spawnSync({
        cmd: [process.execPath, options.proofPath, '--rss-case', operation, shape],
        stdout: 'pipe',
        stderr: 'inherit',
      });
      if (child.exitCode !== 0) {
        throw new Error(`SEARCH_PROOF_RSS_CHILD:${shape}:${operation}:${child.exitCode}`);
      }
      const measurement = JSON.parse(child.stdout.toString()) as RssMeasurement;
      const rssDelta = Math.max(0, measurement.rssAfter - measurement.rssBefore);
      const hwmDelta = Math.max(0, measurement.hwmAfter - measurement.hwmBefore);
      if (rssDelta >= options.ceilingBytes || hwmDelta >= options.ceilingBytes) {
        throw new Error(`SEARCH_PROOF_RSS_BOUND:${shape}:${operation}:${rssDelta}:${hwmDelta}`);
      }
      results.push({ ...measurement, rssDelta, hwmDelta });
      console.error(`PASS ${shape} ${operation} rss=${rssDelta} hwm=${hwmDelta}`);
    }
  }
  return { ceilingBytes: options.ceilingBytes, results };
}
