// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Dialog,
	Empty,
	Input,
	Loader,
	Select,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { EnvelopeIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import LoadError from "~/components/LoadError";
import {
	mailboxesToCreate,
	type ProvisioningFailure,
	provisioningFailures,
} from "~/lib/mailbox-provisioning";
import api from "~/services/api";
import type { Mailbox } from "~/types";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxes,
} from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";

const NO_MAILBOXES: Mailbox[] = [];

export function meta() {
	return [{ title: "Fabric Inbox" }];
}

export default function HomeRoute() {
	const toastManager = useKumoToastManager();
	const {
		data: mailboxesData,
		refetch: refetchMailboxes,
		isSuccess: mailboxesLoaded,
		isError: mailboxesFailed,
		error: mailboxesError,
		isFetching: mailboxesFetching,
	} = useMailboxes();
	const mailboxes = mailboxesData ?? NO_MAILBOXES;
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();

	const {
		data: configData,
		isError: configFailed,
		error: configError,
		isFetching: configFetching,
		refetch: refetchConfig,
	} = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: 60_000, // a domain connected on Domains & addresses shows up without a reload
	});

	const domains = configData?.domains ?? [];
	const emailAddresses = configData?.emailAddresses ?? [];

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newPrefix, setNewPrefix] = useState("");
	const [selectedDomain, setSelectedDomain] = useState("");
	const [newName, setNewName] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [mailboxToDelete, setMailboxToDelete] = useState<{
		id: string;
		email: string;
	} | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);
	const [provisionFailures, setProvisionFailures] = useState<ProvisioningFailure[]>([]);
	const [isProvisioning, setIsProvisioning] = useState(false);
	const [provisionAttempt, setProvisionAttempt] = useState(0);

	// Set default domain when config loads
	useEffect(() => {
		if (domains.length > 0 && !selectedDomain) {
			setSelectedDomain(domains[0]);
		}
	}, [domains, selectedDomain]);

	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// Auto-create the mailboxes the config lists (once both sources have
	// loaded successfully — a failed mailbox list must not look like "none
	// exist"). Every address that could not be created is shown with Retry.
	const autoCreateDone = useRef(false);
	useEffect(() => {
		if (autoCreateDone.current) return;
		if (emailAddresses.length === 0 || !mailboxesLoaded) return;
		const toCreate = mailboxesToCreate(emailAddresses, mailboxes);
		autoCreateDone.current = true;
		if (toCreate.length === 0) return;
		setIsProvisioning(true);
		Promise.allSettled(
			toCreate.map((addr) => api.createMailbox(addr, addr.split("@")[0] || addr)),
		).then((results) => {
			if (!mounted.current) return;
			const failures = provisioningFailures(toCreate, results);
			if (failures.length > 0) console.error("Mailbox auto-create failed:", failures);
			setProvisionFailures(failures);
			setIsProvisioning(false);
			refetchMailboxes();
		});
	}, [emailAddresses, mailboxes, mailboxesLoaded, refetchMailboxes, provisionAttempt]);

	const retryProvisioning = () => {
		autoCreateDone.current = false;
		setProvisionFailures([]);
		setProvisionAttempt((n) => n + 1);
	};

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		if (!newPrefix || !selectedDomain) {
			setCreateError("Please fill in all fields");
			return;
		}
		const email = `${newPrefix}@${selectedDomain}`;
		const name = newName || newPrefix;
		setIsCreating(true);
		try {
			const created = await createMailbox.mutateAsync({ email, name });
			toastManager.add({ title: `${email} is ready.${created?.warning ? ` ${created.warning}` : ""}` });
			setIsCreateOpen(false);
			setNewPrefix("");
			setNewName("");
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to create mailbox";
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};

	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		setIsDeleting(true);
		try {
			const result = await deleteMailbox.mutateAsync(mailboxToDelete.id);
			toastManager.add({ title: `${mailboxToDelete.email} was removed.${result ? ` ${result.routing} ${result.afterwards}` : ""}` });
			setIsDeleteOpen(false);
			setMailboxToDelete(null);
		} catch (err: unknown) {
			// The server says why, e.g. the domain's catch-all cannot be removed while it is one.
			toastManager.add({ title: (err instanceof Error && err.message) || "The mailbox could not be removed", variant: "error" });
		} finally {
			setIsDeleting(false);
		}
	};

	const isConfigured = emailAddresses.length > 0;
	const accounts = isConfigured
		? emailAddresses.map((addr) => ({
				id: addr,
				email: addr,
				name: addr.split("@")[0] || addr,
			}))
		: mailboxes;

	const isLoading = !configData;
	// The account list itself is the mailbox list only when nothing is configured.
	const mailboxesUnknown = mailboxesFailed && !mailboxesData;

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				<nav className="mb-6 flex gap-6"><RouterLink to="/accounts" className="underline">Accounts and rules</RouterLink></nav>
				<div className="mb-8">
					<div className="flex items-center justify-between">
						<h1 className="text-2xl font-bold text-kumo-default">Fabric Inbox</h1>
						{!isConfigured && (
							<Button
								variant="primary"
								icon={<PlusIcon size={16} />}
								onClick={() => setIsCreateOpen(true)}
							>
								New Mailbox
							</Button>
						)}
					</div>
					{domains.length > 0 && (
						<p className="text-sm text-kumo-subtle mt-1">
							{domains.join(", ")}
						</p>
					)}
				</div>

				{provisionFailures.length > 0 && (
					<div
						role="alert"
						className="mb-4 rounded-xl border border-kumo-line bg-kumo-base px-5 py-4"
					>
						<p className="text-sm font-medium text-kumo-default">
							{provisionFailures.length === 1
								? "One configured mailbox could not be created."
								: `${provisionFailures.length} configured mailboxes could not be created.`}
						</p>
						<ul className="mt-2 space-y-1 text-sm text-kumo-subtle">
							{provisionFailures.map((f) => (
								<li key={f.address}>
									<span className="text-kumo-default">{f.address}</span> — {f.reason}
								</li>
							))}
						</ul>
						<Button
							className="mt-3"
							variant="secondary"
							size="sm"
							loading={isProvisioning}
							onClick={retryProvisioning}
						>
							Retry
						</Button>
					</div>
				)}
				{isConfigured && mailboxesUnknown && (
					<div className="mb-4 overflow-hidden rounded-xl border border-kumo-line">
						<LoadError
							compact
							title="Couldn't check which mailboxes exist."
							error={mailboxesError}
							onRetry={() => refetchMailboxes()}
							retrying={mailboxesFetching}
						/>
					</div>
				)}
				{isLoading && configFailed && !configFetching ? (
					<LoadError
						title="Couldn't load your mailboxes"
						error={configError}
						onRetry={() => refetchConfig()}
					/>
				) : isLoading ? (
					<div className="flex justify-center py-20">
						<Loader size="lg" />
					</div>
				) : !isConfigured && mailboxesUnknown ? (
					<LoadError
						title="Couldn't load your mailboxes"
						error={mailboxesError}
						onRetry={() => refetchMailboxes()}
						retrying={mailboxesFetching}
					/>
				) : !isConfigured && !mailboxesData ? (
					<div className="flex justify-center py-20">
						<Loader size="lg" />
					</div>
				) : accounts.length > 0 ? (
					<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
						{accounts.map((account, idx) => (
							<RouterLink
								key={account.id}
								to={`/mailbox/${account.id}`}
								className={`group flex items-center gap-4 px-5 py-4 no-underline transition-colors hover:bg-kumo-tint ${
									idx > 0 ? "border-t border-kumo-line" : ""
								}`}
							>
								<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
									{account.name.charAt(0).toUpperCase()}
								</div>
								<div className="min-w-0 flex-1">
									<div className="text-sm font-medium text-kumo-default truncate">
										{account.name}
									</div>
									<div className="text-sm text-kumo-subtle">
										{account.email}
									</div>
								</div>
								{!isConfigured && (
									<Button
										variant="ghost"
										size="sm"
										shape="square"
										icon={<TrashIcon size={16} />}
										aria-label={`Delete mailbox ${account.email}`}
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											setMailboxToDelete({
												id: account.id,
												email: account.email,
											});
											setIsDeleteOpen(true);
										}}
									/>
								)}
							</RouterLink>
						))}
					</div>
				) : (
					<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6">
						<div className="flex flex-col items-center text-center">
							<div className="mb-4">
								<EnvelopeIcon
									size={48}
									weight="thin"
									className="text-kumo-subtle"
								/>
							</div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">
								No mailboxes yet
							</h3>
							<p className="text-sm text-kumo-subtle max-w-sm mb-5">
								{isConfigured
									? "Your email routing is configured but no mailboxes have been created yet. They will appear here automatically."
									: "Create a mailbox to start sending and receiving emails with your domain."}
							</p>
							{!isConfigured && (
								<Button
									variant="primary"
									icon={<PlusIcon size={16} />}
									onClick={() => setIsCreateOpen(true)}
								>
									Create Mailbox
								</Button>
							)}
						</div>
					</div>
				)}
			</div>

			{/* Create Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-5">
						Create New Mailbox
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
						)}
						<div>
							<span className="text-sm font-medium text-kumo-default mb-1.5 block">
								Email Address
							</span>
							<div className="flex items-center gap-2">
								<div className="flex-1">
									<Input
										aria-label="Address prefix"
										placeholder="info"
										size="sm"
										value={newPrefix}
										onChange={(e) => setNewPrefix(e.target.value)}
										required
									/>
								</div>
								<span className="text-sm text-kumo-subtle">@</span>
								{domains.length > 1 ? (
									<div className="flex-1">
							<Select
								aria-label="Domain"
								value={selectedDomain}
								onValueChange={(value) => {
									if (value) setSelectedDomain(value);
								}}
							>
											{domains.map((d) => (
												<Select.Option key={d} value={d}>
													{d}
												</Select.Option>
											))}
										</Select>
									</div>
								) : (
									<span className="text-sm text-kumo-subtle">
										{selectedDomain || "no domain"}
									</span>
								)}
							</div>
						</div>
						<Input
							label="Display Name (optional)"
							placeholder="Info"
							size="sm"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
						/>
						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isCreating}
								disabled={!selectedDomain}
							>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Delete Dialog */}
			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setMailboxToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						Delete Mailbox
					</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						Are you sure you want to delete{" "}
						<strong className="text-kumo-default">
							{mailboxToDelete?.email}
						</strong>
						? Its mail is deleted and its routing rule in Cloudflare is removed. This cannot be undone.
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							size="sm"
							loading={isDeleting}
							onClick={handleDelete}
						>
							Delete
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
