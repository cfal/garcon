/* eslint-disable */
import { getLocale, experimentalStaticLocale } from '../runtime.js';

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{ count: NonNullable<unknown> }} Sidebar_Select_Delete_Confirm_And_MoreInputs */

const en_sidebar_select_delete_confirm_and_more = /** @type {(inputs: Sidebar_Select_Delete_Confirm_And_MoreInputs) => LocalizedString} */ (i) => {
	return /** @type {LocalizedString} */ (`and ${i?.count} more`)
};

/**
* | output |
* | --- |
* | "and {count} more" |
*
* @param {Sidebar_Select_Delete_Confirm_And_MoreInputs} inputs
* @param {{ locale?: "en" }} options
* @returns {LocalizedString}
*/
export const sidebar_select_delete_confirm_and_more = /** @type {((inputs: Sidebar_Select_Delete_Confirm_And_MoreInputs, options?: { locale?: "en" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Sidebar_Select_Delete_Confirm_And_MoreInputs, { locale?: "en" }, {}>} */ ((inputs, options = {}) => {
	const locale = experimentalStaticLocale ?? options.locale ?? getLocale()
	return en_sidebar_select_delete_confirm_and_more(inputs)
});