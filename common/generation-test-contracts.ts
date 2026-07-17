export const GENERATION_TEST_TARGETS = ['chatTitle', 'commitMessage'] as const;

export type GenerationTestTarget = typeof GENERATION_TEST_TARGETS[number];

export function isGenerationTestTarget(value: unknown): value is GenerationTestTarget {
  return typeof value === 'string'
    && GENERATION_TEST_TARGETS.some((target) => target === value);
}

export interface GenerationModelTestRequest {
  target: GenerationTestTarget;
}

export interface GenerationModelTestResponse {
  success: true;
  target: GenerationTestTarget;
  durationMs: number;
}
