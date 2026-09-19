import { expect, test } from 'bun:test';
import { parseNodeProjectPreferencesPatch } from '../settings.js';

const NODE = '22222222-2222-4222-8222-222222222222';

test('node path preference patches accept only explicit mutable fields', () => {
  for (const patch of [{ pinnedPaths: ['/project'] }, { defaultPath: '/project' }, { pinnedPaths: [] }, {}]) {
    expect(parseNodeProjectPreferencesPatch({ [NODE]: patch })).toEqual({ [NODE]: patch });
  }
  for (const value of [null, [], { local: {} }, { invalid: {} }, { [NODE]: null }, { [NODE]: [] },
    { [NODE]: { recentPaths: [] } }, { [NODE]: { pinnedPaths: [1] } }, { [NODE]: { defaultPath: 1 } },
  ]) expect(parseNodeProjectPreferencesPatch(value)).toBeNull();
});
