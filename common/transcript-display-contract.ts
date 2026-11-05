import { isChatMessageType, parseChatMessage, type ChatMessage } from './chat-types.js';
import { isRecord } from './json.js';
import { HIDEABLE_TOOL_GROUPS, SUMMARY_CATEGORIES, type HiddenToolGroup, type SummaryCategory } from './transcript-display-policy.js';

export const DISPLAY_PAGE_LIMIT = 200;
export const DISPLAY_BODY_LIMIT = 200;
export const DISPLAY_BYTE_BUDGET = 2 * 1024 * 1024;
export interface DisplayProfile {
  readonly combine: boolean;
  readonly showThinking: boolean;
  readonly hiddenToolGroups: readonly HiddenToolGroup[];
  readonly bashRevision: string;
}
export interface CanonicalAddress { readonly chatId: string; readonly transcriptViewId: string; readonly ordinal: number }
export interface DisplayCertificate {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly policyRevision: number;
  readonly profileKey: string;
  readonly bashRevision: string;
  readonly watermark: number;
  readonly cutsKey: string;
}
export interface DisplayCut {
  readonly id: string;
  readonly afterOrdinal: number;
  readonly anchorRule: 'eligible-row' | 'raw-position';
}
export interface GroupExtent {
  readonly afterBreaker: number;
  readonly beforeBreaker: number;
  readonly firstMember: number;
  readonly lastMember: number;
  readonly openAtWatermark: boolean;
}
export interface GroupDescriptor {
  readonly kind: 'tool-group';
  readonly base: GroupExtent;
  readonly fragment: { readonly after: number; readonly through: number };
  readonly firstMember: number;
  readonly lastMember: number;
  readonly count: number;
  readonly totals: Readonly<Record<SummaryCategory, number>>;
  readonly categoryOrder: readonly SummaryCategory[];
}
export interface RowDescriptor {
  readonly kind: 'row';
  readonly ordinal: number;
  readonly messageType: ChatMessage['type'];
  readonly layout: 'standard' | 'permission';
  readonly estimatedBodyBytes: number;
  readonly permissionOccurrenceId: string | null;
}
export type DisplayDescriptor = RowDescriptor | GroupDescriptor;
export interface DisplayCursor { readonly certificate: DisplayCertificate; readonly boundaryOrdinal: number }
export type WindowAnchor = { readonly kind: 'newest' }
  | { readonly kind: 'before' | 'after'; readonly cursor: DisplayCursor }
  | { readonly kind: 'around'; readonly ordinal: number };
export interface DisplayWindowRequest {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly policyRevision: number;
  readonly profile: DisplayProfile;
  readonly anchor: WindowAnchor;
  readonly cuts: readonly DisplayCut[];
  readonly limit: number;
  readonly atWatermark?: number;
  readonly requiredThrough?: number;
}
export type DisplayEdge = { readonly kind: 'more'; readonly cursor: DisplayCursor }
  | { readonly kind: 'exhausted-through-watermark' };
export interface PublicTailEvidence {
  readonly ordinal: number;
  readonly contentDigest: string | null;
  readonly combinedDigest: string | null;
}
export interface AvailableDisplayWindow {
  readonly kind: 'available';
  readonly certificate: DisplayCertificate;
  readonly sourceHead: number;
  readonly structuralPreparedThrough: number;
  readonly bashPreparedThrough: number;
  readonly interval: { readonly after: number; readonly through: number };
  readonly items: readonly DisplayDescriptor[];
  readonly earlier: DisplayEdge;
  readonly later: DisplayEdge;
  readonly cutPlacements: readonly { readonly id: string; readonly placement: 'inline' | 'detached' }[];
  readonly publicTail: PublicTailEvidence | null;
}
export interface DisplayUnavailable {
  readonly kind: 'preparing' | 'lagging' | 'failed' | 'busy';
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly policyRevision: number;
  readonly profileKey: string;
  readonly bashRevision: string;
  readonly sourceHead: number;
  readonly preparedThrough: number;
  readonly errorCode: string | null;
  readonly retryAfterMs: number | null;
}
export type DisplayWindowResponse = AvailableDisplayWindow | DisplayUnavailable;
export interface CertifiedDisplayRequest {
  readonly certificate: DisplayCertificate;
  readonly profile: DisplayProfile;
  readonly cuts: readonly DisplayCut[];
}
export interface MemberWindowRequest extends CertifiedDisplayRequest {
  readonly base: GroupExtent;
  readonly fragment: { readonly after: number; readonly through: number };
  readonly anchor: { readonly kind: 'first' } | { readonly kind: 'before' | 'after' | 'around'; readonly ordinal: number };
  readonly limit: number;
}
export interface MemberWindowResponse {
  readonly certificate: DisplayCertificate;
  readonly base: GroupExtent;
  readonly fragment: { readonly after: number; readonly through: number };
  readonly ordinals: readonly number[];
  readonly earlier: { readonly beforeOrdinal: number; readonly remaining: number } | null;
  readonly later: { readonly afterOrdinal: number; readonly remaining: number } | null;
}
export interface BodyDependencyRequest extends CertifiedDisplayRequest {
  readonly seedOrdinals: readonly number[];
  readonly residentOrdinals: readonly number[];
  readonly limitBodies: number;
  readonly estimatedByteBudget: number;
}
export interface RowDetails {
  readonly ordinal: number;
  readonly pairedUse: number | null;
  readonly pairedResult: number | null;
  readonly questionWrapper: number | null;
  readonly permissionTerminal: number | null;
  readonly commandFormat: 'plain' | 'markdown' | null;
}
export interface DisplayBody {
  readonly ordinal: number;
  readonly message: ChatMessage;
  readonly submissionClientMessageId: string | null;
}
export interface BodyDependencyResponse {
  readonly certificate: DisplayCertificate;
  readonly details: readonly RowDetails[];
  readonly bodies: readonly DisplayBody[];
  readonly deferredOrdinals: readonly number[];
  readonly nonRenderedOrdinals: readonly number[];
  readonly oversizedOrdinal: number | null;
}
export interface DisplayTargetResolution {
  readonly kind: 'visible-row' | 'group-member' | 'attached-detail' | 'filtered' | 'non-rendered' | 'preparing' | 'missing';
  readonly ordinal: number;
  readonly landedOrdinal: number | null;
}

export function displayProfileKey(profile: DisplayProfile): string {
  return JSON.stringify([profile.combine, profile.showThinking, [...profile.hiddenToolGroups].sort(), profile.bashRevision]);
}
export function displayCutsKey(cuts: readonly DisplayCut[]): string {
  return JSON.stringify([...cuts].sort((a, b) => a.afterOrdinal - b.afterOrdinal || a.id.localeCompare(b.id))
    .map(cut => [cut.id, cut.afterOrdinal, cut.anchorRule]));
}

export function displayRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('Expected a display object');
  return value;
}
export function displayInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER - 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new TypeError('Invalid display integer');
  return value;
}
export function displayString(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new TypeError('Invalid display string');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Invalid display boolean');
  return value;
}
export function displayArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new TypeError('Invalid display array');
  return value;
}
export function parseDisplayProfile(value: unknown): DisplayProfile {
  const raw = displayRecord(value);
  const hiddenToolGroups = displayArray(raw.hiddenToolGroups, 7).map(value => {
    const group = HIDEABLE_TOOL_GROUPS.find(group => group.id === value);
    if (!group) throw new TypeError('Unknown display tool group');
    return group.id;
  });
  if (new Set(hiddenToolGroups).size !== hiddenToolGroups.length) throw new TypeError('Duplicate display group');
  return { combine: boolean(raw.combine), showThinking: boolean(raw.showThinking), hiddenToolGroups,
    bashRevision: displayString(raw.bashRevision) };
}
export function parseDisplayCuts(value: unknown): DisplayCut[] {
  const cuts = displayArray(value, 32).map(value => {
    const raw = displayRecord(value);
    if (raw.anchorRule !== 'eligible-row' && raw.anchorRule !== 'raw-position') throw new TypeError('Invalid cut rule');
    return { id: displayString(raw.id, 256), afterOrdinal: displayInteger(raw.afterOrdinal), anchorRule: raw.anchorRule } satisfies DisplayCut;
  });
  if (new Set(cuts.map(cut => cut.id)).size !== cuts.length) throw new TypeError('Duplicate display cut');
  return cuts;
}
export function parseDisplayCertificate(value: unknown): DisplayCertificate {
  const raw = displayRecord(value);
  return { serverInstanceId: displayString(raw.serverInstanceId), chatId: displayString(raw.chatId, 128),
    transcriptViewId: displayString(raw.transcriptViewId, 256), policyRevision: displayInteger(raw.policyRevision, 1),
    profileKey: displayString(raw.profileKey, 8192), bashRevision: displayString(raw.bashRevision),
    watermark: displayInteger(raw.watermark), cutsKey: displayString(raw.cutsKey, 16384) };
}
export function parseCertifiedDisplayRequest(value: unknown): CertifiedDisplayRequest {
  const raw = displayRecord(value);
  const certificate = parseDisplayCertificate(raw.certificate), profile = parseDisplayProfile(raw.profile), cuts = parseDisplayCuts(raw.cuts);
  if (certificate.profileKey !== displayProfileKey(profile) || certificate.cutsKey !== displayCutsKey(cuts)
    || certificate.bashRevision !== profile.bashRevision) throw new TypeError('Mismatched display certificate');
  return { certificate, profile, cuts };
}
export function parseDisplayWindowRequest(value: unknown): DisplayWindowRequest {
  const raw = displayRecord(value), anchor = displayRecord(raw.anchor);
  let parsedAnchor: WindowAnchor;
  if (anchor.kind === 'newest') parsedAnchor = { kind: 'newest' };
  else if (anchor.kind === 'around') parsedAnchor = { kind: 'around', ordinal: displayInteger(anchor.ordinal, 1) };
  else if (anchor.kind === 'before' || anchor.kind === 'after') {
    const cursor = displayRecord(anchor.cursor);
    parsedAnchor = { kind: anchor.kind, cursor: { certificate: parseDisplayCertificate(cursor.certificate), boundaryOrdinal: displayInteger(cursor.boundaryOrdinal, anchor.kind === 'before' ? 1 : 0) } };
  } else throw new TypeError('Invalid display anchor');
  const request: DisplayWindowRequest = { chatId: displayString(raw.chatId, 128), transcriptViewId: displayString(raw.transcriptViewId, 256),
    policyRevision: displayInteger(raw.policyRevision, 1), profile: parseDisplayProfile(raw.profile), cuts: parseDisplayCuts(raw.cuts),
    anchor: parsedAnchor, limit: displayInteger(raw.limit, 1, DISPLAY_PAGE_LIMIT),
    ...(raw.atWatermark === undefined ? {} : { atWatermark: displayInteger(raw.atWatermark) }),
    ...(raw.requiredThrough === undefined ? {} : { requiredThrough: displayInteger(raw.requiredThrough) }) };
  if (parsedAnchor.kind === 'before' || parsedAnchor.kind === 'after') {
    const cert = parsedAnchor.cursor.certificate;
    parseCertifiedDisplayRequest({ certificate: cert, profile: request.profile, cuts: request.cuts });
    if (cert.chatId !== request.chatId || cert.transcriptViewId !== request.transcriptViewId || cert.policyRevision !== request.policyRevision
      || (request.atWatermark !== undefined && request.atWatermark !== cert.watermark)
      || parsedAnchor.cursor.boundaryOrdinal > cert.watermark + 1) throw new TypeError('Foreign display cursor');
  }
  return request;
}
export function parseGroupExtent(value: unknown): GroupExtent {
  const raw = displayRecord(value);
  const extent = { afterBreaker: displayInteger(raw.afterBreaker), beforeBreaker: displayInteger(raw.beforeBreaker, 1),
    firstMember: displayInteger(raw.firstMember, 1), lastMember: displayInteger(raw.lastMember, 1), openAtWatermark: boolean(raw.openAtWatermark) };
  if (!(extent.afterBreaker < extent.firstMember && extent.firstMember <= extent.lastMember && extent.lastMember < extent.beforeBreaker)) throw new TypeError('Invalid group extent');
  return extent;
}
function parseFragment(value: unknown): { after: number; through: number } {
  const raw = displayRecord(value), after = displayInteger(raw.after), through = displayInteger(raw.through);
  if (through < after) throw new TypeError('Invalid display interval');
  return { after, through };
}
export function parseMemberWindowRequest(value: unknown): MemberWindowRequest {
  const raw = displayRecord(value), anchor = displayRecord(raw.anchor);
  let parsedAnchor: MemberWindowRequest['anchor'];
  if (anchor.kind === 'first') parsedAnchor = { kind: 'first' };
  else if (anchor.kind === 'before' || anchor.kind === 'after' || anchor.kind === 'around') parsedAnchor = { kind: anchor.kind, ordinal: displayInteger(anchor.ordinal, 1) };
  else throw new TypeError('Invalid member anchor');
  const request = { ...parseCertifiedDisplayRequest(raw), base: parseGroupExtent(raw.base), fragment: parseFragment(raw.fragment),
    anchor: parsedAnchor, limit: displayInteger(raw.limit, 1, DISPLAY_PAGE_LIMIT) };
  validateExtent(request.base, request.fragment, request.certificate.watermark);
  if (!request.profile.combine || (parsedAnchor.kind !== 'first'
    && (parsedAnchor.ordinal <= request.fragment.after || parsedAnchor.ordinal > request.fragment.through))) throw new TypeError('Invalid member window');
  return request;
}
export function parseBodyDependencyRequest(value: unknown): BodyDependencyRequest {
  const raw = displayRecord(value), certified = parseCertifiedDisplayRequest(raw);
  const ordinals = (value: unknown, max: number) => displayArray(value, max).map(ordinal => displayInteger(ordinal, 1, certified.certificate.watermark));
  return { ...certified, seedOrdinals: ordinals(raw.seedOrdinals, 50), residentOrdinals: ordinals(raw.residentOrdinals, 2000),
    limitBodies: displayInteger(raw.limitBodies, 1, DISPLAY_BODY_LIMIT), estimatedByteBudget: displayInteger(raw.estimatedByteBudget, 1, DISPLAY_BYTE_BUDGET) };
}

export function parseDisplayBody(value: unknown): DisplayBody {
  const raw = displayRecord(value), message = parseChatMessage(displayRecord(raw.message));
  if (!message) throw new TypeError('Invalid display body');
  return { ordinal: displayInteger(raw.ordinal, 1), message,
    submissionClientMessageId: raw.submissionClientMessageId === null ? null : displayString(raw.submissionClientMessageId) };
}
export function parseDisplayDescriptor(value: unknown): DisplayDescriptor {
  const raw = displayRecord(value);
  if (raw.kind === 'tool-group') {
    const totals = displayRecord(raw.totals);
    const parsedTotals = Object.fromEntries(SUMMARY_CATEGORIES.map(category => [category, displayInteger(totals[category])])) as Record<SummaryCategory, number>;
    const categoryOrder = displayArray(raw.categoryOrder, 4).map(value => {
      const category = SUMMARY_CATEGORIES.find(category => category === value);
      if (!category || parsedTotals[category] === 0) throw new TypeError('Invalid summary category');
      return category;
    });
    if (new Set(categoryOrder).size !== categoryOrder.length || SUMMARY_CATEGORIES.filter(category => parsedTotals[category] > 0).length !== categoryOrder.length) throw new TypeError('Invalid summary order');
    const group: GroupDescriptor = { kind: 'tool-group', base: parseGroupExtent(raw.base), fragment: parseFragment(raw.fragment),
      firstMember: displayInteger(raw.firstMember, 1), lastMember: displayInteger(raw.lastMember, 1), count: displayInteger(raw.count, 1),
      totals: parsedTotals, categoryOrder };
    if (!(group.fragment.after < group.firstMember && group.firstMember <= group.lastMember && group.lastMember <= group.fragment.through
      && group.fragment.after >= group.base.afterBreaker && group.fragment.through < group.base.beforeBreaker)
      || group.count > group.lastMember - group.firstMember + 1
      || !Number.isSafeInteger(Object.values(parsedTotals).reduce((a, b) => a + b, 0))) throw new TypeError('Invalid summary bounds');
    return group;
  }
  if (raw.kind !== 'row' || (raw.layout !== 'standard' && raw.layout !== 'permission') || !isChatMessageType(raw.messageType)
    || (raw.layout === 'permission' && raw.messageType !== 'permission-request'
      && raw.messageType !== 'exit-plan-mode-tool-use' && raw.messageType !== 'tool-result')) throw new TypeError('Invalid display row');
  return { kind: 'row', ordinal: displayInteger(raw.ordinal, 1), messageType: raw.messageType,
    layout: raw.layout, estimatedBodyBytes: displayInteger(raw.estimatedBodyBytes),
    permissionOccurrenceId: raw.permissionOccurrenceId === null ? null : displayString(raw.permissionOccurrenceId) };
}

function validateExtent(base: GroupExtent, fragment: { after: number; through: number }, watermark: number): void {
  if (base.beforeBreaker > watermark + 1 || base.openAtWatermark !== (base.beforeBreaker === watermark + 1)
    || fragment.after < base.afterBreaker || fragment.through >= base.beforeBreaker || fragment.after >= fragment.through) {
    throw new TypeError('Invalid certified group extent');
  }
}

export function sameDisplayCertificate(left: DisplayCertificate, right: DisplayCertificate): boolean {
  return left.serverInstanceId === right.serverInstanceId && left.chatId === right.chatId
    && left.transcriptViewId === right.transcriptViewId && left.policyRevision === right.policyRevision
    && left.profileKey === right.profileKey && left.bashRevision === right.bashRevision
    && left.watermark === right.watermark && left.cutsKey === right.cutsKey;
}

function parseEdge(value: unknown, certificate: DisplayCertificate): DisplayEdge {
  const raw = displayRecord(value);
  if (raw.kind === 'exhausted-through-watermark') return { kind: raw.kind };
  if (raw.kind !== 'more') throw new TypeError('Invalid display edge');
  const cursor = displayRecord(raw.cursor), parsed = parseDisplayCertificate(cursor.certificate);
  if (!sameDisplayCertificate(certificate, parsed)) throw new TypeError('Foreign display continuation');
  return { kind: 'more', cursor: { certificate: parsed, boundaryOrdinal: displayInteger(cursor.boundaryOrdinal, 0, certificate.watermark + 1) } };
}

export function parseDisplayWindowResponse(value: unknown): DisplayWindowResponse {
  const raw = displayRecord(value);
  if (raw.kind !== 'available') {
    if (raw.kind !== 'preparing' && raw.kind !== 'lagging' && raw.kind !== 'failed' && raw.kind !== 'busy') throw new TypeError('Invalid display status');
    return { kind: raw.kind, serverInstanceId: displayString(raw.serverInstanceId), chatId: displayString(raw.chatId, 128),
      transcriptViewId: displayString(raw.transcriptViewId, 256), policyRevision: displayInteger(raw.policyRevision, 1),
      profileKey: displayString(raw.profileKey, 8192), bashRevision: displayString(raw.bashRevision), sourceHead: displayInteger(raw.sourceHead),
      preparedThrough: displayInteger(raw.preparedThrough, 0, displayInteger(raw.sourceHead)),
      errorCode: raw.errorCode === null ? null : displayString(raw.errorCode, 128),
      retryAfterMs: raw.retryAfterMs === null ? null : displayInteger(raw.retryAfterMs, 1, 60000) };
  }
  const certificate = parseDisplayCertificate(raw.certificate), W = certificate.watermark;
  const sourceHead = displayInteger(raw.sourceHead, W), structuralPreparedThrough = displayInteger(raw.structuralPreparedThrough, W, sourceHead);
  const bashPreparedThrough = displayInteger(raw.bashPreparedThrough, W, structuralPreparedThrough);
  const interval = parseFragment(raw.interval);
  if (interval.through > W) throw new TypeError('Window exceeds watermark');
  const items = displayArray(raw.items, DISPLAY_PAGE_LIMIT).map(parseDisplayDescriptor);
  let previous = interval.after;
  for (const item of items) {
    const first = item.kind === 'row' ? item.ordinal : item.firstMember, last = item.kind === 'row' ? item.ordinal : item.lastMember;
    if (first <= previous || last > interval.through) throw new TypeError('Invalid descriptor order');
    previous = last;
    if (item.kind === 'tool-group') {
      validateExtent(item.base, item.fragment, W);
      if (item.firstMember < item.base.firstMember || item.lastMember > item.base.lastMember) throw new TypeError('Invalid group members');
    }
  }
  const earlier = parseEdge(raw.earlier, certificate), later = parseEdge(raw.later, certificate);
  if ((earlier.kind === 'more' && earlier.cursor.boundaryOrdinal !== interval.after + 1)
    || (later.kind === 'more' && later.cursor.boundaryOrdinal !== interval.through)) throw new TypeError('Invalid edge boundary');
  const cutPlacements = displayArray(raw.cutPlacements, 32).map(value => {
    const cut = displayRecord(value);
    if (cut.placement !== 'inline' && cut.placement !== 'detached') throw new TypeError('Invalid cut placement');
    return { id: displayString(cut.id, 256), placement: cut.placement } satisfies AvailableDisplayWindow['cutPlacements'][number];
  });
  if (new Set(cutPlacements.map(cut => cut.id)).size !== cutPlacements.length) throw new TypeError('Duplicate cut placement');
  let publicTail: PublicTailEvidence | null = null;
  if (raw.publicTail !== null) {
    const tail = displayRecord(raw.publicTail);
    publicTail = { ordinal: displayInteger(tail.ordinal, 1, W), contentDigest: tail.contentDigest === null ? null : displayString(tail.contentDigest, 64),
      combinedDigest: tail.combinedDigest === null ? null : displayString(tail.combinedDigest, 64) };
  }
  return { kind: 'available', certificate, sourceHead, structuralPreparedThrough, bashPreparedThrough, interval, items, earlier, later, cutPlacements, publicTail };
}

export function parseMemberWindowResponse(value: unknown): MemberWindowResponse {
  const raw = displayRecord(value), certificate = parseDisplayCertificate(raw.certificate);
  const base = parseGroupExtent(raw.base), fragment = parseFragment(raw.fragment);
  validateExtent(base, fragment, certificate.watermark);
  const ordinals = displayArray(raw.ordinals, DISPLAY_PAGE_LIMIT).map(ordinal => displayInteger(ordinal, fragment.after + 1, fragment.through));
  if (ordinals.some((ordinal, index) => index > 0 && ordinal <= ordinals[index - 1])) throw new TypeError('Invalid member order');
  const edge = (value: unknown, field: 'beforeOrdinal' | 'afterOrdinal', expected: number | undefined) => {
    if (value === null) return null;
    const raw = displayRecord(value), ordinal = displayInteger(raw[field], fragment.after + 1, fragment.through);
    if (ordinal !== expected) throw new TypeError('Invalid member boundary');
    return { ordinal, remaining: displayInteger(raw.remaining, 1) };
  };
  const earlier = edge(raw.earlier, 'beforeOrdinal', ordinals[0]), later = edge(raw.later, 'afterOrdinal', ordinals.at(-1));
  return { certificate, base, fragment, ordinals,
    earlier: earlier && { beforeOrdinal: earlier.ordinal, remaining: earlier.remaining },
    later: later && { afterOrdinal: later.ordinal, remaining: later.remaining } };
}

export function parseBodyDependencyResponse(value: unknown): BodyDependencyResponse {
  const raw = displayRecord(value), certificate = parseDisplayCertificate(raw.certificate), W = certificate.watermark;
  const ordinal = (value: unknown) => displayInteger(value, 1, W);
  const nullableOrdinal = (value: unknown) => value === null ? null : ordinal(value);
  const list = (value: unknown) => {
    const ordinals = displayArray(value, 250).map(ordinal);
    if (new Set(ordinals).size !== ordinals.length) throw new TypeError('Duplicate body address');
    return ordinals;
  };
  const details = displayArray(raw.details, 50).map(value => {
    const detail = displayRecord(value);
    if (detail.commandFormat !== null && detail.commandFormat !== 'plain' && detail.commandFormat !== 'markdown') throw new TypeError('Invalid command format');
    return { ordinal: ordinal(detail.ordinal), pairedUse: nullableOrdinal(detail.pairedUse), pairedResult: nullableOrdinal(detail.pairedResult),
      questionWrapper: nullableOrdinal(detail.questionWrapper), permissionTerminal: nullableOrdinal(detail.permissionTerminal), commandFormat: detail.commandFormat } satisfies RowDetails;
  });
  const bodies = displayArray(raw.bodies, DISPLAY_BODY_LIMIT).map(parseDisplayBody);
  const all = bodies.map(body => ordinal(body.ordinal));
  const deferredOrdinals = list(raw.deferredOrdinals), nonRenderedOrdinals = list(raw.nonRenderedOrdinals);
  all.push(...deferredOrdinals, ...nonRenderedOrdinals);
  if (new Set(all).size !== all.length || new Set(details.map(detail => detail.ordinal)).size !== details.length) throw new TypeError('Conflicting body outcomes');
  const oversizedOrdinal = nullableOrdinal(raw.oversizedOrdinal);
  if (oversizedOrdinal !== null && (bodies.length !== 1 || bodies[0].ordinal !== oversizedOrdinal)) throw new TypeError('Invalid oversized response');
  return { certificate, details, bodies, deferredOrdinals, nonRenderedOrdinals, oversizedOrdinal };
}

export function parseDisplayTargetResolution(value: unknown): DisplayTargetResolution {
  const raw = displayRecord(value);
  if (raw.kind !== 'visible-row' && raw.kind !== 'group-member' && raw.kind !== 'attached-detail' && raw.kind !== 'filtered'
    && raw.kind !== 'non-rendered' && raw.kind !== 'preparing' && raw.kind !== 'missing') throw new TypeError('Invalid target resolution');
  const ordinal = displayInteger(raw.ordinal, 1), landedOrdinal = raw.landedOrdinal === null ? null : displayInteger(raw.landedOrdinal, 1);
  if ((raw.kind === 'visible-row' || raw.kind === 'group-member' || raw.kind === 'attached-detail') && landedOrdinal === null) throw new TypeError('Missing target address');
  return { kind: raw.kind, ordinal, landedOrdinal };
}
