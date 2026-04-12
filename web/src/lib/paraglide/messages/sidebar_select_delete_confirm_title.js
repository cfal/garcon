/* eslint-disable */
import { getLocale, experimentalStaticLocale } from '../runtime.js';

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{ count: NonNullable<unknown> }} Sidebar_Select_Delete_Confirm_TitleInputs */

const en_sidebar_select_delete_confirm_title = /** @type {(inputs: Sidebar_Select_Delete_Confirm_TitleInputs) => LocalizedString} */ (i) => {
	return /** @type {LocalizedString} */ (`Delete ${i?.count} chats`)
};

/**
* | output |
* | --- |
* | "Delete {count} chats" |
*
* @param {Sidebar_Select_Delete_Confirm_TitleInputs} inputs
* @param {{ locale?: "en" }} options
* @returns {LocalizedString}
*/
export const sidebar_select_delete_confirm_title = /** @type {((inputs: Sidebar_Select_Delete_Confirm_TitleInputs, options?: { locale?: "en" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Sidebar_Select_Delete_Confirm_TitleInputs, { locale?: "en" }, {}>} */ ((inputs, options = {}) => {
	const locale = experimentalStaticLocale ?? options.locale ?? getLocale()
	return en_sidebar_select_delete_confirm_title(inputs)
});