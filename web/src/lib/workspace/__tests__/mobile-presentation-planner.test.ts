import { describe, expect, it } from 'vitest';
import { canonicalWorkspaceSnapshot } from '../canonical-layout.js';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte.js';
import { MobilePresentationPlanner } from '../mobile-presentation-planner.js';

describe('MobilePresentationPlanner', () => {
	it('records and restores a route- and project-valid transient invoker', () => {
		const context = { chatId: 'chat-a', effectiveProjectKey: 'project-a' };
		const planner = new MobilePresentationPlanner({
			getContext: () => context,
			getRouteIdentity: () => '/chat/chat-a',
		});
		const gitActive = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'set-mobile-presentation',
				activeId: 'singleton:git',
				returnStack: [],
			},
		]);
		const returnStack = planner.returnStackForTransient('singleton:commit', gitActive, true);
		const commitActive = reduceWorkspaceLayout(gitActive, [
			{
				type: 'set-mobile-presentation',
				activeId: 'singleton:commit',
				returnStack,
			},
		]);

		expect(returnStack).toEqual([
			{
				invokerSurfaceId: 'singleton:git',
				invokerHost: 'mobile',
				chatId: 'chat-a',
				effectiveProjectKey: 'project-a',
				routeIdentity: '/chat/chat-a',
			},
		]);
		expect(planner.resolveReturn('singleton:commit', commitActive)).toEqual({
			activeId: 'singleton:git',
			returnStack: [],
		});
	});

	it('ignores stale return entries and falls back to non-excluded mobile recency', () => {
		let routeIdentity = '/chat/chat-a';
		const context = { chatId: 'chat-a', effectiveProjectKey: 'project-a' };
		const planner = new MobilePresentationPlanner({
			getContext: () => context,
			getRouteIdentity: () => routeIdentity,
		});
		const gitActive = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'set-mobile-presentation',
				activeId: 'singleton:git',
				returnStack: [],
			},
		]);
		const staleReturnStack = planner.returnStackForTransient('singleton:commit', gitActive, true);
		const commitActive = reduceWorkspaceLayout(gitActive, [
			{
				type: 'set-mobile-presentation',
				activeId: 'singleton:commit',
				returnStack: staleReturnStack,
			},
		]);
		planner.noteActivation('singleton:files');
		routeIdentity = '/chat/chat-b';

		expect(planner.resolveReturn('singleton:commit', commitActive)).toEqual({
			activeId: 'singleton:files',
			returnStack: [],
		});
	});

	it('does not add return entries outside mobile or for an already active surface', () => {
		const planner = new MobilePresentationPlanner({
			getContext: () => null,
			getRouteIdentity: () => '/',
		});
		const snapshot = canonicalWorkspaceSnapshot();

		expect(planner.returnStackForTransient('singleton:commit', snapshot, false)).toBe(
			snapshot.mobileReturnStack,
		);
		expect(planner.returnStackForTransient('singleton:chat', snapshot, true)).toBe(
			snapshot.mobileReturnStack,
		);
	});
});
