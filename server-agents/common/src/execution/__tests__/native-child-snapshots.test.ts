import { expect, test } from 'bun:test';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { NativeChildSnapshots } from '../native-child-snapshots.js';

test('unknown and evicted sources never become idle by absence', () => {
  const sources = new NativeChildSnapshots(() => {});
  expect(() => sources.capture('old-child')).toThrow('cannot be verified');
  sources.remember('old-child', 'root');
  for (let index = 0; index < 1024; index++) sources.remember(`child-${index}`, 'root');
  expect(() => sources.capture('old-child')).toThrow('cannot be verified');
  sources.capture('child-1023').release();
});

test('pending admissions and retiring writers fence reads before normal routing maps exist', () => {
  let retiring = false;
  const sources = new NativeChildSnapshots(() => {
    if (retiring) throw new AgentIntegrationError('SESSION_BUSY', 'Retiring', true);
  });
  sources.remember('child', 'root');
  const release = sources.admit('root');
  expect(() => sources.capture('child')).toThrow('running');
  release();
  release();
  retiring = true;
  expect(() => sources.capture('child')).toThrow('Retiring');
  retiring = false;
  sources.capture('child').release();
});

test('native work invalidates the read without delaying or failing parent execution', () => {
  const sources = new NativeChildSnapshots(() => {});
  sources.remember('child', 'root');
  const read = sources.capture('child');
  sources.activity('other-root');
  read.assertUnchanged();
  const releaseAdmission = sources.admit('root');
  releaseAdmission();
  expect(() => read.assertUnchanged()).toThrow('changed');
  read.release();
  sources.capture('child').release();
});
