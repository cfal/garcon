import { createRandomId } from '$lib/utils/random-id';

export function createClientCommandId(): string {
	return createRandomId();
}
