// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { mailboxesToCreate, type ProvisioningFailure, provisioningFailures } from "~/lib/mailbox-provisioning";
import { useMailboxes } from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";

/**
 * The addresses this server's configuration lists (EMAIL_ADDRESSES) are created once both the
 * configuration and the mailbox list have loaded — a failed mailbox list must not look like "none
 * exist". Every address that could not be created is listed with Retry; nothing is dropped. This
 * was the Mailboxes screen's job until Settings (0.11).
 */
export default function ConfiguredAddresses() {
	const config = useQuery({ queryKey: queryKeys.config, queryFn: () => api.getConfig(), staleTime: 60_000 });
	const mailboxes = useMailboxes();
	const [failures, setFailures] = useState<ProvisioningFailure[]>([]);
	const [working, setWorking] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const done = useRef(false);
	const mounted = useRef(true);
	useEffect(() => () => { mounted.current = false; }, []);

	const configured = config.data?.emailAddresses ?? [];
	useEffect(() => {
		if (done.current || !configured.length || !mailboxes.isSuccess) return;
		done.current = true;
		const toCreate = mailboxesToCreate(configured, mailboxes.data);
		if (!toCreate.length) return;
		setWorking(true);
		void Promise.allSettled(toCreate.map((address) => api.createMailbox(address, address.split("@")[0] || address))).then((results) => {
			if (!mounted.current) return;
			const failed = provisioningFailures(toCreate, results);
			if (failed.length) console.error(JSON.stringify({ event: "configured_addresses_failed", count: failed.length }));
			setFailures(failed);
			setWorking(false);
			void mailboxes.refetch();
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [configured.length, mailboxes.isSuccess, attempt]);

	if (working) return <p role="status">Creating the addresses this server is configured with…</p>;
	if (!failures.length) return null;
	return (
		<div role="alert">
			<p>
				{failures.length === 1 ? "One configured address could not be created" : `${failures.length} configured addresses could not be created`}:{" "}
				{failures.map((f) => `${f.address} (${f.reason})`).join("; ")}.
			</p>
			<button type="button" className="fi-secondary" onClick={() => { done.current = false; setFailures([]); setAttempt((n) => n + 1); }}>Retry</button>
		</div>
	);
}
