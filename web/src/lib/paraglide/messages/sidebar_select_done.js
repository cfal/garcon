/* eslint-disable */
import { getLocale, experimentalStaticLocale } from '../runtime.js';

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Sidebar_Select_DoneInputs */

const en_sidebar_select_done = /** @type {(inputs: Sidebar_Select_DoneInputs) => LocalizedString} */ () => {
	return /** @type {LocalizedString} */ (`Done`)
};

/**
* | output |
* | --- |
* | "Done" |
*
* @param {Sidebar_Select_DoneInputs} inputs
* @param {{ locale?: "en" }} options
* @returns {LocalizedString}
*/
export const sidebar_select_done = /** @type {((inputs?: Sidebar_Select_DoneInputs, options?: { locale?: "en" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Sidebar_Select_DoneInputs, { locale?: "en" }, {}>} */ ((inputs = {}, options = {}) => {
	const locale = experimentalStaticLocale ?? options.locale ?? getLocale()
	return en_sidebar_select_done(inputs)
});