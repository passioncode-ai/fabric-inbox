// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Empty } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { useNavigate } from "react-router";
import { useT } from "../lib/i18n";

export default function NotFoundRoute() {
	const t = useT();
	const navigate = useNavigate();

	return (
		<div className="flex items-center justify-center min-h-screen">
			<Empty
				icon={<WarningIcon size={48} className="text-kumo-inactive" />}
				title={t("404 -- Page Not Found")}
				description={t("The page you're looking for doesn't exist.")}
				contents={
					<Button variant="primary" size="sm" onClick={() => navigate("/")}>
						{t("Go Home")}
					</Button>
				}
			/>
		</div>
	);
}
