import type { SidebarRowModelInput } from '../sidebar-row-model';

export class SidebarOrderTestInput {
	current: SidebarRowModelInput;

	constructor(input: SidebarRowModelInput) {
		this.current = $state.raw(input);
	}
}
