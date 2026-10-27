import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { fabric } from "~/services/fabric";
import { useT, type T } from "../../../lib/i18n";
import type { Campaign, CampaignRecipient, CampaignReport, SuppressionEntry } from "~/services/campaigns";
import { groupRows, visibleRows, type ListEntry } from "../list-model";
import { settingsPath } from "../paths";
import {
  ActionMenu, ActionResult, Badge, ListSearch, LoadFailure, Panel, PanelBlock, PanelPlaceholder, SectionLayout, SelectableList,
  SkeletonPanel, SkeletonRows, useConfirm, useWork,
} from "../ui";
import { primaryAction, progress, reasonText, STATE_LABEL, STATE_TONE, STATUS_ORDER, statusLabel } from "./campaigns-model";

interface CampaignEntry extends ListEntry { campaign: Campaign }

const LIST_KEY = ["campaigns"];
const DO_NOT_WRITE = "do-not-write";
/** A weekday's short name in the language (0 is Sunday; 1 November 2026 was one). */
const dayName = (d: number, t: T) => t.date(Date.UTC(2026, 10, 1 + d), { weekday: "short", timeZone: "UTC" });
const percent = (value: number | null, t: T) => value === null ? t("none yet") : t.number(value, { style: "percent", maximumFractionDigits: 1 });
const accountName = (sender: string) => sender.slice(sender.indexOf(":") + 1);

/**
 * Settings → Campaigns (SCR-18, SCN-091): what an agent's outreach campaigns did, and the person's say in whether each
 * runs, waits or ends; the do-not-write list. A campaign is prepared by an agent (save_campaign), not here.
 */
export default function CampaignsSection({ id }: { id: string | null }) {
  const t = useT();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: LIST_KEY, queryFn: () => fabric<{ campaigns: Campaign[] }>("/api/campaigns"), refetchInterval: 60_000 });
  const [query, setQuery] = useState("");
  const entries = (list.data?.campaigns ?? []).map((c): CampaignEntry => ({ key: c.id, group: "all", campaign: c, text: `${c.name} ${c.sender}` }));
  const groups = groupRows(visibleRows(entries, query, id), [{ id: "all", label: "" }]);
  const selected = id && id !== DO_NOT_WRITE ? entries.find((e) => e.key === id) ?? null : null;
  const close = () => navigate(settingsPath("campaigns"), { replace: true, preventScrollReset: true });

  const listView = list.isPending ? <SkeletonRows label={t("Loading campaigns…")} /> : list.isError ? (
    <LoadFailure what={t("Campaigns")} error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
  ) : (
    <SelectableList label={t("Campaigns")} groups={groups} selected={id} hrefFor={(e) => settingsPath("campaigns", e.key)}
      pinned={[{ key: DO_NOT_WRITE, href: settingsPath("campaigns", DO_NOT_WRITE), content: (
        <span className="fi-row-main"><span className="fi-row-title">{t("Do-not-write list")}</span><span className="fi-row-meta">{t("Addresses and domains no campaign writes to")}</span></span>
      ) }]}
      renderRow={(e) => {
        const p = progress(e.campaign);
        return (
          <>
            <span className="fi-row-main">
              <span className="fi-row-title">{e.campaign.name}</span>
              <span className="fi-row-meta">{t("From {account} · {left} of {total} still to write to", { account: accountName(e.campaign.sender), left: p.open, total: p.total })}</span>
            </span>
            <span className="fi-row-side"><Badge tone={STATE_TONE[e.campaign.state]}>{t.text(STATE_LABEL[e.campaign.state])}</Badge></span>
          </>
        );
      }}
      empty={<div className="fi-list-empty"><p>{query ? t("No campaign matches “{query}”.", { query }) : t("No campaign yet.")}</p></div>} />
  );

  const panel = !id ? (
    <PanelPlaceholder>
      <h2>{t("Choose a campaign")}</h2>
      <p>{t("Your agent prepares a campaign (save_campaign), adds the people and checks it with you. Here you see what it did and decide whether it runs, waits or ends.")}</p>
    </PanelPlaceholder>
  ) : id === DO_NOT_WRITE ? <DoNotWritePanel /> : list.isPending ? <SkeletonPanel label={t("Loading this campaign…")} /> : !selected ? (
    <PanelPlaceholder>
      <h2>{t("This campaign is not here")}</h2>
      <p>{t("[campaign] It may have been deleted.")}</p>
    </PanelPlaceholder>
  ) : (
    <CampaignPanel key={selected.key} campaign={selected.campaign} onDeleted={close} />
  );

  return (
    <SectionLayout section="campaigns" hasSelection={!!id} list={listView} panel={panel}
      toolbar={<ListSearch value={query} onChange={setQuery} placeholder={t("Find a campaign")} label={t("Find a campaign")} />}
      footer={<p>{t("A campaign sends from your own account at a person's pace and stops for whoever replies. Write only to people who would expect to hear from you.")}</p>} />
  );
}

function CampaignPanel({ campaign, onDeleted }: { campaign: Campaign; onDeleted: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const confirm = useConfirm();
  const path = `/api/campaigns/${encodeURIComponent(campaign.id)}`;
  const reportKey = ["campaign-report", campaign.id];
  const report = useQuery({ queryKey: reportKey, queryFn: () => fabric<CampaignReport>(`${path}/report`), refetchInterval: 60_000 });
  const [status, setStatus] = useState("");
  const people = useQuery({ queryKey: ["campaign-people", campaign.id, status],
    queryFn: () => fabric<{ recipients: CampaignRecipient[]; total: number }>(`${path}/recipients?limit=100${status ? `&status=${status}` : ""}`) });
  const work = useWork(campaign.id);
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: LIST_KEY }), client.invalidateQueries({ queryKey: reportKey }),
    client.invalidateQueries({ queryKey: ["campaign-people", campaign.id] })]);
  const p = progress(campaign);
  const action = primaryAction(campaign.state);

  const start = async () => {
    const ok = await confirm({
      title: campaign.state === "paused" ? t("Resume {name}?", { name: campaign.name }) : t("Start {name}?", { name: campaign.name }),
      body: <p>{t.plural(p.open, { one: "Real mail leaves {account} for {n} person, at most {cap} a day, inside the sending hours.",
        other: "Real mail leaves {account} for {n} people, at most {cap} a day, inside the sending hours." }, { account: accountName(campaign.sender), cap: campaign.dailyCap })}</p>,
      confirmLabel: campaign.state === "paused" ? t("Resume") : t("Start sending"),
    });
    if (ok) void work.run(t("Starting…"), async () => {
      try { await fabric(`${path}/launch`, {}); return t("{name} is running.", { name: campaign.name }); } finally { await refresh(); }
    });
  };
  const pause = () => void work.run(t("Pausing…"), async () => {
    try { await fabric(`${path}/pause`, {}); return t("{name} is paused. Nothing more leaves until you resume it.", { name: campaign.name }); } finally { await refresh(); }
  });
  const stop = async () => {
    const ok = await confirm({ title: t("Stop {name} for good?", { name: campaign.name }),
      body: <p>{t("Nobody still waiting gets another message, and the campaign cannot be resumed.")}</p>, confirmLabel: t("Stop campaign"), danger: true });
    if (ok) void work.run(t("Stopping…"), async () => {
      try { await fabric(`${path}/stop`, {}); return t("{name} is stopped.", { name: campaign.name }); } finally { await refresh(); }
    });
  };
  const remove = async () => {
    const ok = await confirm({ title: t("Delete {name}?", { name: campaign.name }), body: <p>{t("Its people and report go with it. The do-not-write list stays.")}</p>,
      confirmLabel: t("Delete campaign"), danger: true, blocked: campaign.state === "running" ? t("Pause it first.") : undefined });
    if (!ok) return;
    const done = await work.run(t("Deleting…"), async () => {
      try { await fabric(path, undefined, "DELETE"); return t("{name} deleted.", { name: campaign.name }); } finally { await client.invalidateQueries({ queryKey: LIST_KEY }); }
    });
    if (done) onDeleted();
  };

  const r = report.data;
  return (
    <Panel title={campaign.name} subtitle={t("From {account}", { account: accountName(campaign.sender) })} closeTo={settingsPath("campaigns")}
      badges={<Badge tone={STATE_TONE[campaign.state]}>{t.text(STATE_LABEL[campaign.state])}</Badge>}
      menu={<ActionMenu label={t("More actions for {name}", { name: campaign.name })} actions={[
        ...(campaign.state !== "stopped" && campaign.state !== "finished" ? [{ label: t("Stop this campaign…"), danger: true, onSelect: () => void stop() }] : []),
        { label: t("Delete this campaign…"), danger: true, onSelect: () => void remove() },
      ]} />}>
      <PanelBlock>
        {campaign.state === "paused" && campaign.reason && <p className="fi-callout">{t.text(reasonText(campaign.reason))}</p>}
        <p>{t("{cap} a day at most, {days}, {start} to {end} ({zone}), {lo} to {hi} minutes apart.", { cap: campaign.dailyCap,
          days: t.list(campaign.window.days.map((d) => dayName(d, t))), start: campaign.window.start, end: campaign.window.end, zone: campaign.timezone,
          lo: campaign.gapMinutes[0], hi: campaign.gapMinutes[1] })}</p>
        {action && (
          <div className="fi-buttons">
            {action === "pause"
              ? <button type="button" className="fi-secondary" disabled={!!work.busy} onClick={pause}>{work.busy ?? t("Pause")}</button>
              : <button type="button" className="fi-primary" disabled={!!work.busy || !p.open} onClick={() => void start()}>{work.busy ?? (action === "resume" ? t("Resume") : t("Start sending"))}</button>}
          </div>
        )}
        <ActionResult result={work.result} />
      </PanelBlock>
      <PanelBlock title={t("Report")}>
        {report.isPending ? <SkeletonRows rows={3} label={t("Loading the report…")} /> : report.isError ? (
          <LoadFailure what={t("Report")} error={report.error} onRetry={() => void report.refetch()} retrying={report.isFetching} />
        ) : (
          <ul className="fi-plain-list">
            <li>{t.plural(r!.contacted, { one: "{n} person written to", other: "{n} people written to" })} · {r!.perStep.map((n, i) => t("step {step}: {n}", { step: i + 1, n })).join(" · ")}</li>
            <li>{t("Replies: {rate}", { rate: percent(r!.replyRate, t) })} · {t("Bounces: {rate}", { rate: percent(r!.bounceRate, t) })}</li>
            <li>{STATUS_ORDER.filter((s) => campaign.counts[s]).map((s) => `${t.text(statusLabel(s))}: ${campaign.counts[s]}`).join(" · ") || t("Nobody added yet.")}</li>
            <li>{r!.lastSentAt ? t("Last message {time}", { time: t.dateTime(r!.lastSentAt) }) : t("Nothing sent yet.")}
              {r!.nextSendAt ? ` · ${t("next {time}", { time: t.dateTime(r!.nextSendAt) })}` : ""}</li>
          </ul>
        )}
      </PanelBlock>
      <PanelBlock title={t("Steps")}>
        <ol className="fi-plain-list">
          {campaign.steps.map((s, i) => (
            <li key={i} style={{ display: "block" }}>
              <strong>{s.subject || (i ? t("Reply in the same conversation") : t("No subject"))}</strong>
              <span className="fi-hint"> · {i === 0 ? t("first message") : t.plural(s.delayDays, { one: "{n} day after the one before", other: "{n} days after the one before" })}</span>
              <br />{s.body.split("\n").slice(0, 3).join(" ").slice(0, 240)}
            </li>
          ))}
        </ol>
      </PanelBlock>
      <PanelBlock title={t("People")} aside={
        <select className="fi-input" aria-label={t("Show people who")} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t("Everyone")}</option>
          {STATUS_ORDER.map((s) => <option key={s} value={s}>{t.text(statusLabel(s))}</option>)}
        </select>}>
        {people.isPending ? <SkeletonRows rows={3} label={t("Loading people…")} /> : people.isError ? (
          <LoadFailure what={t("People")} error={people.error} onRetry={() => void people.refetch()} retrying={people.isFetching} />
        ) : !people.data.recipients.length ? <p>{t("Nobody here.")}</p> : (
          <>
            <ul className="fi-plain-list">
              {people.data.recipients.map((x) => (
                <li key={x.email}>
                  <span className="fi-grow">{x.email}{x.detail ? <span className="fi-hint"> · {t.text(reasonText(x.detail))}</span> : null}</span>
                  <Badge>{t.text(statusLabel(x.status))}</Badge>
                </li>
              ))}
            </ul>
            {people.data.total > people.data.recipients.length && <p className="fi-hint">{t("The first {shown} of {total}.", { shown: people.data.recipients.length, total: people.data.total })}</p>}
          </>
        )}
      </PanelBlock>
    </Panel>
  );
}

function DoNotWritePanel() {
  const t = useT();
  const client = useQueryClient();
  const key = ["suppression"];
  const list = useQuery({ queryKey: key, queryFn: () => fabric<{ suppression: SuppressionEntry[] }>("/api/suppression") });
  const work = useWork(DO_NOT_WRITE);
  const [form, setForm] = useState({ values: "", reason: "" });
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: LIST_KEY })]);
  const add = () => void work.run(t("Adding…"), async () => {
    const values = form.values.split(/[\s,;]+/).filter(Boolean);
    try {
      const r = await fabric<{ added: string[]; invalid: string[]; removedRecipients: number }>("/api/suppression", { add: values, reason: form.reason });
      setForm({ values: "", reason: "" });
      return [t.plural(r.added.length, { one: "{n} added.", other: "{n} added." }),
        r.removedRecipients ? t.plural(r.removedRecipients, { one: "{n} person left the campaigns.", other: "{n} people left the campaigns." }) : "",
        r.invalid.length ? t("Not an address or a domain: {values}.", { values: t.list(r.invalid) }) : ""].filter(Boolean).join(" ");
    } finally { await refresh(); }
  });
  const remove = (value: string) => void work.run(t("Removing…"), async () => {
    try { await fabric("/api/suppression", { remove: [value] }); return t("{value} removed.", { value }); } finally { await refresh(); }
  });
  return (
    <Panel title={t("Do-not-write list")} subtitle={t("No campaign writes to these addresses, or to any address under these domains.")} closeTo={settingsPath("campaigns")}>
      <PanelBlock>
        <form onSubmit={(e) => { e.preventDefault(); add(); }}>
          <label className="fi-field">{t("Addresses or domains")}
            <input className="fi-input" required maxLength={5000} placeholder={t("For example: ann@acme.example, beta.example")} value={form.values} onChange={(e) => setForm({ ...form, values: e.target.value })} />
          </label>
          <label className="fi-field">{t("Why (optional)")}
            <input className="fi-input" maxLength={200} placeholder={t("Asked not to be written to")} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </label>
          <div className="fi-buttons"><button type="submit" className="fi-primary" disabled={!!work.busy || !form.values.trim()}>{work.busy ?? t("Add")}</button></div>
        </form>
        <ActionResult result={work.result} />
      </PanelBlock>
      <PanelBlock title={t("On the list")}>
        {list.isPending ? <SkeletonRows rows={3} label={t("Loading the list…")} /> : list.isError ? (
          <LoadFailure what={t("Do-not-write list")} error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : !list.data.suppression.length ? <p>{t("Nobody is on the list.")}</p> : (
          <ul className="fi-plain-list">
            {list.data.suppression.map((s) => (
              <li key={s.value}>
                <span className="fi-grow"><strong>{s.value}</strong> <span className="fi-hint">· {s.reason ? `${t.text(reasonText(s.reason))} · ` : ""}{t.date(s.addedAt)}</span></span>
                <button type="button" className="fi-text-button" disabled={!!work.busy} onClick={() => remove(s.value)}>{t("Remove")}</button>
              </li>
            ))}
          </ul>
        )}
      </PanelBlock>
    </Panel>
  );
}
