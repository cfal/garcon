import { expect, test } from 'bun:test';
import { parseExecutorProjectPreferencesPatch } from '../settings.js';

const EXECUTOR = '22222222-2222-4222-8222-222222222222';

test('executor path preference patches accept only explicit mutable fields', () => {
  for (const patch of [{ pinnedPaths: ['/project'] }, { defaultPath: '/project' }, { pinnedPaths: [] }, {}]) {
    expect(parseExecutorProjectPreferencesPatch({ [EXECUTOR]: patch })).toEqual({ [EXECUTOR]: patch });
  }
  for (const value of [null, [], { local: {} }, { invalid: {} }, { [EXECUTOR]: null }, { [EXECUTOR]: [] },
    { [EXECUTOR]: { recentPaths: [] } }, { [EXECUTOR]: { pinnedPaths: [1] } }, { [EXECUTOR]: { defaultPath: 1 } },
  ]) expect(parseExecutorProjectPreferencesPatch(value)).toBeNull();
});
