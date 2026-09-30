// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { RobotIcon, ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router";
import LoadError from "~/components/LoadError";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const {
		data: mailbox,
		isError: mailboxFailed,
		error: mailboxError,
		isFetching: mailboxFetching,
		refetch: refetchMailbox,
	} = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [signatureOn, setSignatureOn] = useState(false);
	const [signature, setSignature] = useState("");
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
			const sig = mailbox.settings?.signature as { enabled?: boolean; text?: string } | undefined;
			setSignatureOn(!!sig?.enabled);
			setSignature(sig?.text ?? "");
		}
	}, [mailbox]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSaving(true);
		if (!displayName.trim()) {
			toastManager.add({ title: "A display name is needed: it is the name your mail is sent with.", variant: "error" });
			setIsSaving(false);
			return;
		}
		// Only what this page edits: the server merges it, so an agent or a copy set elsewhere is kept.
		const settings = {
			fromName: displayName.trim(),
			signature: { enabled: signatureOn && !!signature.trim(), text: signature },
			agentSystemPrompt: agentPrompt.trim() || null,
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved" });
		} catch (err: unknown) {
			toastManager.add({
				title: (err instanceof Error && err.message) || "The settings could not be saved",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	const handleResetPrompt = () => {
		setAgentPrompt("");
	};

	if (!mailbox && mailboxFailed && !mailboxFetching) {
		return (
			<LoadError
				title="Couldn't load settings"
				error={mailboxError}
				onRetry={() => refetchMailbox()}
			/>
		);
	}

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			<div className="space-y-6">
				{/* Account */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">
						Account
					</div>
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
					</div>
				</div>

				{/* Signature: added below what you write and below an agent's answers */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-2">Signature</div>
					<label className="flex items-center gap-2 text-sm text-kumo-default">
						<input type="checkbox" checked={signatureOn} onChange={(e) => setSignatureOn(e.target.checked)} />
						Add a signature to mail sent from {mailbox.email}
					</label>
					<textarea
						value={signature}
						onChange={(e) => setSignature(e.target.value)}
						maxLength={2000}
						rows={4}
						disabled={!signatureOn}
						aria-label="Signature text"
						placeholder={"Alex Morgan\nSupport, Acme"}
						className="mt-3 w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring disabled:opacity-60"
					/>
					<p className="text-xs text-kumo-subtle mt-2">
						Added to new messages and replies you write here, and to the answers an agent sends or drafts from this address.
					</p>
				</div>

				{/* Agent System Prompt */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
								Chat assistant prompt
							</span>
							{isCustomPrompt ? (
								<Badge variant="primary">Custom</Badge>
							) : (
								<Badge variant="secondary">Default</Badge>
							)}
						</div>
						{isCustomPrompt && (
							<Button
								variant="ghost"
								size="xs"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={handleResetPrompt}
							>
								Reset to default
							</Button>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						Instructions for the assistant in this mailbox's Agent panel.
						Leave empty to use the built-in default prompt.
					</p>
					<p className="text-xs text-kumo-default mb-3">
						Incoming mail is answered by the agent assigned to this address, not by this prompt.{" "}
						<Link className="underline" to="/projects">Choose the agent</Link> or{" "}
						<Link className="underline" to="/ai-agents">edit agents</Link>.
					</p>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						placeholder={PROMPT_PLACEHOLDER}
						rows={12}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
					/>
					<p className="text-xs text-kumo-subtle mt-2">
						The prompt is sent as the system message of the chat assistant.
						It controls its personality, writing style and behavior rules.
					</p>
				</div>

				{/* Save */}
				<div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving}>
						Save Changes
					</Button>
				</div>
			</div>
		</div>
	);
}
