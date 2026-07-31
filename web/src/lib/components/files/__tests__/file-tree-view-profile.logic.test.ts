import { describe, expect, it } from 'vitest';
import {
	createFileTreeViewProfile,
	fileTreeViewGeometry,
	resolveFileTreeViewMode,
} from '../file-tree-view-profile.js';

describe('file tree view profile', () => {
	it('keeps the column rendering contract intact', () => {
		const profile = createFileTreeViewProfile({
			mode: 'columns',
			visibleColumnKeys: ['name', 'size', 'permissions'],
			columnGridTemplate: 'minmax(0, 60fr) minmax(0, 20fr) minmax(0, 20fr)',
		});

		expect(profile).toEqual({
			mode: 'columns',
			gridTemplate: 'minmax(0, 60fr) minmax(0, 20fr) minmax(0, 20fr)',
			fillerColumnKeys: ['size', 'permissions'],
			columnDetailKeys: ['size', 'permissions'],
			accessibleColumnCount: 3,
			minimumTableWidthPx: 520,
			entryIconSizePx: 16,
		});
	});

	it('derives one-column details without synthetic filler cells', () => {
		const profile = createFileTreeViewProfile({
			mode: 'details',
			visibleColumnKeys: ['name', 'modified', 'permissions'],
			columnGridTemplate: 'ignored',
		});

		expect(profile).toEqual({
			mode: 'details',
			gridTemplate: 'minmax(0, 1fr)',
			fillerColumnKeys: [],
			subtitleKeys: ['modified', 'permissions'],
			accessibleColumnCount: 1,
			minimumTableWidthPx: 240,
			entryIconSizePx: 32,
		});
	});

	it('retains the narrow column minimum when only names are visible', () => {
		const profile = createFileTreeViewProfile({
			mode: 'columns',
			visibleColumnKeys: ['name'],
			columnGridTemplate: 'minmax(0, 1fr)',
		});

		expect(profile.minimumTableWidthPx).toBe(240);
	});

	it('resolves responsive layouts from preference, metadata, and container width', () => {
		const resolve = (
			containerWidth: number,
			visibleColumnKeys: ('name' | 'size' | 'modified' | 'permissions')[] = ['name', 'size'],
		) =>
			resolveFileTreeViewMode({
				preference: 'responsive',
				containerWidth,
				visibleColumnKeys,
			});

		expect(resolve(0)).toBe('details');
		expect(resolve(519.5)).toBe('details');
		expect(resolve(520)).toBe('columns');
		expect(resolve(200, ['name'])).toBe('columns');
		expect(
			resolveFileTreeViewMode({
				preference: 'always-details',
				containerWidth: 900,
				visibleColumnKeys: ['name'],
			}),
		).toBe('details');
	});

	it('provides fixed geometry for both modes', () => {
		expect(fileTreeViewGeometry('columns')).toEqual({
			headerHeight: 32,
			fineRowHeight: 28,
			coarseRowHeight: 36,
			fineDisclosureSize: 28,
			coarseDisclosureSize: 36,
		});
		expect(fileTreeViewGeometry('details')).toEqual({
			headerHeight: 0,
			fineRowHeight: 44,
			coarseRowHeight: 52,
			fineDisclosureSize: 28,
			coarseDisclosureSize: 36,
		});
	});
});
