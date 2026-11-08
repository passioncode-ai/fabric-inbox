/**
 * Triage before an answer (B-237 gap 1, the communication agent template's 3.1 and rule 1.4). A greeting with
 * nothing else, or a message with no words at all, gets one fixed question back instead of no reply; a complaint
 * with no detail or an ask outside the address's purpose gets the writer's one or two sentences (kind clarify or
 * decline), sent only when their shape carries no fact: no link, number or address, at most one question. One
 * clarifying question per conversation: the runner offers none once this address has answered in it.
 */
export type TriageKind = "greeting" | "empty" | "clarify" | "decline";

/** Words a greeting is made of, in the languages the fixed replies speak and their neighbours. */
const GREETING = new Set([
  "hi", "hello", "hey", "hiya", "yo", "there", "dear", "team", "support", "all", "everyone", "good", "morning",
  "afternoon", "evening", "day", "greetings", "sir", "madam", "guys", "folks",
  "привет", "приветствую", "здравствуйте", "здравствуй", "здрасте", "добрый", "доброе", "день", "утро", "вечер",
  "доброго", "всем", "команда", "поддержка", "уважаемые", "уважаемая", "уважаемый", "салют", "хай",
  "hola", "buenos", "buenas", "dias", "días", "tardes", "bonjour", "salut", "hallo", "guten", "tag", "ciao", "olá", "ola", "oi",
]);

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const SUBJECT_PREFIX = /^((re|fw|fwd|aw|wg|sv|vs|ответ|отв|пересл)\s*(\[\d+\])?\s*:\s*)+/i;

function kindOf(text: string): "greeting" | "empty" | "other" {
  const list = words(text);
  if (!list.length) return "empty";
  return list.length <= 8 && list.every((w) => GREETING.has(w)) ? "greeting" : "other";
}

/** "greeting" or "empty" when the message carries nothing to answer; null hands it to the writer. */
export function messageTriage(subject: string, text: string): "greeting" | "empty" | null {
  const body = kindOf(text);
  if (body === "other") return null;
  const head = kindOf(subject.replace(SUBJECT_PREFIX, ""));
  if (head === "other") return null;
  return body === "greeting" || head === "greeting" ? "greeting" : "empty";
}

/** A clarifying question or a decline that states nothing: short, no link, number or address, one question at most. */
export function triageShape(body: string, _kind: "clarify" | "decline"): boolean {
  const text = body.trim();
  if (!text || text.length > 500) return false;
  if (/https?:|www\.|@|\p{N}|\b[a-z0-9-]+\.(com|org|net|io|ai|app|me|ru)\b/iu.test(text)) return false;
  if ((text.match(/\?/g) ?? []).length > 1) return false;
  const sentences = text.split(/[.!?…]+/).filter((s) => words(s).length);
  return sentences.length <= 3;
}

/** The fixed question back for a greeting or an empty message (en and ru, as the other fixed replies). */
export const TRIAGE_REPLY: Record<"greeting" | "empty", { en: string; ru: string }> = {
  greeting: {
    en: "Hello! How can we help? Tell us what happened and what you were trying to do.",
    ru: "Здравствуйте! Чем помочь? Напишите, что случилось и что вы пытались сделать.",
  },
  empty: {
    en: "Hello! Your message reached us without any text. Tell us what happened and what you were trying to do.",
    ru: "Здравствуйте! Ваше письмо пришло без текста. Напишите, что случилось и что вы пытались сделать.",
  },
};
