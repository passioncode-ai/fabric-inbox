/**
 * What the Add address dialog decides before it renders (SCN-061…065): the domain choice with each
 * domain's state, what the address field says as you type, the request it sends, and one line per
 * step of what Create did. Plain module, no `~/` imports: the tests load it directly. Functions that
 * produce words take the interface's translator (`t`, English by default); words the server or
 * shared/address-name.ts wrote go through `t.text()` where a sentence here carries them.
 */
import type { AddressCheck, AddressStep, AgentInput, DomainState, NameCheck, StepFix, TestStatus } from "../../../services/agents";
import type { DomainList, Step } from "../../../services/domains";
import { checkLocalPart, suggestDisplayName, type LocalPartCheck } from "../../../../shared/address-name";
import { englishT, type T } from "../../../../shared/i18n";
import { ADD_ADDRESS_TEXT, addAddressText } from "./add-address-text";

export type Tone = "ok" | "warn" | "bad" | "neutral";

/* ---------------------------------------------------------------- domains */

/** Each domain state's word and tone, in the language of `t`. */
export function domainStates(t: T = englishT): Record<DomainState, { label: string; tone: Tone }> {
  const X = addAddressText(t);
  return {
    receiving: { label: X.stateReceiving, tone: "ok" },
    // Without a token every domain is the same: its line under the choice says no rule can be made.
    no_token: { label: X.stateReceiving, tone: "ok" },
    can_receive: { label: X.stateCanReceive, tone: "neutral" },
    needs_fix: { label: X.stateNeedsFix, tone: "bad" },
    not_visible: { label: X.stateNotVisible, tone: "warn" },
    unknown: { label: X.stateUnknown, tone: "warn" },
    unavailable: { label: X.stateUnavailable, tone: "bad" },
  };
}
export const DOMAIN_STATE = domainStates();

export interface DomainOption {
  domain: string;
  group: "receiving" | "can_receive";
  state: DomainState;
  label: string;
  tone: Tone;
  /** The Cloudflare account, when the person has several. */
  account: string | null;
}

/** The two groups of the domain choice, in the language of `t`. */
export function domainGroups(t: T = englishT) {
  const X = addAddressText(t);
  return [{ id: "receiving", label: X.stateReceiving }, { id: "can_receive", label: X.stateCanReceive }] as const;
}

/**
 * Every domain an address can be created on: the ones receiving here, then (with a token) the other
 * domains of the shown Cloudflare accounts. `learned` holds states read by a check since the dialog
 * opened (a domain found to need fixing says so in the list too).
 */
export function domainOptions(list: DomainList | undefined, learned: Record<string, DomainState> = {}, t: T = englishT): DomainOption[] {
  if (!list) return [];
  const states = domainStates(t);
  const several = list.accounts.filter((a) => a.shown).length > 1;
  const options = list.domains.flatMap((d): DomainOption[] => {
    const base = { domain: d.domain, account: several ? d.account?.name ?? null : null };
    if (d.served) {
      const state = learned[d.domain] ?? (!list.connected ? "no_token" : d.zoneId ? "receiving" : "not_visible");
      return [{ ...base, group: "receiving", state, ...states[state] }];
    }
    if (!list.connected || !d.zoneId) return [];
    const state = learned[d.domain] ?? "can_receive";
    return [{ ...base, group: "can_receive", state, ...states[state] }];
  });
  return options.sort((a, b) => Number(a.group !== "receiving") - Number(b.group !== "receiving") || a.domain.localeCompare(b.domain));
}

/** The options a typed filter keeps ("@acme" finds acme.test); an empty filter keeps them all. */
export function filterDomains(options: DomainOption[], query: string): DomainOption[] {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  return q ? options.filter((o) => o.domain.includes(q)) : options;
}

/** The domain the dialog opens on: the one its entry point named, else the first receiving here. */
export function startDomain(options: DomainOption[], wanted: string | null): string {
  const w = wanted?.trim().toLowerCase();
  return options.find((o) => o.domain === w)?.domain ?? options.find((o) => o.group === "receiving")?.domain ?? options[0]?.domain ?? "";
}

/* -------------------------------------------------------- the address field */

export interface NameView {
  tone: Tone;
  /** One sentence under the field, announced as it changes. */
  text: string;
  canCreate: boolean;
  notes: string[];
}

/** The hint under an empty field, in English (`addAddressText(t).nameHint` in the interface's language). */
export const NAME_HINT = ADD_ADDRESS_TEXT.nameHint;

/** What the field says as the person types: the local check at once, then the server's. */
export function nameView(local: LocalPartCheck, check: NameCheck | undefined, checking: boolean, checkFailed: boolean, t: T = englishT): NameView {
  const X = addAddressText(t);
  if (!local.value) return { tone: "neutral", text: X.nameHint, canCreate: false, notes: [] };
  if (!local.valid) return { tone: "bad", text: t.text(local.problem!), canCreate: false, notes: [] };
  const own = local.note ? [t.text(local.note)] : [];
  if (checkFailed && !check)
    return { tone: "warn", text: X.checkFailed, canCreate: true, notes: own };
  if (!check || check.localPart !== local.value) return { tone: "neutral", text: checking ? X.checking : X.nameHint, canCreate: false, notes: own };
  switch (check.status) {
    case "available": return { tone: "ok", text: X.isFree(check.email), canCreate: true, notes: check.notes.map((n) => t.text(n)) };
    case "exists": return { tone: "bad", text: t.text(check.detail), canCreate: false, notes: [] };
    default: return { tone: "bad", text: t.text(check.detail), canCreate: false, notes: check.notes.map((n) => t.text(n)) };
  }
}

/* ------------------------------------------------------------- the settings */

export function policySummary(agent: AgentInput, t: T = englishT) {
  const X = addAddressText(t);
  const p = agent.replyPolicy;
  if (p.mode === "draft") return X.policyDraft;
  return X.policyAuto(p.allowedIntents.length ? p.allowedIntents.join(", ") : X.policyAnyAnswer, p.dailySendLimit);
}

/** The one line under Who answers: what the agent is told to do, and what it may send. */
export function agentLine(agent: AgentInput, t: T = englishT): string {
  const text = agent.instructions.replace(/\s+/g, " ").trim();
  const first = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  const clipped = first.length > 110 ? first.slice(0, 109).trimEnd() + "…" : first;
  return [clipped, policySummary(agent, t)].filter(Boolean).join(" · ");
}

export interface AddressForm {
  domain: string;
  localPart: string;
  displayName: string;
  /** False while the display name follows the name typed. */
  displayNameEdited: boolean;
  signatureOn: boolean;
  signature: string;
  agent: string;
  copy: string;
  makeRule: boolean;
}

/** The display name shown: the person's own once edited, else the one suggested from the name. */
export const displayNameOf = (form: Pick<AddressForm, "displayName" | "displayNameEdited" | "localPart">) =>
  form.displayNameEdited ? form.displayName : suggestDisplayName(checkLocalPart(form.localPart).value);

const settingsOf = (form: AddressForm) => ({
  agent: form.agent === "off" ? ("off" as const) : { id: form.agent },
  ...(form.signatureOn && form.signature.trim() ? { signature: { enabled: true, text: form.signature } } : {}),
  createRoute: form.makeRule ? ("auto" as const) : false,
  ...(form.copy ? { forwardTo: form.copy } : {}),
});

/** POST /api/project-addresses */
export function createBody(form: AddressForm) {
  const name = displayNameOf(form).trim();
  return { localPart: checkLocalPart(form.localPart).value, domain: form.domain, ...(name ? { name } : {}), ...settingsOf(form) };
}

/** POST /api/project-addresses/batch: each address its own display name unless one is typed for all. */
export function batchBody(form: AddressForm, localParts: string[]) {
  const name = form.displayNameEdited ? form.displayName.trim() : "";
  return { domain: form.domain, localParts, ...(name ? { name } : {}), ...settingsOf(form) };
}

/* -------------------------------------------------------------- the steps */

export type UiOutcome = AddressStep["outcome"] | "waiting" | "running" | "not_asked";
/** One step; a step the server reported keeps the server's words (shown through `t.text()`). */
export interface UiStep { id: string; label: string; outcome: UiOutcome; detail: string; fix?: StepFix }

/** Each outcome's mark, in the language of `t`. */
export const stepMark = (t: T = englishT): Record<UiOutcome, string> => addAddressText(t).mark;
export const STEP_MARK: Record<UiOutcome, string> = stepMark();

/** The first step on a domain that does not receive here yet (SCN-063). */
export function receiveStep(domain: string, state: { running: boolean; steps: Step[] | null; foreignMx: string[] | null; error: string | null }, t: T = englishT): UiStep {
  const X = addAddressText(t);
  const label = X.stepReceive(domain);
  if (state.running) return { id: "receive", label, outcome: "running", detail: X.receiveRunning };
  if (state.foreignMx) return { id: "receive", label, outcome: "waiting",
    detail: X.receiveMx(domain, [...new Set(state.foreignMx)].join(", ")) };
  const failed = state.steps?.find((s) => s.outcome === "failed");
  if (failed) return { id: "receive", label, outcome: "failed", detail: X.receiveFailed(failed.label, failed.detail) };
  if (state.error) return { id: "receive", label, outcome: "failed", detail: X.receiveError(state.error) };
  const changed = state.steps?.some((s) => s.outcome === "done");
  return { id: "receive", label, outcome: changed ? "done" : "already", detail: X.receiveDone(domain, !!changed) };
}

export type TestPhase = "off" | "sending" | "sent" | "error";

const clock = (iso: string, t: T) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : t.time(d, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

/** The test message's line: sent, waiting for it, arrived, or why not (SCN-062). */
export function testStep(phase: TestPhase, test: TestStatus | null, error?: string, t: T = englishT): UiStep {
  const X = addAddressText(t);
  const label = X.stepTest;
  if (phase === "off") return { id: "test", label, outcome: "not_asked", detail: X.testOff };
  if (phase === "sending") return { id: "test", label, outcome: "running", detail: X.testSending };
  if (phase === "error") return { id: "test", label, outcome: "failed", detail: error === undefined ? X.testCouldNot : t.text(error) };
  if (!test) return { id: "test", label, outcome: "waiting", detail: X.testSent };
  if (test.state === "arrived")
    return { id: "test", label, outcome: "done", detail: X.testArrived(clock(test.arrivedAt ?? "", t), test.folder && test.folder !== "inbox" ? test.folder : null) };
  if (test.state === "waiting") return { id: "test", label, outcome: "waiting", detail: X.testWaiting(test.detail) };
  return { id: "test", label, outcome: "failed", detail: t.text(test.detail) };
}

export const TEST_POLL_MS = 5_000;
export const testWaiting = (test: TestStatus | null | undefined) => !test || test.state === "waiting";

/** One sentence for the dialog's live status and the toast. */
export function stepsSentence(email: string, steps: UiStep[], t: T = englishT): string {
  const X = addAddressText(t);
  const failed = steps.find((s) => s.outcome === "failed");
  const address = steps.find((s) => s.id === "address");
  if (!address || address.outcome === "failed") return X.sentenceNotCreated(email, failed?.detail ?? "");
  if (failed) return X.sentencePartly(email, failed.label, failed.fix?.label ?? null);
  if (steps.some((s) => s.outcome === "running" || s.outcome === "waiting")) return X.sentenceWaiting(email);
  const test = steps.find((s) => s.id === "test");
  return test?.outcome === "done" ? X.sentenceReady(email) : X.sentenceCreated(email);
}
