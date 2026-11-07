export interface DisplaySummaryPaging {
	readonly loading: boolean;
	readonly updating: boolean;
	readonly stale: boolean;
	readonly error: string | null;
	readonly hasPrevious: boolean;
	readonly hasNext: boolean;
	retry(): Promise<void>;
	next(): Promise<void>;
	previous(): Promise<void>;
}
