import { displayCutsKey, displayProfileKey, type AvailableDisplayWindow, type DisplayCertificate,
  type DisplayCut, type DisplayDescriptor, type DisplayProfile, type DisplayTargetResolution,
  type DisplayWindowRequest, type GroupDescriptor, type MemberWindowRequest, type MemberWindowResponse,
  type PublicTailEvidence, type RowDescriptor } from '../../../common/transcript-display-contract.js';
import { DISPLAY_POLICY_REVISION, SUMMARY_CATEGORIES, type SummaryCategory } from '../../../common/transcript-display-policy.js';
import { classEligible, postingClass } from './classes.js';
import { DisplayStore } from './store.js';

interface Posting { ordinal: number; rank: number; cumulative_weight: number }
export interface DisplayFeature {
  ordinal: number; role: 'hidden' | 'member' | 'breaker'; class_id: number | null;
  message_type: RowDescriptor['messageType'] | null; permission_occurrence: string | null;
  command_id: string | null; command_markdown: number; estimated_body_bytes: number; submission_id: string | null;
}

export class DisplayQuery {
  readonly classes: readonly number[];
  readonly members: readonly number[];
  readonly breakers: readonly number[];
  readonly cutOrdinals: readonly number[];

  constructor(readonly store: DisplayStore, readonly profile: DisplayProfile, readonly watermark: number,
    readonly cuts: readonly DisplayCut[], readonly useBashPostings: boolean) {
    store.requirePrepared(watermark);
    if (useBashPostings && !profile.hiddenToolGroups.includes('bash')) {
      const revision = store.get<{ status: string; prepared_through: number }>('SELECT status, prepared_through FROM bash_revision WHERE revision = ?', profile.bashRevision);
      if (!revision || revision.status === 'pruning' || revision.prepared_through < watermark) {
        throw Object.assign(new Error('Bash revision is not prepared'), { code: 'DISPLAY_PREPARING' });
      }
    }
    this.classes = store.all<{ class_id: number }>('SELECT class_id FROM class_tail').map(row => row.class_id)
      .filter(id => classEligible(id, profile));
    this.members = this.classes.filter(id => postingClass(id).role === 'member');
    this.breakers = this.classes.filter(id => postingClass(id).role === 'breaker');
    this.cutOrdinals = [...new Set(cuts.filter(cut => cut.afterOrdinal <= watermark
      && (cut.anchorRule === 'raw-position' || this.eligible(cut.afterOrdinal)))
      .map(cut => cut.afterOrdinal))].sort((a, b) => a - b);
  }

  feature(ordinal: number): DisplayFeature | null {
    return ordinal <= this.watermark ? this.store.get<DisplayFeature>('SELECT * FROM feature WHERE ordinal = ?', ordinal) : null;
  }

  eligible(ordinal: number): boolean {
    const feature = this.feature(ordinal);
    if (feature?.class_id === null || !feature || !this.classes.includes(feature.class_id)) return false;
    return this.prefix(feature.class_id, ordinal)?.ordinal === ordinal;
  }

  prefix(id: number, through: number): Posting | null {
    const [table, args] = this.source(id);
    return this.store.get<Posting>(`SELECT ordinal, rank, cumulative_weight FROM ${table} WHERE ${args.length === 2 ? 'revision = ? AND ' : ''}class_id = ? AND ordinal <= ? ORDER BY ordinal DESC LIMIT 1`, ...args, Math.min(through, this.watermark));
  }

  seek(ids: readonly number[], after: number, through: number, reverse = false): number | null {
    let found: number | null = null;
    for (const id of ids) {
      const [table, args] = this.source(id);
      const row = this.store.get<{ ordinal: number }>(`SELECT ordinal FROM ${table} WHERE ${args.length === 2 ? 'revision = ? AND ' : ''}class_id = ? AND ordinal > ? AND ordinal <= ? ORDER BY ordinal ${reverse ? 'DESC' : 'ASC'} LIMIT 1`,
        ...args, after, Math.min(through, this.watermark));
      if (row && (found === null || (reverse ? row.ordinal > found : row.ordinal < found))) found = row.ordinal;
    }
    return found;
  }

  descriptor(ordinal: number): DisplayDescriptor {
    const feature = this.feature(ordinal);
    if (!feature || !feature.message_type || !this.eligible(ordinal)) throw new TypeError('Display target is not eligible');
    if (this.profile.combine && feature.role === 'member') return this.group(ordinal);
    return { kind: 'row', ordinal, messageType: feature.message_type,
      layout: feature.message_type === 'permission-request' || feature.message_type === 'exit-plan-mode-tool-use'
        || (feature.message_type === 'tool-result' && this.store.get<{ tool_type: string }>(
          'SELECT f.message_type AS tool_type FROM tool_pair p JOIN feature f ON f.ordinal = p.use_ordinal WHERE p.result_ordinal = ?', ordinal)?.tool_type === 'ask-user-question-tool-use') ? 'permission' : 'standard',
      estimatedBodyBytes: feature.estimated_body_bytes, permissionOccurrenceId: feature.permission_occurrence };
  }

  group(ordinal: number): GroupDescriptor {
    const afterBreaker = this.seek(this.breakers, 0, ordinal - 1, true) ?? 0;
    const beforeBreaker = this.seek(this.breakers, ordinal, this.watermark) ?? this.watermark + 1;
    const firstMember = this.seek(this.members, afterBreaker, beforeBreaker - 1);
    const lastMember = this.seek(this.members, afterBreaker, beforeBreaker - 1, true);
    if (firstMember === null || lastMember === null) throw new TypeError('Empty tool group');
    let after = afterBreaker, through = beforeBreaker - 1;
    for (const cut of this.cutOrdinals) {
      if (cut >= afterBreaker && cut < ordinal) after = cut;
      else if (cut >= ordinal && cut < through) { through = cut; break; }
    }
    const totals = Object.fromEntries(SUMMARY_CATEGORIES.map(category => [category, 0])) as Record<SummaryCategory, number>;
    const firstByCategory = new Map<SummaryCategory, number>();
    let count = 0;
    for (const id of this.members) {
      const lo = this.prefix(id, after), hi = this.prefix(id, through);
      const n = (hi?.rank ?? 0) - (lo?.rank ?? 0);
      if (!n) continue;
      count += n;
      const category = postingClass(id).category!;
      totals[category] += (hi?.cumulative_weight ?? 0) - (lo?.cumulative_weight ?? 0);
      const first = this.seek([id], after, through)!;
      firstByCategory.set(category, Math.min(first, firstByCategory.get(category) ?? first));
    }
    return { kind: 'tool-group', base: { afterBreaker, beforeBreaker, firstMember, lastMember, openAtWatermark: beforeBreaker === this.watermark + 1 },
      fragment: { after, through }, firstMember: this.seek(this.members, after, through)!,
      lastMember: this.seek(this.members, after, through, true)!, count, totals,
      categoryOrder: [...firstByCategory].sort((a, b) => a[1] - b[1]).map(([category]) => category) };
  }

  page(after: number, through: number, reverse: boolean, limit: number): DisplayDescriptor[] {
    const items: DisplayDescriptor[] = [];
    while (items.length < limit) {
      const ordinal = this.seek(this.classes, after, through, reverse);
      if (ordinal === null) break;
      const item = this.descriptor(ordinal);
      const bounds = descriptorBounds(item);
      if (bounds.after < after || bounds.through > through) throw new TypeError('Display cursor clips a group');
      items.push(item);
      if (reverse) through = bounds.after;
      else after = bounds.through;
    }
    return reverse ? items.reverse() : items;
  }

  window(request: DisplayWindowRequest, certificate: DisplayCertificate, sourceHead: number, bashFrontier: number): AvailableDisplayWindow {
    let items: DisplayDescriptor[];
    switch (request.anchor.kind) {
      case 'newest': items = this.page(0, this.watermark, true, request.limit); break;
      case 'before': items = this.page(0, request.anchor.cursor.boundaryOrdinal - 1, true, request.limit); break;
      case 'after': items = this.page(request.anchor.cursor.boundaryOrdinal, this.watermark, false, request.limit); break;
      case 'around': {
        const ordinal = this.seek(this.classes, 0, request.anchor.ordinal, true)
          ?? this.seek(this.classes, request.anchor.ordinal, this.watermark);
        if (ordinal === null) { items = []; break; }
        const center = this.descriptor(ordinal), bounds = descriptorBounds(center);
        const earlier = this.page(0, bounds.after, true, Math.floor((request.limit - 1) / 2));
        const later = this.page(bounds.through, this.watermark, false, request.limit - earlier.length - 1);
        const extra = request.limit - earlier.length - later.length - 1;
        const prefix = extra > 0 ? this.page(0, earlier.length ? descriptorBounds(earlier[0]).after : bounds.after, true, extra) : [];
        items = [...prefix, ...earlier, center, ...later];
      }
    }
    let interval = { after: 0, through: this.watermark };
    if (items.length) {
      interval = { after: descriptorBounds(items[0]).after, through: descriptorBounds(items.at(-1)!).through };
    } else if (request.anchor.kind === 'before') {
      interval.through = request.anchor.cursor.boundaryOrdinal - 1;
    } else if (request.anchor.kind === 'after') {
      interval.after = Math.min(request.anchor.cursor.boundaryOrdinal, this.watermark);
    }
    const earlier = this.seek(this.classes, 0, interval.after, true);
    const later = this.seek(this.classes, interval.through, this.watermark);
    const tail = this.store.get<{ ordinal: number; content_digest: string | null; combined_digest: string | null }>(
      'SELECT ordinal, content_digest, combined_digest FROM public_tail WHERE ordinal <= ? ORDER BY ordinal DESC LIMIT 1', this.watermark);
    const publicTail: PublicTailEvidence | null = tail ? { ordinal: tail.ordinal, contentDigest: tail.content_digest, combinedDigest: tail.combined_digest } : null;
    return { kind: 'available', certificate, sourceHead, structuralPreparedThrough: Math.min(sourceHead, this.store.manifest()!.prepared_through),
      bashPreparedThrough: bashFrontier, interval, items, publicTail,
      earlier: earlier === null ? { kind: 'exhausted-through-watermark' } : { kind: 'more', cursor: { certificate, boundaryOrdinal: interval.after + 1 } },
      later: later === null ? { kind: 'exhausted-through-watermark' } : { kind: 'more', cursor: { certificate, boundaryOrdinal: interval.through } },
      cutPlacements: this.cuts.map(cut => ({ id: cut.id, placement: this.cutOrdinals.includes(cut.afterOrdinal)
        && cut.afterOrdinal >= interval.after && cut.afterOrdinal <= interval.through ? 'inline' : 'detached' })) };
  }

  memberWindow(request: MemberWindowRequest): MemberWindowResponse {
    const group = this.group(request.base.firstMember >= request.fragment.after + 1
      ? request.base.firstMember : this.seek(this.members, request.fragment.after, request.fragment.through) ?? 0);
    if (JSON.stringify(group.base) !== JSON.stringify(request.base) || group.fragment.after !== request.fragment.after
      || group.fragment.through !== request.fragment.through) throw new TypeError('Stale member extent');
    const { after, through } = group.fragment, anchor = request.anchor;
    const collect = (lo: number, hi: number, reverse: boolean, limit: number): number[] => {
      const result: number[] = [];
      while (result.length < limit) {
        const next = this.seek(this.members, lo, hi, reverse);
        if (next === null) break;
        result.push(next);
        if (reverse) hi = next - 1; else lo = next;
      }
      return reverse ? result.reverse() : result;
    };
    let ordinals: number[];
    if (anchor.kind === 'first') ordinals = collect(after, through, false, request.limit);
    else if (anchor.kind === 'before') ordinals = collect(after, Math.min(through, anchor.ordinal - 1), true, request.limit);
    else if (anchor.kind === 'after') ordinals = collect(Math.max(after, anchor.ordinal), through, false, request.limit);
    else {
      const left = collect(after, Math.min(through, anchor.ordinal - 1), true, Math.floor(request.limit / 2));
      ordinals = [...left, ...collect(Math.max(after, anchor.ordinal - 1), through, false, request.limit - left.length)];
    }
    const count = (lo: number, hi: number) => this.members.reduce((sum, id) => sum + (this.prefix(id, hi)?.rank ?? 0) - (this.prefix(id, lo)?.rank ?? 0), 0);
    const first = ordinals[0] ?? after + 1, last = ordinals.at(-1) ?? through;
    const before = count(after, first - 1), later = count(last, through);
    return { certificate: request.certificate, base: group.base, fragment: group.fragment, ordinals,
      earlier: before ? { beforeOrdinal: first, remaining: before } : null,
      later: later ? { afterOrdinal: last, remaining: later } : null };
  }

  resolve(ordinal: number, sourceHead: number): DisplayTargetResolution {
    if (ordinal > sourceHead) return { kind: 'missing', ordinal, landedOrdinal: null };
    if (ordinal > this.watermark) return { kind: 'preparing', ordinal, landedOrdinal: null };
    const feature = this.feature(ordinal);
    if (!feature?.message_type) return { kind: 'non-rendered', ordinal, landedOrdinal: null };
    if (this.eligible(ordinal)) return { kind: feature.role === 'member' && this.profile.combine ? 'group-member' : 'visible-row', ordinal, landedOrdinal: ordinal };
    if (feature.message_type === 'tool-result') {
      const pair = this.store.get<{ use_ordinal: number; wrapper_ordinal: number | null }>('SELECT use_ordinal, wrapper_ordinal FROM tool_pair WHERE result_ordinal = ? AND evidence_ordinal <= ?', ordinal, this.watermark);
      if (pair && this.eligible(pair.use_ordinal)) return { kind: 'attached-detail', ordinal, landedOrdinal: pair.use_ordinal };
      if (pair?.wrapper_ordinal && this.eligible(pair.wrapper_ordinal)) return { kind: 'attached-detail', ordinal, landedOrdinal: pair.wrapper_ordinal };
    }
    return { kind: feature.role === 'hidden' ? 'non-rendered' : 'filtered', ordinal,
      landedOrdinal: this.seek(this.classes, 0, ordinal, true) ?? this.seek(this.classes, ordinal, this.watermark) };
  }

  private source(id: number): [string, (number | string)[]] {
    return this.useBashPostings && postingClass(id).bash ? ['bash_posting', [this.profile.bashRevision, id]] : ['posting', [id]];
  }
}

export function descriptorBounds(item: DisplayDescriptor): { after: number; through: number } {
  return item.kind === 'row' ? { after: item.ordinal - 1, through: item.ordinal } : item.fragment;
}

export function displayCertificate(serverInstanceId: string, request: Pick<DisplayWindowRequest, 'chatId' | 'transcriptViewId' | 'profile' | 'cuts'>, watermark: number): DisplayCertificate {
  return { serverInstanceId, chatId: request.chatId, transcriptViewId: request.transcriptViewId, policyRevision: DISPLAY_POLICY_REVISION,
    profileKey: displayProfileKey(request.profile), bashRevision: request.profile.bashRevision, watermark, cutsKey: displayCutsKey(request.cuts) };
}
