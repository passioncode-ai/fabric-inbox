import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CaretDownIcon } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { fabric } from "~/services/fabric";
import { ApiError } from "~/services/api";
import type { AddressCheck, AgentList, BatchResult, CreatedAddress, DomainState, ProjectAddresses, RoutingStatus, StepFix, TestStatus } from "~/services/agents";
import type { DomainList, StepsResult } from "~/services/domains";
import { checkLocalPart, parseLocalParts } from "../../../../shared/address-name";
import { settingsPath } from "../paths";
import { Badge, Dialog, errorText, useNotify } from "../ui";
import { refreshMail, useDestinations } from "./data";
import {
  DOMAIN_GROUPS, FIXABLE, NAME_HINT, STEP_MARK, TEST_POLL_MS, agentLine, answerLost, batchBody, continueBatch, createBody, displayNameOf, domainOptions, filterDomains, lostAnswerRows,
  nameView, receiveStep, startDomain, stepsSentence, testStep, testWaiting, type AddressForm, type DomainOption, type TestPhase, type UiStep,
} from "./add-address-model";
import { ADD_ADDRESS_TEXT as T } from "./add-address-text";

/**
 * Add address (SCN-021, SCN-061…065): one calm dialog for every entry point. A dialog rather than a
 * panel because it is a short task started from five places (the Addresses toolbar, a domain's
 * panel, the sidebar, an empty list, a missing address's name) and it must not move the list behind
 * it; after Create the same surface shows what happened, step by step, until the test arrives.
 */

const localOf = (email: string) => email.slice(0, email.lastIndexOf("@"));

/** A value that settles once the person stops typing. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const t = setTimeout(() => setSettled(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return settled;
}

interface Row {
  email: string;
  created: boolean;
  steps: UiStep[];
  test: TestPhase;
  testError?: string;
}
interface Run {
  receive: UiStep | null;
  rows: Row[];
  /** Still creating; the step list is final once false. */
  working: boolean;
}

const EMPTY_FORM = (domain: string, localPart = ""): AddressForm => ({
  domain, localPart, displayName: "", displayNameEdited: false, signatureOn: false, signature: "", agent: "off", copy: "", makeRule: true,
});

export default function AddAddressDialog({ open, onClose, list, agents, data, initialDomain, initialName, onCreated }: {
  open: boolean; onClose: () => void; list?: DomainList; agents?: AgentList; data?: ProjectAddresses;
  initialDomain: string | null; initialName: string | null;
  /** The new address is selected behind the dialog as soon as it exists. */
  onCreated: (email: string) => void;
}) {
  const client = useQueryClient();
  const notify = useNotify();
  const [learned, setLearned] = useState<Record<string, DomainState>>({});
  const options = useMemo(() => domainOptions(list, learned), [list, learned]);
  const [mode, setMode] = useState<"one" | "several">("one");
  const [form, setForm] = useState<AddressForm>(EMPTY_FORM(""));
  const [several, setSeveral] = useState("");
  const [sendTest, setSendTest] = useState<boolean | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const ids = { name: useId(), nameMsg: useId(), domain: useId(), domainMsg: useId(), names: useId(), live: useId() };
  const ready = open && options.length > 0;

  // The form starts over each time the dialog opens, once the domains are known (a link may name one).
  useEffect(() => {
    if (!ready) return;
    setForm(EMPTY_FORM(startDomain(options, initialDomain), initialName ?? ""));
    setSeveral(""); setMode("one"); setSendTest(null); setRun(null);
    // The form may arrive after the dialog opened (domains still loading): the focus goes to it then.
    requestAnimationFrame(() => nameField.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const set = <K extends keyof AddressForm>(key: K, value: AddressForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const option = options.find((o) => o.domain === form.domain);
  const summary = list?.domains.find((d) => d.domain === form.domain);
  const connected = !!list?.connected;

  /* ---- the live check: the domain's state and every name typed, read once they settle ---- */
  const parsed = useMemo(() => parseLocalParts(several, form.domain), [several, form.domain]);
  const local = checkLocalPart(form.localPart);
  const wanted = mode === "one" ? (local.valid ? [local.value] : []) : parsed.entries.filter((e) => e.check.valid).map((e) => e.check.value);
  const settled = useSettled(`${form.domain}|${wanted.join(",")}`, 350);
  const [checkDomain, checkNames] = settled.split("|") as [string, string];
  const check = useQuery({
    queryKey: ["address-check", checkDomain, checkNames], enabled: open && !!checkDomain && !run, staleTime: 15_000, retry: false,
    queryFn: () => fabric<AddressCheck>(`/api/project-addresses/check?domain=${encodeURIComponent(checkDomain)}&names=${encodeURIComponent(checkNames)}`),
  });
  const fresh = check.data?.domain === form.domain ? check.data : undefined;
  const checking = settled !== `${form.domain}|${wanted.join(",")}` || check.isFetching;
  useEffect(() => {
    const d = check.data;
    if (d && learned[d.domain] !== d.state) setLearned((l) => ({ ...l, [d.domain]: d.state }));
  }, [check.data, learned]);

  const nameCheck = fresh?.names.find((n) => n.localPart === local.value);
  const view = nameView(local, nameCheck, checking, check.isError);
  const testDefault = !!fresh?.sendTestDefault;
  const testing = sendTest ?? testDefault;
  const canMakeRule = fresh ? fresh.rule.canMake : connected && !!summary?.zoneId;
  const state = fresh?.state ?? option?.state;
  const blocked = state === "unavailable";
  const needsReceive = !!option && option.group === "can_receive";

  const destinations = useDestinations(open && connected && !!summary?.account, summary?.account && !summary.account.server ? summary.account.id : undefined);
  const confirmed = destinations.data?.filter((d) => d.verified) ?? [];
  const unknown = (data?.unknownRecipients ?? []).filter((u) => u.domain === form.domain).slice(0, 5);
  const chosenAgent = agents?.agents.find((a) => a.id === form.agent);

  const severalRows = parsed.entries.map((e) => {
    const c = fresh?.names.find((n) => n.localPart === e.check.value);
    return { input: e.input, value: e.check.value, view: nameView(e.check, c, checking, check.isError) };
  });
  const creatable = mode === "one" ? (view.canCreate ? [local.value] : []) : severalRows.filter((r) => r.view.canCreate).map((r) => r.value);
  const canSubmit = !blocked && !!form.domain && creatable.length > 0 && !checking;
  const email = local.value ? `${local.value}@${form.domain}` : "";
  const submitLabel = mode === "one" ? (email && view.canCreate ? T.create(email) : T.createOne) : T.createSeveral(creatable.length);

  /* ---- Create, and what follows ---- */
  const updateRow = (target: string, change: (row: Row) => Row) =>
    setRun((r) => (r ? { ...r, rows: r.rows.map((row) => (row.email === target ? change(row) : row)) } : r));

  async function receive(replaceMx: boolean): Promise<boolean> {
    setRun((r) => ({ receive: receiveStep(form.domain, { running: true, steps: null, foreignMx: null, error: null }), rows: r?.rows ?? [], working: true }));
    try {
      const r = await fabric<StepsResult>(`/api/domains/${encodeURIComponent(form.domain)}/connect`, { replaceMx });
      setRun((x) => x && { ...x, receive: receiveStep(form.domain, { running: false, steps: r.steps, foreignMx: null, error: null }) });
      return true;
    } catch (error) {
      const body = (error instanceof ApiError ? error.body : {}) as Partial<StepsResult>;
      const step = receiveStep(form.domain, { running: false, steps: body.steps ?? null, foreignMx: body.needsConfirmation?.foreignMx ?? null, error: body.steps ? null : errorText(error) });
      setRun((x) => x && { ...x, receive: step, working: false });
      return false;
    } finally { await refreshMail(client, form.domain); }
  }

  async function sendTestTo(target: string) {
    updateRow(target, (row) => ({ ...row, test: "sending", testError: undefined }));
    try {
      await fabric(`/api/project-addresses/${encodeURIComponent(target)}/test`, {});
      await client.invalidateQueries({ queryKey: ["routing-test", target] });
      updateRow(target, (row) => ({ ...row, test: "sent" }));
    } catch (error) {
      updateRow(target, (row) => ({ ...row, test: "error", testError: errorText(error) }));
    }
  }

  /** After an answer that did not arrive: which of these names exist now, and their rules, read again. */
  async function readBack(localParts: string[], why: string): Promise<Row[]> {
    const check = await fabric<AddressCheck>(`/api/project-addresses/check?domain=${encodeURIComponent(form.domain)}&names=${encodeURIComponent(localParts.join(","))}`).catch(() => null);
    const found = check?.names.filter((n) => n.status === "exists").map((n) => n.email) ?? [];
    const routing = Object.fromEntries(await Promise.all(found.map(async (e) =>
      [e, await fabric<RoutingStatus>(`/api/project-addresses/${encodeURIComponent(e)}/routing`).catch(() => null)] as const)));
    return lostAnswerRows(email || form.domain, localParts, check, routing, why)
      .map((r): Row => ({ ...r, test: r.created && testing ? "sending" : "off" }));
  }

  async function createAll() {
    const stepFor = (detail: string): UiStep => ({ id: "address", label: T.stepAddress, outcome: "failed", detail });
    let rows: Row[] = [];
    // The names not yet answered for: all of them at first, then what the server handed back (SCN-064).
    let pending = mode === "one" ? [local.value] : creatable;
    try {
      if (mode === "one") {
        const r = await fabric<CreatedAddress>("/api/project-addresses", createBody(form));
        rows = [{ email: r.email, created: true, steps: r.steps, test: testing ? "sending" : "off" }];
      } else {
        while (pending.length) {
          const r = await fabric<BatchResult>("/api/project-addresses/batch", batchBody(form, pending));
          rows = [...rows, ...r.results.map((x): Row => ({ email: x.email, created: x.status === 201, test: x.status === 201 && testing ? "sending" : "off",
            steps: x.status === 201 && x.steps ? x.steps : [stepFor(x.error ?? T.notCreated)] }))];
          pending = continueBatch(pending, r);
          if (pending.length) { const shown = rows; setRun((x) => ({ receive: x?.receive ?? null, rows: shown, working: true })); }
        }
      }
    } catch (error) {
      // An answer that may have been lost is never "Nothing was created": what exists is read again.
      rows = answerLost(error instanceof ApiError ? error.status : null)
        ? [...rows, ...(await readBack(pending, errorText(error)))]
        : [...rows, { email: mode === "one" ? email : form.domain, created: false, steps: [stepFor(errorText(error) + T.nothingCreated)], test: "off" }];
    } finally { await refreshMail(client, form.domain); }
    setRun((x) => ({ receive: x?.receive ?? null, rows, working: false }));
    const made = rows.filter((r) => r.created);
    if (made[0]) onCreated(made[0].email);
    notify(mode === "one" ? stepsSentence(rows[0]!.email, rows[0]!.steps) : T.createdToast(made.length, rows.length, form.domain),
      made.length ? "ok" : "error");
    for (const row of made) if (testing) await sendTestTo(row.email);
  }

  async function submit() {
    if (!canSubmit) return;
    setRun({ receive: null, rows: [], working: true });
    if (needsReceive && !(await receive(false))) return;
    await createAll();
  }

  async function fix(row: Row, f: StepFix) {
    const rule = (outcome: UiStep["outcome"], detail: string, keep?: StepFix): UiStep => ({ id: "rule", label: T.stepRule, outcome, detail, fix: keep });
    const put = (step: UiStep) => updateRow(row.email, (r) => ({ ...r, steps: r.steps.map((s) => (s.id === "rule" ? step : s)) }));
    put(rule("running", T.working));
    try {
      if (f.action === "open_domain") await fabric<StepsResult>(`/api/domains/${encodeURIComponent(form.domain)}/connect`, { replaceMx: false });
      const status = f.action === "route_here"
        ? await fabric<RoutingStatus>(`/api/project-addresses/${encodeURIComponent(row.email)}/routing`, {})
        : await fabric<RoutingStatus>(`/api/project-addresses/${encodeURIComponent(row.email)}/routing`);
      put(rule(status.state === "verified" ? "done" : "failed", status.detail, status.state === "verified" ? undefined : f));
    } catch (error) {
      put(rule("failed", errorText(error), f));
    } finally { await refreshMail(client, form.domain); }
  }

  const again = () => {
    setForm((f) => ({ ...EMPTY_FORM(f.domain), agent: f.agent, copy: f.copy, signatureOn: f.signatureOn, signature: f.signature, makeRule: f.makeRule }));
    setSeveral(""); setRun(null);
    requestAnimationFrame(() => nameField.current?.focus());
  };

  const finished = !!run && !run.working && run.rows.some((r) => r.created);
  const title = !run ? T.title
    : mode === "one" ? (finished ? T.titleAdded : T.titleAdding)(run.rows[0]?.email ?? email)
      : (finished ? T.titleAddedSeveral : T.titleAddingSeveral)(form.domain);
  const working = !!run?.working;

  return (
    <Dialog open={open} title={title} onClose={onClose} busy={working} wide
      restoreFocus={() => (run?.rows.some((r) => r.created) ? document.querySelector<HTMLElement>(".fi-section-panel .fi-panel-head h2") : null)}>
      {!options.length ? (
        <p>{T.noDomain} <Link to={settingsPath("domains")}>{T.chooseOnDomains}</Link>{T.noDomainAfter}</p>
      ) : run ? (
        <RunView run={run} mode={mode} domain={form.domain} onFix={fix} onTest={sendTestTo}
          onReplace={async () => { if (await receive(true)) await createAll(); }}
          onBack={() => setRun(null)} onAgain={again} onDone={onClose} />
      ) : (
        <form className="fi-add-address" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="fi-segmented" role="radiogroup" aria-label={T.modeGroup}>
            {(["one", "several"] as const).map((m) => (
              <label key={m} className={mode === m ? "is-current" : undefined}>
                <input type="radio" name="add-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                {m === "one" ? T.modeOne : T.modeSeveral}
              </label>
            ))}
          </div>

          {mode === "one" ? (
            <div className="fi-field">
              <label htmlFor={ids.name}>{T.addressLabel}</label>
              <div className="fi-address-row">
                <input ref={nameField} id={ids.name} className="fi-input" data-autofocus value={form.localPart} placeholder={T.addressPlaceholder}
                  autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={80}
                  aria-invalid={view.tone === "bad"} aria-describedby={`${ids.nameMsg} ${ids.domainMsg}`}
                  onChange={(e) => set("localPart", e.target.value)} />
                <span className="fi-address-at" aria-hidden="true">@</span>
                <DomainPicker id={ids.domain} options={options} value={form.domain} describedBy={ids.domainMsg}
                  onChange={(d) => setForm((f) => ({ ...f, domain: d, copy: "" }))} />
              </div>
              <p id={ids.nameMsg} className={`fi-field-message is-${view.tone}`} aria-live="polite">
                {email && view.tone !== "bad" && view.text !== NAME_HINT && view.tone !== "ok" ? <span className="fi-address-preview">{email} · </span> : null}
                {view.text}
              </p>
              {view.notes.map((n) => <p key={n} className="fi-hint fi-field-note">{n}</p>)}
              {view.tone === "bad" && nameCheck?.status === "exists" && (
                <Link className="fi-text-button" to={settingsPath("addresses", nameCheck.email)} onClick={onClose}>{T.openExisting(nameCheck.email)}</Link>
              )}
            </div>
          ) : (
            <>
              <div className="fi-field">
                <label htmlFor={ids.domain}>{T.domainLabel}</label>
                <DomainPicker id={ids.domain} options={options} value={form.domain} describedBy={ids.domainMsg}
                  onChange={(d) => setForm((f) => ({ ...f, domain: d, copy: "" }))} />
              </div>
              <div className="fi-field">
                <label htmlFor={ids.names}>{T.namesLabel}</label>
                <textarea id={ids.names} className="fi-input" data-autofocus rows={4} value={several} placeholder={T.namesPlaceholder}
                  spellCheck={false} aria-describedby={ids.live} onChange={(e) => setSeveral(e.target.value)} />
                <span className="fi-hint">{T.namesHint}</span>
              </div>
              {(severalRows.length > 0 || parsed.skipped.length > 0) && (
                <ul className="fi-plain-list fi-name-checks" aria-label={T.namesList}>
                  {severalRows.map((r) => (
                    <li key={r.value}>
                      <span className="fi-grow">{r.value}<span className="fi-hint">@{form.domain}</span></span>
                      <span className={`fi-field-message is-${r.view.tone}`}>{r.view.tone === "ok" ? T.nameFree : r.view.text}</span>
                    </li>
                  ))}
                  {parsed.skipped.map((s) => <li key={"skip-" + s.input}><span className="fi-grow">{s.input}</span><span className="fi-field-message is-warn">{s.reason}</span></li>)}
                </ul>
              )}
              <p id={ids.live} className="fi-visually-hidden" aria-live="polite">
                {severalRows.length ? T.namesCount(creatable.length, severalRows.length) : ""}
              </p>
            </>
          )}

          <DomainLine id={ids.domainMsg} domain={form.domain} option={option} check={fresh} checking={check.isFetching} />

          {mode === "one" && unknown.length > 0 && (
            <p className="fi-hint">{T.recentMissing(form.domain)}{" "}
              {unknown.map((u, i) => (
                <span key={u.address}>{i > 0 && ", "}<button type="button" className="fi-text-button" onClick={() => set("localPart", localOf(u.address))}>{localOf(u.address)}</button> ({u.count})</span>
              ))}.
            </p>
          )}

          <div className="fi-field-row">
            <label className="fi-field">{T.displayName}
              <input className="fi-input" maxLength={80} value={mode === "one" ? displayNameOf(form) : form.displayNameEdited ? form.displayName : ""}
                placeholder={mode === "one" ? T.displayNamePlaceholder : T.displayNamePlaceholderSeveral}
                onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value, displayNameEdited: true }))} />
              <span className="fi-hint">{T.displayNameHint}</span>
            </label>
            <label className="fi-field">{T.whoAnswers}
              <select className="fi-input" value={form.agent} onChange={(e) => set("agent", e.target.value)}>
                <option value="off">{T.answerOff}</option>
                {agents?.agents.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <span className="fi-hint">{chosenAgent ? agentLine(chosenAgent) : T.answerOffHint}</span>
            </label>
          </div>

          <label className="fi-check">
            <input type="checkbox" checked={form.signatureOn} onChange={(e) => set("signatureOn", e.target.checked)} />
            <span>{T.signatureToggle(mode === "one" && email ? email : T.signatureTheseAddresses)}</span>
          </label>
          {form.signatureOn && (
            <div className="fi-field-row">
              <label className="fi-field">{T.signature}
                <textarea className="fi-input" rows={3} maxLength={2000} value={form.signature} placeholder={T.signaturePlaceholder}
                  onChange={(e) => set("signature", e.target.value)} />
              </label>
              <div className="fi-field" aria-label={T.signaturePreview}>
                <span>{T.preview}</span>
                <div className="fi-signature-preview">
                  <span className="fi-hint">{T.previewFrom((mode === "one" ? displayNameOf(form) : form.displayName) || T.displayNamePlaceholder, email || `name@${form.domain}`)}</span>
                  <span>{T.previewGreeting}</span>
                  <span className="fi-hint">…</span>
                  <span className="fi-signature-text">{form.signature.trim() ? `--\n${form.signature}` : T.previewEmpty}</span>
                </div>
              </div>
            </div>
          )}

          <label className="fi-field">{T.copyLabel}
            <select className="fi-input" value={form.copy} onChange={(e) => set("copy", e.target.value)} disabled={!connected || !confirmed.length}>
              <option value="">{T.noCopy}</option>
              {confirmed.map((x) => <option key={x.id} value={x.email}>{x.email}</option>)}
            </select>
            <span className="fi-hint">
              {!connected ? T.copyNoToken
                : destinations.isPending ? T.copyLoading
                  : destinations.isError ? T.copyFailed(errorText(destinations.error))
                    : confirmed.length ? T.copyConfirmedOnly
                      : <>{T.copyNone} <Link to={settingsPath("destinations", null, null, { add: "1" })} onClick={onClose}>{T.addDestination}</Link>.</>}
            </span>
          </label>

          <details className="fi-advanced">
            <summary>{T.ruleSummary(canMakeRule ? (form.makeRule ? "made" : "off") : "cannot")}</summary>
            <label className="fi-check">
              <input type="checkbox" checked={canMakeRule && form.makeRule} disabled={!canMakeRule} onChange={(e) => set("makeRule", e.target.checked)} />
              <span>{T.ruleToggle}</span>
            </label>
            <p className="fi-hint">{fresh?.rule.detail ?? (canMakeRule ? T.ruleCan : T.ruleCannot)}{T.ruleWithout}</p>
          </details>

          <label className="fi-check">
            <input type="checkbox" checked={testing} onChange={(e) => setSendTest(e.target.checked)} />
            <span>{T.testToggle}</span>
          </label>

          {needsReceive && <p className="fi-callout" role="note">{fresh?.detail ?? T.receiveFirst(form.domain)}</p>}

          <div className="fi-dialog-actions">
            <button type="button" className="fi-secondary" onClick={onClose}>{T.cancel}</button>
            <button type="submit" className="fi-primary" disabled={!canSubmit}>{submitLabel}</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------- the domain choice */

/** A searchable choice of domain (ARIA combobox with a listbox): type to narrow, arrows to move, Enter to choose. */
function DomainPicker({ id, options, value, onChange, describedBy }: {
  id: string; options: DomainOption[]; value: string; onChange: (domain: string) => void; describedBy: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const shown = filterDomains(options, open ? query : "");
  const optionId = (d: string) => `${listId}-${d.replace(/[^a-z0-9]/gi, "-")}`;
  const choose = (d: string) => { onChange(d); setOpen(false); setQuery(""); };
  const openAt = () => { setActive(Math.max(0, shown.findIndex((o) => o.domain === value))); setOpen(true); };
  const current = options.find((o) => o.domain === value);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return openAt();
      setActive((a) => Math.min(shown.length - 1, Math.max(0, a + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      if (shown[active]) choose(shown[active]!.domain);
    } else if (e.key === "Escape" && open) {
      // Closes the list only; the dialog stays.
      e.preventDefault(); e.stopPropagation();
      setOpen(false); setQuery("");
    } else if (e.key === "Tab") { setOpen(false); setQuery(""); }
  };

  return (
    <div className="fi-combo">
      <input id={id} className="fi-input" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? optionId(shown[active]!.domain) : undefined} aria-describedby={describedBy}
        autoComplete="off" spellCheck={false} value={open ? query : value} placeholder={open ? value : T.chooseDomain}
        onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
        onClick={() => (open ? setOpen(false) : openAt())} onKeyDown={onKey}
        onBlur={() => { setOpen(false); setQuery(""); }} />
      {current && !open && <Badge tone={current.tone}>{current.label}</Badge>}
      <CaretDownIcon className="fi-combo-caret" size={14} aria-hidden="true" />
      {open && (
        <ul id={listId} role="listbox" className="fi-combo-list" aria-label={T.domainsList}>
          {!shown.length && <li className="fi-combo-empty" role="presentation">{T.noDomainMatches(query)}</li>}
          {DOMAIN_GROUPS.map((g) => {
            const items = shown.filter((o) => o.group === g.id);
            if (!items.length) return null;
            return (
              <li key={g.id} role="presentation">
                <span className="fi-combo-group" aria-hidden="true">{g.label}</span>
                <ul role="group" aria-label={g.label}>
                  {items.map((o) => {
                    const i = shown.indexOf(o);
                    return (
                      <li key={o.domain} id={optionId(o.domain)} role="option" aria-selected={o.domain === value}
                        className={(i === active ? "is-active " : "") + (o.domain === value ? "is-chosen" : "")}
                        onMouseDown={(e) => { e.preventDefault(); choose(o.domain); }} onMouseEnter={() => setActive(i)}>
                        <span className="fi-grow">{o.domain}{o.account && <span className="fi-hint"> · {o.account}</span>}</span>
                        <Badge tone={o.tone}>{o.label}</Badge>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** What choosing this domain means, under the field: its state in words (SCN-063). */
function DomainLine({ id, domain, option, check, checking }: { id: string; domain: string; option?: DomainOption; check?: AddressCheck; checking: boolean }) {
  const text = check?.detail ?? (checking ? T.domainReading(domain) : option ? T.domainSays(domain, option.label) : "");
  const tone = check ? (check.state === "receiving" || check.state === "can_receive" ? "neutral" : check.state === "no_token" ? "neutral" : "warn") : "neutral";
  return (
    <p id={id} className={`fi-hint fi-domain-line is-${tone}`}>
      {text}
      {check?.catchAll && T.catchAllKeeps(check.catchAll.mailbox)}
      {check?.state === "needs_fix" && <> <Link to={settingsPath("domains", domain)}>{T.openToFix(domain)}</Link>.</>}
    </p>
  );
}

/* ------------------------------------------------------------- the steps */

function RunView({ run, mode, domain, onFix, onTest, onReplace, onBack, onAgain, onDone }: {
  run: Run; mode: "one" | "several"; domain: string;
  onFix: (row: Row, fix: StepFix) => void; onTest: (email: string) => void; onReplace: () => void;
  onBack: () => void; onAgain: () => void; onDone: () => void;
}) {
  const doneRef = useRef<HTMLButtonElement>(null);
  const created = run.rows.filter((r) => r.created);
  const failedBefore = !run.working && !created.length;
  useEffect(() => { if (!run.working) doneRef.current?.focus(); }, [run.working]);
  return (
    <div className="fi-add-run">
      <div aria-live="polite">
        {run.receive && (
          <ol className="fi-steps fi-steps-live" aria-label={T.receiving(domain)}>
            <StepLine step={run.receive} action={run.receive.outcome === "waiting"
              ? <button type="button" className="fi-danger" onClick={onReplace}>{T.replaceContinue}</button> : null} />
          </ol>
        )}
        {run.working && !run.rows.length && !run.receive && <p role="status" className="fi-hint">{T.creating}</p>}
        {run.working && run.rows.length > 0 && mode === "several" && <p className="fi-hint">{T.creatingRest}</p>}
        {mode === "one"
          ? run.rows.map((row) => <RowSteps key={row.email} row={row} onFix={onFix} onTest={onTest} onClose={onDone} />)
          : run.rows.length > 0 && (
            <>
              <p role="status">{T.createdCount(created.length, run.rows.length, domain)}</p>
              <ul className="fi-plain-list fi-run-rows">
                {run.rows.map((row) => (
                  <li key={row.email}>
                    <strong className="fi-grow">{row.email}</strong>
                    <RowSteps row={row} onFix={onFix} onTest={onTest} onClose={onDone} compact />
                  </li>
                ))}
              </ul>
            </>
          )}
      </div>
      <div className="fi-dialog-actions">
        {failedBefore && <button type="button" className="fi-secondary" onClick={onBack} disabled={run.working}>{T.tryAgain}</button>}
        {!failedBefore && <button type="button" className="fi-secondary" onClick={onAgain} disabled={run.working}>{T.addAnother}</button>}
        <button ref={doneRef} type="button" className="fi-primary" onClick={onDone} disabled={run.working}>
          {created[0] ? T.doneOpen(created[0].email) : T.close}
        </button>
      </div>
    </div>
  );
}

function RowSteps({ row, onFix, onTest, onClose, compact = false }: {
  row: Row; onFix: (row: Row, fix: StepFix) => void; onTest: (email: string) => void; onClose: () => void; compact?: boolean;
}) {
  const test = useQuery({
    queryKey: ["routing-test", row.email], enabled: row.test === "sent",
    queryFn: () => fabric<{ test: TestStatus | null }>(`/api/project-addresses/${encodeURIComponent(row.email)}/test`).then((r) => r.test),
    refetchInterval: (q) => (testWaiting(q.state.data) ? TEST_POLL_MS : false),
  });
  const t = testStep(row.test, test.data ?? null, row.testError);
  const steps = row.created ? [...row.steps, t] : row.steps;
  const actionFor = (s: UiStep) =>
    s.fix && FIXABLE.has(s.outcome) ? <FixButton fix={s.fix} onRun={() => onFix(row, s.fix!)} onClose={onClose} /> :
    s.id === "test" && s.outcome === "not_asked" ? <button type="button" className="fi-text-button" onClick={() => onTest(row.email)}>{T.sendTest}</button> :
    s.id === "test" && s.outcome === "failed" ? <>
      <button type="button" className="fi-text-button" onClick={() => onTest(row.email)}>{T.sendAgain}</button>
      <Link className="fi-text-button" to={settingsPath("addresses", row.email)} onClick={onClose}>{T.checkRouting}</Link>
    </> : null;
  const list = (
    <ol className="fi-steps fi-steps-live" aria-label={T.stepsFor(row.email)}>
      {steps.map((s) => <StepLine key={s.id} step={s} action={compact ? null : actionFor(s)} />)}
    </ol>
  );
  if (!compact) return list;
  // Several: one line per address (a chip per step and its fixes); the sentences fold under Details.
  return (
    <div className="fi-run-row">
      <span className="fi-run-chips">
        {steps.map((s) => <Badge key={s.id} tone={OUTCOME_TONE[s.outcome]}>{T.chip(s.label, STEP_MARK[s.outcome])}</Badge>)}
        {steps.map((s) => { const a = actionFor(s); return a ? <span key={"a-" + s.id} className="fi-step-actions">{a}</span> : null; })}
      </span>
      <details className="fi-run-details"><summary>{T.details}</summary>{list}</details>
    </div>
  );
}

const OUTCOME_TONE: Record<UiStep["outcome"], "ok" | "warn" | "bad" | "busy" | "neutral"> = {
  done: "ok", already: "ok", skipped: "warn", failed: "bad", not_receiving: "warn", waiting: "busy", running: "busy", not_asked: "neutral",
};

function FixButton({ fix, onRun, onClose }: { fix: StepFix; onRun: () => void; onClose: () => void }) {
  if (fix.action === "connect_cloudflare") return <Link className="fi-text-button" to={settingsPath("domains", "connect")} onClick={onClose}>{fix.label}</Link>;
  if (fix.action === "connect_account") return <Link className="fi-text-button" to={settingsPath("accounts", null, null, { connect: "cloudflare" })} onClick={onClose}>{fix.label}</Link>;
  return <button type="button" className="fi-text-button" onClick={onRun}>{fix.label}</button>;
}

function StepLine({ step, action }: { step: UiStep; action: ReactNode }) {
  return (
    <li className={"fi-step is-" + step.outcome}>
      <span className="fi-step-mark">{STEP_MARK[step.outcome]}</span>
      <span><strong>{step.label}.</strong> {step.detail} {action && <span className="fi-step-actions">{action}</span>}</span>
    </li>
  );
}
