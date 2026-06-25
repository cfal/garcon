/* eslint-disable */
import { getLocale, experimentalStaticLocale } from '../runtime.js';

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Sidebar_Select_UnpinInputs */

const en_sidebar_select_unpin = /** @type {(inputs: Sidebar_Select_UnpinInputs) => LocalizedString} */ () => {
	return /** @type {LocalizedString} */ (`Unpin`)
};

/**
* | output |
* | --- |
* | "Unpin" |
*
* @param {Sidebar_Select_UnpinInputs} inputs
* @param {{ locale?: "en" }} options
* @returns {LocalizedString}
*/
export const sidebar_select_unpin = /** @type {((inputs?: Sidebar_Select_UnpinInputs, options?: { locale?: "en" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Sidebar_Select_UnpinInputs, { locale?: "en" }, {}>} */ ((inputs = {}, options = {}) => {
	experimentalStaticLocale ?? options.locale ?? getLocale()
	return en_sidebar_select_unpin(inputs)
});