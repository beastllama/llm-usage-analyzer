/**
 * A whole number written with digits only, such as 3456. Anything else ("0x50", "1e3", "3456abc", "-1", "08", " 5")
 * becomes NaN, and the command reports it as a bad value instead of guessing what was meant.
 */
export const wholeNumber = (text: string): number => (/^(0|[1-9]\d*)$/.test(text) ? Number(text) : NaN);
