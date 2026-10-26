/** B-178: the arrival safety check is on unless the server's SAFETY_CHECK says off. */
export const safetyOn = (env: { SAFETY_CHECK?: string }) => (env.SAFETY_CHECK ?? "").toLowerCase() !== "off";

/**
 * The check actually runs on arrival: it is on, the categories store that runs it is bound, and the AI binding it
 * needs is there (a test or a partial deploy has none). Whoever waits for its answer waits only then (C-3, C-11, A-11).
 */
export const safetyChecks = (env: { SAFETY_CHECK?: string; AI?: unknown; CATEGORIES?: unknown }) => safetyOn(env) && !!env.AI && !!env.CATEGORIES;
