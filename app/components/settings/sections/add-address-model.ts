/**
 * What the Add address dialog decides before it renders (SCN-061…065): the domain choice with each
 * domain's state, what the address field says as you type, the request it sends, and one line per
 * step of what Create did. Plain module, no `~/` imports: the tests load it directly.
 */
import type { AddressCheck, AddressStep, AgentInput, DomainState, NameCheck, StepFix, TestStatus } from "../../../services/agents";
import type { DomainList, Step } from "../../../services/domains";
import { checkLocalPart, suggestDisplayName, type LocalPartCheck } from "../../../../shared/address-name";
import { ADD_ADDRESS_TEXT as T } from "./add-address-text";

export type Tone = "ok" | "warn" | "bad" | "neutral";

/* ---------------------------------------------------------------- domains */

export const DOMAIN_STATE: Record<DomainState, { label: string; tone: Tone }> = {
  receiving: { label: T.stateReceiving, tone: "ok" },
  // Without a token every domain is the same: its line under the choice says no rule can be made.
  no_token: { label: T.stateReceiving, tone: "ok" },
  can_receive: { label: T.stateCanReceive, tone: "neutral" },
  needs_fix: { label: T.stateNeedsFix, tone: "bad" },
  not_visible: { label: T.stateNotVisible, tone: "warn" },
  unknown: { label: T.stateUnknown, tone: "warn" },
  unavailable: { label: T.stateUnavailable, tone: "bad" },
};

export interface DomainOption {
  domain: string;
  group: "receiving" | "can_receive";
  state: DomainState;
  label: string;
  tone: Tone;
  /** The Cloudflare account, when the person has several. */
  account: string | null;
}

export const DOMAIN_GROUPS = [{ id: "receiving", label: T.stateReceiving }, { id: "can_receive", label: T.stateCanReceive }] as const;

/**
 * Every domain an address can be created on: the ones receiving here, then (with a token) the other
 * domains of the shown Cloudflare accounts. `learned` holds states read by a check since the dialog
 * opened (a domain found to need fixing says so in the list too).
 */
export function domainOptions(list: DomainList | undefined, learned: Record<string, DomainState> = {}): DomainOption[] {
  if (!list) return [];
  const several = list.accounts.filter((a) => a.shown).length > 1;
  const options = list.domains.flatMap((d): DomainOption[] => {
    const base = { domain: d.domain, account: several ? d.account?.name ?? null : null };
    if (d.served) {
      const state = learned[d.domain] ?? (!list.connected ? "no_token" : d.zoneId ? "receiving" : "not_visible");
      return [{ ...base, group: "receiving", state, ...DOMAIN_STATE[state] }];
    }
    if (!list.connected || !d.zoneId) return [];
    const state = learned[d.domain] ?? "can_receive";
    return [{ ...base, group: "can_receive", state, ...DOMAIN_STATE[state] }];
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

export const NAME_HINT = T.nameHint;

/** What the field says as the person types: the local check at once, then the server's. */
export function nameView(local: LocalPartCheck, check: NameCheck | undefined, checking: boolean, checkFailed: boolean): NameView {
  if (!local.value) return { tone: "neutral", text: NAME_HINT, canCreate: false, notes: [] };
  if (!local.valid) return { tone: "bad", text: local.problem!, canCreate: false, notes: [] };
  const own = local.note ? [local.note] : [];
  if (checkFailed && !check)
    return { tone: "warn", text: T.checkFailed, canCreate: true, notes: own };
  if (!check || check.localPart !== local.value) return { tone: "neutral", text: checking ? T.checking : NAME_HINT, canCreate: false, notes: own };
  switch (check.status) {
    case "available": return { tone: "ok", text: T.isFree(check.email), canCreate: true, notes: check.notes };
    case "exists": return { tone: "bad", text: check.detail, canCreate: false, notes: [] };
    default: return { tone: "bad", text: check.detail, canCreate: false, notes: check.notes };
  }
}

/* ------------------------------------------------------------- the settings */

export function policySummary(agent: AgentInput) {
  const p = agent.replyPolicy;
  if (p.mode === "draft") return T.policyDraft;
  return T.policyAuto(p.allowedIntents.length ? p.allowedIntents.join(", ") : T.policyAnyAnswer, p.dailySendLimit);
}

/** The one line under Who answers: what the agent is told to do, and what it may send. */
export function agentLine(agent: AgentInput): string {
  const text = agent.instructions.replace(/\s+/g, " ").trim();
  const first = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  const clipped = first.length > 110 ? first.slice(0, 109).trimEnd() + "…" : first;
  return [clipped, policySummary(agent)].filter(Boolean).join(" · ");
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
export interface UiStep { id: string; label: string; outcome: UiOutcome; detail: string; fix?: StepFix }

export const STEP_MARK: Record<UiOutcome, string> = T.mark;

/** The outcomes whose step offers its one fix beside it (SCN-065). */
export const FIXABLE = new Set<UiOutcome>(["failed", "skipped", "not_receiving"]);

/** The first step on a domain that does not receive here yet (SCN-063). */
export function receiveStep(domain: string, state: { running: boolean; steps: Step[] | null; foreignMx: string[] | null; error: string | null }): UiStep {
  const label = T.stepReceive(domain);
  if (state.running) return { id: "receive", label, outcome: "running", detail: T.receiveRunning };
  if (state.foreignMx) return { id: "receive", label, outcome: "waiting",
    detail: T.receiveMx(domain, [...new Set(state.foreignMx)].join(", ")) };
  const failed = state.steps?.find((s) => s.outcome === "failed");
  if (failed) return { id: "receive", label, outcome: "failed", detail: T.receiveFailed(failed.label, failed.detail) };
  if (state.error) return { id: "receive", label, outcome: "failed", detail: T.receiveError(state.error) };
  const changed = state.steps?.some((s) => s.outcome === "done");
  return { id: "receive", label, outcome: changed ? "done" : "already", detail: T.receiveDone(domain, !!changed) };
}

export type TestPhase = "off" | "sending" | "sent" | "error";

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

/** The test message's line: sent, waiting for it, arrived, or why not (SCN-062). */
export function testStep(phase: TestPhase, test: TestStatus | null, error?: string): UiStep {
  const label = T.stepTest;
  if (phase === "off") return { id: "test", label, outcome: "not_asked", detail: T.testOff };
  if (phase === "sending") return { id: "test", label, outcome: "running", detail: T.testSending };
  if (phase === "error") return { id: "test", label, outcome: "failed", detail: error ?? T.testCouldNot };
  if (!test) return { id: "test", label, outcome: "waiting", detail: T.testSent };
  if (test.state === "arrived")
    return { id: "test", label, outcome: "done", detail: T.testArrived(clock(test.arrivedAt ?? ""), test.folder && test.folder !== "inbox" ? test.folder : null) };
  if (test.state === "waiting") return { id: "test", label, outcome: "waiting", detail: T.testWaiting(test.detail) };
  return { id: "test", label, outcome: "failed", detail: test.detail };
}

export const TEST_POLL_MS = 5_000;
export const testWaiting = (test: TestStatus | null | undefined) => !test || test.state === "waiting";

/** One sentence for the dialog's live status and the toast. */
export function stepsSentence(email: string, steps: UiStep[]): string {
  const failed = steps.find((s) => s.outcome === "failed");
  const address = steps.find((s) => s.id === "address");
  if (!address || address.outcome === "failed") return T.sentenceNotCreated(email, failed?.detail ?? "");
  if (failed) return T.sentencePartly(email, failed.label, failed.fix?.label ?? null);
  const notReceiving = steps.find((s) => s.outcome === "not_receiving");
  if (notReceiving) return T.sentenceNotReceiving(email, notReceiving.fix?.label ?? null);
  if (steps.some((s) => s.outcome === "running" || s.outcome === "waiting")) return T.sentenceWaiting(email);
  const test = steps.find((s) => s.id === "test");
  return test?.outcome === "done" ? T.sentenceReady(email) : T.sentenceCreated(email);
}
