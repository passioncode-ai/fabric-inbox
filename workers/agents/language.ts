/**
 * Whether a message can go to a knowledge tool as written. The data agent reads questions in English
 * and Russian only; a question in another language is matched by its words alone and can come back
 * as a confident wrong answer (a German mail about Premium matched the pricing fact at 1.0). Such a
 * message is put into English first (runner.ts). Cheap and local: letters and common words, no model.
 * Mixed or unsure text counts as other, which only costs one short model call.
 */
export type QueryLanguage = "en" | "ru" | "other";

const ENGLISH = new Set(("the a an and or but is are was were be been am i you he she it we they my your our their me him her us them " +
  "to of in on at for with from by about as into not no do does did have has had can could would should will " +
  "this that these those what how why when where which who please hi hello thanks thank there here if so").split(" "));
/** Letters Russian does not use: Ukrainian, Belarusian, Serbian, Macedonian, Kazakh and others. */
const NOT_RUSSIAN = /[іїєґўђјљњћџқңөүұһәі]/i;

export function queryLanguage(text: string): QueryLanguage {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 3) return "en";
  const cyrillic = letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  if (cyrillic / letters.length > 0.6) return NOT_RUSSIAN.test(text) ? "other" : "ru";
  if (latin / letters.length < 0.6) return "other";
  // Latin script: English by its function words and the absence of other languages' letters.
  const words = (text.toLowerCase().match(/\p{L}+/gu) ?? []);
  const accented = letters.filter((c) => /[^\x00-\x7F]/.test(c) && /\p{Script=Latin}/u.test(c)).length;
  if (accented / Math.max(latin, 1) > 0.01) return "other";
  const english = words.filter((w) => ENGLISH.has(w)).length;
  if (words.length <= 4) return english || words.length <= 2 ? "en" : "other";
  return english / words.length >= 0.12 ? "en" : "other";
}
