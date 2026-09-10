import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { cgroupFilesystemPath, NativeCgroupReader, parseCgroupEvents } from '../systemd/cgroup.js';
import { identity, managerGroup } from './systemd-fixture.js';

function missing() { return Object.assign(new Error('Synthetic missing entry'), { code: 'ENOENT' }); }

function fixture() {
  let content = 'populated 0\nfrozen 0\n';
  let closed = 0;
  /** @satisfies {import('../systemd/cgroup.js').CgroupFileSystem} */
  const files = {
    ...fs,
    statfsSync: () => ({ ...fs.statfsSync(import.meta.dir), type: 0x63677270 }),
    realpathSync: (path) => path,
    openSync: (_path, flags) => { expect(flags & fs.constants.O_NOFOLLOW).not.toBe(0); return 17; },
    readSync: (_fd, bytes) => { bytes.write(content); return Buffer.byteLength(content); },
    lstatSync: () => fs.lstatSync(import.meta.path),
    closeSync: (fd) => { expect(fd).toBe(17); closed += 1; },
  };
  return { files, reader: new NativeCgroupReader(files), setContent(value) { content = value; }, closed: () => closed };
}

describe('systemd recursive cgroup evidence', () => {
  test('uses the manager-returned path without synthesizing a slice', () => {
    const group = `${managerGroup}/custom.slice/example.service`;
    expect(cgroupFilesystemPath(group, managerGroup)).toBe(`/sys/fs/cgroup${group}`);
  });

  test.each(['/', managerGroup, `${managerGroup}-other/service`, '/system.slice/other.service',
    `${managerGroup}/../other`, `${managerGroup}//other`, `${managerGroup}/other/`])('rejects unsafe group: %s', (group) => {
    expect(() => cgroupFilesystemPath(group, managerGroup)).toThrow();
  });

  test.each(['', 'frozen 0\n', 'populated 2\n', 'populated 0\npopulated 1\n', 'populated 0 \n',
    'populated -1\n', 'populated 0\ninvalid', 'populated 0\n\n'])('rejects uncertain population evidence: %j', (content) => {
    expect(() => parseCgroupEvents(content)).toThrow();
  });

  test('populated covers descendants and the events descriptor always closes', () => {
    const f = fixture();
    const group = f.reader.observe(identity.controlGroup, managerGroup);
    expect(group.isEmpty()).toBe(true);
    f.setContent('populated 1\nfrozen 0\n');
    expect(group.isEmpty()).toBe(false);
    f.setContent('invalid');
    expect(() => group.isEmpty()).toThrow();
    expect(f.closed()).toBe(3);
  });

  test('missing events is not disappearance while the directory still exists', () => {
    const f = fixture();
    f.files.openSync = () => { throw missing(); };
    const group = f.reader.observe(identity.controlGroup, managerGroup);
    expect(() => group.isEmpty()).toThrow();
    f.files.lstatSync = () => { throw missing(); };
    expect(group.isEmpty()).toBe(true);
    expect(f.closed()).toBe(0);
  });

  test('access denial is never empty evidence, even if another check would see a missing directory', () => {
    const f = fixture();
    f.files.openSync = () => { throw Object.assign(new Error('Synthetic denied'), { code: 'EACCES' }); };
    f.files.lstatSync = () => { throw missing(); };
    expect(() => f.reader.observe(identity.controlGroup, managerGroup).isEmpty()).toThrow('denied');
  });

  test('mount identity is verified again before accepting disappearance', () => {
    const f = fixture();
    const group = f.reader.observe(identity.controlGroup, managerGroup);
    f.files.statfsSync = () => ({ ...fs.statfsSync(import.meta.dir), type: 0 });
    expect(() => group.isEmpty()).toThrow();
    expect(() => f.reader.observe(identity.controlGroup, managerGroup)).toThrow();
  });
});
