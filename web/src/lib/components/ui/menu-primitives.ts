import {
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from './dropdown-menu';
import {
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuRadioGroup,
	ContextMenuRadioItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from './context-menu';

export const dropdownMenuPrimitives = {
	kind: 'dropdown',
	Item: DropdownMenuItem,
	Label: DropdownMenuLabel,
	RadioGroup: DropdownMenuRadioGroup,
	RadioItem: DropdownMenuRadioItem,
	Separator: DropdownMenuSeparator,
	Sub: DropdownMenuSub,
	SubContent: DropdownMenuSubContent,
	SubTrigger: DropdownMenuSubTrigger,
} as const;

export const contextMenuPrimitives = {
	kind: 'context',
	Item: ContextMenuItem,
	Label: ContextMenuLabel,
	RadioGroup: ContextMenuRadioGroup,
	RadioItem: ContextMenuRadioItem,
	Separator: ContextMenuSeparator,
	Sub: ContextMenuSub,
	SubContent: ContextMenuSubContent,
	SubTrigger: ContextMenuSubTrigger,
} as const;

export type MenuPrimitives = typeof dropdownMenuPrimitives | typeof contextMenuPrimitives;
