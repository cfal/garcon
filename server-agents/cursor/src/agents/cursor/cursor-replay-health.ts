export interface CursorReplaySample {
  loadedAt: string;
  replayUpdates: number;
  success: boolean;
}

export class CursorReplayHealth {
  #samples: CursorReplaySample[] = [];

  record(sample: CursorReplaySample): void {
    this.#samples.push(sample);
  }

  isHealthy(minSamples = 20, minSuccessRate = 0.98): boolean {
    if (this.#samples.length < minSamples) return false;
    const window = this.#samples.slice(-minSamples);
    const successCount = window.filter((sample) => sample.success).length;
    return successCount / window.length >= minSuccessRate;
  }
}
