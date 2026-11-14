import { analyse, type SignalName } from "../../vendor/okolos/core-injection/signals";
import { splitHidden, HIDDEN_CHARS } from "./hidden";
import type { MailCheck } from "../../shared/mail/safety";

/**
 * B-178: whether an arriving message carries instructions aimed at an AI, read from what a person sees and what
 * only a machine reads. Two layers: Okolos's deterministic signals (`analyse`, English and Russian), and a light
 * model's YES or NO over both texts. Either one makes the message suspect, and a suspect message is held from every
 * agent with tools until a review decides (review.ts). A check that could not run holds it too: unchecked is never
 * clean.
 */
export interface SafetyFindings {
  /** Signals in the visible text that nothing innocent produces (Okolos's strong tier). */
  visibleStrong: SignalName[];
  /** Any signal in text a person does not see: hidden text addressing a model is never ordinary. */
  hiddenSignals: SignalName[];
  /** The hidden text, quoted for the person and the review (at most HIDDEN_CHARS). */
  hidden: string;
  /** The light model said the text tries to steer an AI. */
  model: boolean;
  /** The model could not answer; the message is held as unchecked. */
  modelError?: string;
  /** B-180: links to sites the Okolos phishing feed lists, by host. */
  phishing?: { host: string; entry: string }[];
  /** B-180: links whose host imitates a well-known or the server's own name (Okolos's lookalike check). */
  lookalikes?: { host: string; resembles: string; kind: string }[];
  /** B-180: the server had no copy of the feed (`missing`), or one not updated for a day (`stale`). */
  feed?: "missing" | "stale";
  /** B-179: signals in the text of its attached documents (any signal, as for hidden text). */
  fileSignals?: SignalName[];
  /** B-179: attached files that run code, by name. */
  riskyFiles?: string[];
  /** B-179: attached documents whose text could not be read, by name. */
  unreadFiles?: string[];
  /** S03 (B-269): files whose bytes are a program under a name that is not one (a renamed program), by name. */
  disguisedFiles?: string[];
  /** S03 (B-269, B-222): the six checks, their files and links, and the review of mail that is not held. */
  check?: MailCheck;
}

export type SafetyScan = (text: string) => Promise<{ flagged: boolean; error?: string }>;

/** What the check reads: the message as HTML (a text-only message escaped into HTML) and its subject. */
export interface SafetyInput { subject: string; html: string; /** B-179: the text of its attached documents. */ files?: string }

const MODEL_CHARS = 16_000;

export async function inspectMessage(input: SafetyInput, scan: SafetyScan): Promise<SafetyFindings> {
  const { visible, hidden } = splitHidden(input.html || "");
  const shown = `${input.subject}\n${visible}`;
  const v = analyse(shown);
  const h = hidden ? analyse(hidden) : { signals: [] as SignalName[] };
  const files = input.files?.trim() ?? "";
  const f = files ? analyse(files) : { signals: [] as SignalName[] };
  let forModel = hidden ? `${shown.slice(0, MODEL_CHARS / 2)}\n\n[Text the reader does not see]\n${hidden.slice(0, MODEL_CHARS / 2)}` : shown.slice(0, MODEL_CHARS);
  // B-179: an attached document's text is read like hidden text: the model sees a part of it beside the body.
  if (files) forModel = `${forModel.slice(0, (MODEL_CHARS * 2) / 3)}\n\n[Text of the attached files]\n${files.slice(0, MODEL_CHARS / 3)}`;
  const result = await scan(forModel).catch((error: unknown) => ({ flagged: false, error: (error as Error)?.message ?? "failed" }));
  return {
    visibleStrong: [...v.strong],
    hiddenSignals: [...h.signals],
    hidden: hidden.slice(0, HIDDEN_CHARS),
    model: !!result.flagged && !result.error,
    ...(result.error ? { modelError: result.error.slice(0, 200) } : {}),
    ...(f.signals.length ? { fileSignals: [...f.signals] } : {}),
  };
}

/** Suspect: held until reviewed. S03: a renamed program, found by its bytes, holds it like one found by its name. */
export function suspect(f: SafetyFindings): boolean {
  return f.visibleStrong.length > 0 || f.hiddenSignals.length > 0 || f.model || !!f.modelError || !!f.phishing?.length
    || !!f.lookalikes?.length || !!f.riskyFiles?.length || !!f.fileSignals?.length || !!f.disguisedFiles?.length;
}

/**
 * S03 §3 (round 5, KIMI-32): the held review may release a message only when the light model's YES was its sole
 * reason. Any Okolos signal, a listed or lookalike link, or a file that runs code waits for a person; so does any
 * signal of the six checks other than the light model's own (K-4: an enforcing DMARC fail, a lookalike From, a link
 * whose text names another domain, a risky file).
 */
export function modelOnly(f: SafetyFindings): boolean {
  const check = f.check;
  const checksQuiet = !check || (check.signals.every((s) => s.code === "inboxModelFlagged")
    && !check.links.some((l) => !!l.why) && !check.files.some((x) => x.colour === "red" || x.colour === "amber"));
  return f.model && !f.modelError && !f.visibleStrong.length && !f.hiddenSignals.length && !f.fileSignals?.length && !f.phishing?.length
    && !f.lookalikes?.length && !f.riskyFiles?.length && !f.disguisedFiles?.length && checksQuiet;
}
