/**
 * B-192 (board finding 143db3e4, VoC audit 2026-10-27): an answer that tells a person a state the server
 * cannot confirm ("your Premium is active", "the refund went through", "we passed it to the developers",
 * "it is fixed"). This only names the kinds an answer contains, for the logs, so how often it happens can be
 * counted before anything is held on it. Never the text, never a verdict that the claim is false.
 */
export type StateClaim = "account_state" | "refund_done" | "passed_to_team" | "fixed";

const PATTERNS: Record<StateClaim, RegExp[]> = {
  account_state: [
    /\b(?:your|the)\s+(?:premium|subscription|account|plan)\s+(?:is|has\s+been|was)\s+(?:now\s+)?(?:active|activated|restored|unblocked|unbanned|enabled|renewed)\b/i,
    /(?:ваш[аеи]?\s+)?(?:подписка|премиум|premium|аккаунт|тариф)\s+(?:уже\s+|теперь\s+)?(?:активн|активирован|восстановлен|разблокирован|продлен|продлён|включен|включён)/i,
  ],
  refund_done: [
    /\b(?:refund|money|payment)\s+(?:has\s+been|was|is)\s+(?:now\s+)?(?:issued|processed|sent|returned|completed|refunded)\b/i,
    /\bwe(?:\s+have|'ve)?\s+(?:refunded|issued\s+(?:a|the|your)\s+refund|returned\s+(?:the|your)\s+(?:money|payment))\b/i,
    /(?:возврат|деньги|оплата)\s+(?:уже\s+)?(?:оформлен|выполнен|прош[её]л|отправлен|возвращен|возвращён|возвращены)/i,
    /мы\s+(?:уже\s+)?(?:вернули|оформили\s+возврат)/i,
  ],
  passed_to_team: [
    /\bwe(?:\s+have|'ve)?\s+(?:passed|forwarded|escalated|reported|sent)\s+(?:this|it|your\s+\w+)\s+(?:on\s+)?to\s+(?:the|our)\s+(?:\w+\s+)?(?:team|developers?|engineers?)\b/i,
    /\b(?:passed|forwarded|escalated)\s+(?:it\s+|this\s+)?(?:on\s+)?to\s+(?:the|our)\s+(?:\w+\s+)?(?:team|developers?|engineers?)\b/i,
    /(?:передал[иа]?|переслал[иа]?|сообщил[иа]?)\s+(?:это\s+|ваш[аеуи]?\s+\S+\s+)?(?:нашей\s+)?(?:команде|разработчикам|инженерам)/i,
  ],
  fixed: [
    /\b(?:has|have)\s+(?:now\s+)?been\s+(?:fixed|resolved)\b/i,
    /\bwe(?:\s+have|'ve)\s+(?:fixed|resolved)\b/i,
    /\bthe\s+(?:issue|bug|problem|error)\s+is\s+(?:now\s+)?(?:fixed|resolved)\b/i,
    /(?:^|[\s,.])(?:мы\s+)?(?:исправили|починили|устранили)/i,
    /(?:проблема|ошибка|баг)\s+(?:уже\s+)?(?:исправлена|устранена|решена)/i,
  ],
};

/** The kinds of state claim in an answer, in a fixed order; empty when it makes none. */
export function stateClaims(text: string): StateClaim[] {
  return (Object.keys(PATTERNS) as StateClaim[]).filter((kind) => PATTERNS[kind].some((re) => re.test(text)));
}
