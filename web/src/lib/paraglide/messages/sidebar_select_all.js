/* eslint-disable */
import { getLocale, experimentalStaticLocale } from '../runtime.js';

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Sidebar_Select_AllInputs */

const en_sidebar_select_all = /** @type {(inputs: Sidebar_Select_AllInputs) => LocalizedString} */ () => {
	return /** @type {LocalizedString} */ (`All`)
};

/**
* | output |
* | --- |
* | "All" |
*
* @param {Sidebar_Select_AllInputs} inputs
* @param {{ locale?: "en" }} options
* @returns {LocalizedString}
*/
export const sidebar_select_all = /** @type {((inputs?: Sidebar_Select_AllInputs, options?: { locale?: "en" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Sidebar_Select_AllInputs, { locale?: "en" }, {}>} */ ((inputs = {}, options = {}) => {
	const locale = experimentalStaticLocale ?? options.locale ?? getLocale()
	return en_sidebar_select_all(inputs)
});