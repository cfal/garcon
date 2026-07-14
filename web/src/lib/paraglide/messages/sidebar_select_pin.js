/* eslint-disable */
import { getLocale, experimentalStaticLocale } from '../runtime.js';

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Sidebar_Select_PinInputs */

const en_sidebar_select_pin = /** @type {(inputs: Sidebar_Select_PinInputs) => LocalizedString} */ () => {
	return /** @type {LocalizedString} */ (`Pin`)
};

/**
* | output |
* | --- |
* | "Pin" |
*
* @param {Sidebar_Select_PinInputs} inputs
* @param {{ locale?: "en" }} options
* @returns {LocalizedString}
*/
export const sidebar_select_pin = /** @type {((inputs?: Sidebar_Select_PinInputs, options?: { locale?: "en" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Sidebar_Select_PinInputs, { locale?: "en" }, {}>} */ ((inputs = {}, options = {}) => {
	experimentalStaticLocale ?? options.locale ?? getLocale()
	return en_sidebar_select_pin(inputs)
});