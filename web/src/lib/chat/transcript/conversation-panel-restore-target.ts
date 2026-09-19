export type ConversationPanelRestoreTarget =
	| { readonly kind: 'end' }
	| {
			readonly kind: 'row';
			readonly transcriptViewId: string;
			readonly ordinal: number;
			readonly viewportOffset: number;
	  }
	| {
			readonly kind: 'group-summary';
			readonly transcriptViewId: string;
			readonly ordinal: number;
			readonly viewportOffset: number;
	  };
