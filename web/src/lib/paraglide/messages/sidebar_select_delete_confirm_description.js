/* eslint-disable */
import { getLocale, experimentalStaticLocale } from '../runtime.js';

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Sidebar_Select_Delete_Confirm_DescriptionInputs */

const en_sidebar_select_delete_confirm_description = /** @type {(inputs: Sidebar_Select_Delete_Confirm_DescriptionInputs) => LocalizedString} */ () => {
	return /** @type {LocalizedString} */ (`This can't be undone.`)
};

/**
* | output |
* | --- |
* | "This can't be undone." |
*
* @param {Sidebar_Select_Delete_Confirm_DescriptionInputs} inputs
* @param {{ locale?: "en" }} options
* @returns {LocalizedString}
*/
export const sidebar_select_delete_confirm_description = /** @type {((inputs?: Sidebar_Select_Delete_Confirm_DescriptionInputs, options?: { locale?: "en" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Sidebar_Select_Delete_Confirm_DescriptionInputs, { locale?: "en" }, {}>} */ ((inputs = {}, options = {}) => {
	const locale = experimentalStaticLocale ?? options.locale ?? getLocale()
	return en_sidebar_select_delete_confirm_description(inputs)
});