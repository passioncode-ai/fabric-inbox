// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import { ActionResult, LoadFailure, SkeletonPanel, useWork } from "../ui";
import { settingsPath } from "../paths";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

interface Form { displayName: string; signatureOn: boolean; signature: string; prompt: string }

/**
 * An address's display name, signature and chat assistant prompt (SCN-012), the settings the
 * legacy mailbox screen kept behind its gear. Saving changes only these: the server merges them,
 * so an agent or a copy set elsewhere is kept.
 */
export default function SignatureForm({ email }: { email: string }) {
	const mailbox = useMailbox(email);
	const update = useUpdateMailbox();
	const work = useWork(email, "signature");
	const [saved, setSaved] = useState<Form | null>(null);
	const [form, setForm] = useState<Form | null>(null);

	useEffect(() => {
		const m = mailbox.data;
		if (!m) return;
		const sig = m.settings?.signature as { enabled?: boolean; text?: string } | undefined;
		const next = {
			displayName: m.settings?.fromName || m.name || "",
			signatureOn: !!sig?.enabled,
			signature: sig?.text ?? "",
			prompt: m.settings?.agentSystemPrompt || "",
		};
		setSaved(next);
		// A refetch after saving replaces the form only when nothing is being edited.
		setForm((current) => (current && saved && JSON.stringify(current) !== JSON.stringify(saved) ? current : next));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mailbox.data]);

	if (!mailbox.data && mailbox.isError) {
		return <LoadFailure what="This address's settings" error={mailbox.error} onRetry={() => void mailbox.refetch()} retrying={mailbox.isFetching} />;
	}
	if (!form || !saved) return <SkeletonPanel label="Loading this address's settings…" />;

	const dirty = JSON.stringify(form) !== JSON.stringify(saved);
	const nameMissing = !form.displayName.trim();
	const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...form, [key]: value });

	const save = () => void work.run("Saving…", async () => {
		if (nameMissing) throw new Error("A display name is needed: it is the name your mail is sent with.");
		await update.mutateAsync({
			mailboxId: email,
			settings: {
				fromName: form.displayName.trim(),
				signature: { enabled: form.signatureOn && !!form.signature.trim(), text: form.signature },
				agentSystemPrompt: form.prompt.trim() || null,
			},
		});
		setSaved(form);
		return `Saved the name and signature of ${email}.`;
	});

	return (
		<form onSubmit={(e) => { e.preventDefault(); save(); }} aria-label={`Name and signature of ${email}`}>
			<label className="fi-field">Display name
				<span className="fi-hint">The name your mail and an agent's answers are sent with.</span>
				<input className="fi-input" required maxLength={120} value={form.displayName} aria-invalid={nameMissing}
					onChange={(e) => set("displayName", e.target.value)} />
			</label>
			<label className="fi-check">
				<input type="checkbox" checked={form.signatureOn} onChange={(e) => set("signatureOn", e.target.checked)} />
				<span>Add a signature to mail sent from {email}</span>
			</label>
			<label className="fi-field">Signature
				<textarea className="fi-input" value={form.signature} onChange={(e) => set("signature", e.target.value)} maxLength={2000} rows={4}
					disabled={!form.signatureOn} placeholder={"Alex Morgan\nSupport, Acme"} />
				<span className="fi-hint">Added to new messages and replies you write here, and to the answers an agent sends or drafts from this address.</span>
			</label>
			<label className="fi-field">Chat assistant prompt
				<span className="fi-hint">
					Instructions for the assistant in this mailbox's Agent panel; empty uses the built-in prompt. Incoming mail is answered
					by the agent chosen under Who answers, not by this prompt. <Link to={settingsPath("agents")}>Edit agents</Link>.
				</span>
				<textarea className="fi-input" value={form.prompt} onChange={(e) => set("prompt", e.target.value)} rows={8}
					placeholder={PROMPT_PLACEHOLDER} style={{ fontFamily: "var(--pc-font-data)", fontSize: 12 }} />
			</label>
			{form.prompt.trim() && (
				<p className="fi-hint">A custom prompt is set. <button type="button" className="fi-text-button" onClick={() => set("prompt", "")}>Use the default prompt</button></p>
			)}
			<div className="fi-buttons">
				<button type="submit" className="fi-primary" disabled={!!work.busy || !dirty || nameMissing}>{work.busy ? "Saving…" : "Save changes"}</button>
				{dirty && <button type="button" className="fi-secondary" disabled={!!work.busy} onClick={() => setForm(saved)}>Undo changes</button>}
			</div>
			<ActionResult result={work.result} />
		</form>
	);
}
