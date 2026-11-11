import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const marker = 'apply(from = file("guard-tests.gradle.kts"))';

export function instrumentGradle(source) {
  if (!source.includes('id("com.android.application")') || !source.includes('namespace = "com.garconcloud.garcon"')) {
    throw new Error('Unexpected generated Android project; review the pinned Tauri template');
  }
  if (source.includes(marker)) return source;
  return `${source.trimEnd()}\n\n${marker}\n`;
}

export async function prepareAndroidTests(app = resolve(root, 'src-tauri/gen/android/app')) {
  const gradle = resolve(app, 'build.gradle.kts');
  const source = instrumentGradle(await readFile(gradle, 'utf8'));
  const tests = resolve(app, 'src/androidTest/java/com/garconcloud/garcon');
  await mkdir(tests, { recursive: true });
  await cp(resolve(root, 'android-tests/NavigationBoundaryTest.kt'), resolve(tests, 'NavigationBoundaryTest.kt'));
  await cp(resolve(root, 'android-tests/guard-tests.gradle.kts'), resolve(app, 'guard-tests.gradle.kts'));
  await writeFile(gradle, source);
}

if (import.meta.main) await prepareAndroidTests();
