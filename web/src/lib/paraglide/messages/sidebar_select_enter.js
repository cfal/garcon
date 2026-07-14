/* eslint-disable */
import { getLocale, experimentalStaticLocale } from '../runtime.js';

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Sidebar_Select_EnterInputs */

const en_sidebar_select_enter = /** @type {(inputs: Sidebar_Select_EnterInputs) => LocalizedString} */ () => {
	return /** @type {LocalizedString} */ (`Select`)
};

/**
* | output |
* | --- |
* | "Select" |
*
* @param {Sidebar_Select_EnterInputs} inputs
* @param {{ locale?: "en" }} options
* @returns {LocalizedString}
*/
export const sidebar_select_enter = /** @type {((inputs?: Sidebar_Select_EnterInputs, options?: { locale?: "en" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Sidebar_Select_EnterInputs, { locale?: "en" }, {}>} */ ((inputs = {}, options = {}) => {
	experimentalStaticLocale ?? options.locale ?? getLocale()
	return en_sidebar_select_enter(inputs)
});