import type { HiddenBashCommandPattern } from '../../../common/hidden-bash-command-patterns.js';
import type { AvailableDisplayWindow, BodyDependencyRequest, DisplayTargetResolution, DisplayWindowRequest,
  MemberWindowRequest, MemberWindowResponse } from '../../../common/transcript-display-contract.js';
import type { StoredLedgerRow } from '../ledger/codec.js';
import type { BodyReadPlan } from './details.js';
import type { DisplayManifest } from './store.js';
import type { DisplayAuxiliaryIdentity, DisplayAuxiliaryRequest, ResendSummaryPage, SubagentSummaryPage, UserRowPage } from '../../../common/transcript-display-auxiliary.js';

export type DisplayWorkerTask =
  | { kind: 'inspect'; path: string; chatId: string; viewId: string; serverInstanceId: string }
  | { kind: 'frame'; path: string; rows: readonly StoredLedgerRow[]; goal: number; serverInstanceId: string; previousTail?: StoredLedgerRow }
  | { kind: 'bash'; path: string; revision: string; patterns: readonly HiddenBashCommandPattern[]; goal: number }
  | { kind: 'filter-failed'; path: string; revision: string; retry: boolean }
  | { kind: 'prune'; path: string; revision: string }
  | { kind: 'auxiliary-frame'; path: string; goal: number }
  | { kind: 'user-rows'; path: string; request: DisplayAuxiliaryRequest; identity: DisplayAuxiliaryIdentity }
  | { kind: 'resend'; path: string; request: DisplayAuxiliaryRequest; identity: DisplayAuxiliaryIdentity }
  | { kind: 'subagents'; path: string; request: DisplayAuxiliaryRequest; identity: DisplayAuxiliaryIdentity }
  | { kind: 'close'; path: string }
  | { kind: 'window'; path: string; request: DisplayWindowRequest; watermark: number; sourceHead: number; bashFrontier: number; serverInstanceId: string; filteredBash: boolean }
  | { kind: 'members'; path: string; request: MemberWindowRequest; filteredBash: boolean }
  | { kind: 'resolve'; path: string; request: DisplayWindowRequest; watermark: number; sourceHead: number; ordinal: number; filteredBash: boolean }
  | { kind: 'body-plan'; path: string; request: BodyDependencyRequest }
  | { kind: 'present-plan'; rows: readonly StoredLedgerRow[]; identity: { serverInstanceId: string; chatId: string; transcriptViewId: string } }
  | { kind: 'hydrate'; request: BodyDependencyRequest; plan: BodyReadPlan; rows: readonly StoredLedgerRow[] };

export interface DisplayInspection {
  readonly manifest: DisplayManifest;
  readonly tailOrdinal: number | null;
  readonly auxiliaryFrontier: number;
  readonly auxiliaryBuilding: number;
  readonly auxiliaryCursor: number;
  readonly auxiliaryGeneration: number;
  readonly auxiliaryRelevantThrough: number;
  readonly revisions: readonly { revision: string; prepared_through: number; status: string; failure_code: string | null }[];
}
export interface DisplayWorkerResults {
  inspect: DisplayInspection;
  frame: { frontier: number; tailOrdinal: number | null };
  bash: number;
  'filter-failed': null;
  prune: boolean;
  'auxiliary-frame': number;
  'user-rows': UserRowPage;
  resend: ResendSummaryPage;
  subagents: SubagentSummaryPage;
  close: null;
  window: AvailableDisplayWindow;
  members: MemberWindowResponse;
  resolve: DisplayTargetResolution;
  'body-plan': BodyReadPlan;
  hydrate: string;
  'present-plan': string;
}
export interface DisplayWorkerRequest { readonly id: number; readonly task: DisplayWorkerTask }
export interface DisplayWorkerMetrics { readonly durationMs: number; readonly statements: number; readonly responseBytes: number }
export type DisplayWorkerReply = { readonly id: number; readonly ok: true; readonly result: unknown; readonly metrics?: DisplayWorkerMetrics }
  | { readonly id: number; readonly ok: false; readonly code: string };
