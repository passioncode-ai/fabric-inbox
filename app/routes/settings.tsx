// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	ArrowBendUpRightIcon, AtIcon, BooksIcon, CaretLeftIcon, FunnelSimpleIcon, GearSixIcon, GlobeIcon, PlugIcon, ProhibitIcon, XCircleIcon,
	RobotIcon, UserCircleIcon, type Icon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link, Navigate, useParams, type MetaArgs } from "react-router";
import { DEFAULT_SECTION, SECTIONS, isSection, settingsPath, type SectionId } from "~/components/settings/paths";
import { ConfirmProvider, WorkProvider } from "~/components/settings/ui";
import { StepMemory } from "~/components/settings/sections/data";
import type { Step } from "~/services/domains";
import AddressesSection from "~/components/settings/sections/AddressesSection";
import DomainsSection from "~/components/settings/sections/DomainsSection";
import AccountsSection from "~/components/settings/sections/AccountsSection";
import DestinationsSection from "~/components/settings/sections/DestinationsSection";
import AgentsSection from "~/components/settings/sections/AgentsSection";
import KnowledgeSection from "~/components/settings/sections/KnowledgeSection";
import CategoriesSection from "~/components/settings/sections/CategoriesSection";
import SpamSection from "~/components/settings/sections/SpamSection";
import DiscardSection from "~/components/settings/sections/DiscardSection";
import AgentAccessSection from "~/components/settings/sections/AgentAccessSection";
import AppSection from "~/components/settings/sections/AppSection";
import { metaT, useT } from "~/lib/i18n";
import { msg } from "../../shared/i18n";

export function meta({ matches }: MetaArgs) {
	const t = metaT(matches);
	return [{ title: t("Settings · Fabric Inbox") }];
}

const ICONS: Record<SectionId, Icon> = {
	addresses: AtIcon, domains: GlobeIcon, accounts: UserCircleIcon, destinations: ArrowBendUpRightIcon,
	categories: FunnelSimpleIcon, spam: ProhibitIcon, discard: XCircleIcon, agents: RobotIcon, knowledge: BooksIcon, "agent-access": PlugIcon, app: GearSixIcon,
};

const GROUP_LABEL = { mail: msg("Mail"), agents: msg("Agents"), app: msg("This app") } as const;

/**
 * SCR-02 Settings: one screen at /settings/:section/:id?/:tab?. The section list on the left is
 * mounted once and never moves; each section is a list with the chosen item's panel beside it.
 * The selection is the address, so a link, Back and a reload all land on the same item, and the
 * page itself never scrolls (the 2026-10-06 audit: choosing a domain jumped to the top).
 */
export default function Settings() {
	const t = useT();
	const { section, id, tab } = useParams();
	// Steps of the last action on each domain outlive its panel and the section (DomainsSection).
	const [steps, setSteps] = useState<Record<string, Step[]>>({});
	const memory = useMemo(() => ({
		get: (domain: string) => steps[domain] ?? [],
		set: (domain: string, s: Step[]) => setSteps((m) => ({ ...m, [domain]: s })),
	}), [steps]);

	if (!section) return <Navigate to={settingsPath(DEFAULT_SECTION)} replace />;
	if (!isSection(section)) return <Navigate to={settingsPath(DEFAULT_SECTION)} replace />;
	const item = id ?? null;
	const sub = tab ?? null;

	return (
		<ConfirmProvider>
			<StepMemory.Provider value={memory}>
				<div className="fi-settings">
					<nav className="fi-settings-nav" aria-label={t("Settings sections")}>
						<Link to="/" className="fi-nav-item fi-settings-back"><CaretLeftIcon size={16} /><span>{t("Back to mail")}</span></Link>
						{(["mail", "agents", "app"] as const).map((group) => (
							<div key={group} role="group" aria-label={t.text(GROUP_LABEL[group])} style={{ display: "contents" }}>
								<div className="fi-settings-nav-group" aria-hidden="true">{t.text(GROUP_LABEL[group])}</div>
								{SECTIONS.filter((s) => s.group === group).map((s) => {
									const Icon = ICONS[s.id];
									return (
										<Link key={s.id} to={settingsPath(s.id)} preventScrollReset className="fi-nav-item"
											aria-current={s.id === section ? "page" : undefined}>
											<Icon size={18} aria-hidden="true" /><span>{t.text(s.label)}</span>
										</Link>
									);
								})}
							</div>
						))}
					</nav>
					<main className="fi-settings-main">
						<WorkProvider key={section}>
							{section === "addresses" && <AddressesSection id={item} tab={sub} />}
							{section === "domains" && <DomainsSection id={item} />}
							{section === "accounts" && <AccountsSection id={item} />}
							{section === "destinations" && <DestinationsSection id={item} />}
							{section === "agents" && <AgentsSection id={item} tab={sub} />}
							{section === "knowledge" && <KnowledgeSection id={item} />}
							{section === "categories" && <CategoriesSection id={item} />}
							{section === "spam" && <SpamSection id={item} />}
							{section === "discard" && <DiscardSection id={item} />}
							{section === "agent-access" && <AgentAccessSection id={item} />}
							{section === "app" && <AppSection id={item} />}
						</WorkProvider>
					</main>
				</div>
			</StepMemory.Provider>
		</ConfirmProvider>
	);
}
