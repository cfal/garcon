export interface WebBuildCheckOptions {
  buildDir?: string;
  environment?: Record<string, string | undefined>;
  inputs?: readonly string[];
  markerPath?: string;
  sourcePath?: string;
}

export interface WebBuildRecordOptions {
  buildDir?: string;
  environment?: Record<string, string | undefined>;
  hash?: string;
  inputs?: readonly string[];
  markerPath?: string;
}

export const repoRoot: string;
export const webBuildDir: string;
export const webBuildMarker: string;
export const webBuildInputs: readonly string[];

export function productionWebBuildEnvironment(
  environment?: Record<string, string | undefined>,
): Record<string, string | undefined>;

export function computeWebBuildHash(
  inputs?: readonly string[],
  environment?: Record<string, string | undefined>,
  ignoredPaths?: ReadonlySet<string>,
): Promise<string>;

export function isWebBuildCurrent(options?: WebBuildCheckOptions): Promise<boolean>;
export function recordWebBuild(options?: WebBuildRecordOptions): Promise<void>;
export function assertWebBuildCurrent(options?: WebBuildCheckOptions): Promise<void>;
export function assertWebBuildInputsUnchanged(expectedHash: string, actualHash: string): void;
