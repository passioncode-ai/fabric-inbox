// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Empty,
	LinkProvider,
	Loader,
	Toasty,
	TooltipProvider,
} from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { forwardRef, useEffect, useState } from "react";
import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Link as RouterLink,
	Scripts,
	ScrollRestoration,
} from "react-router";
import MutationErrorToasts from "~/components/MutationErrorToasts";
import { ApiError } from "~/services/api";
import { reloadForMissingCode, UPDATE_EVENT } from "~/lib/build-version";
import "./index.css";

function makeQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				refetchOnWindowFocus: false,
				retry: (failureCount, error) => {
					// Don't retry 4xx errors (not found, unauthorized, etc.)
					if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
						return false;
					}
					return failureCount < 2;
				},
			},
		},
		mutationCache: new MutationCache({
			onError: (error) => {
				// Log every failure. What the user sees is <MutationErrorToasts />:
				// it toasts mutations that declare `meta.errorMessage`; consumers
				// using mutateAsync + try/catch report their own errors.
				console.error("Mutation failed:", error);
			},
		}),
	});
}

// Lazy singleton for the browser — avoids module-scope instantiation that
// leaks cache across SSR requests.
let browserQueryClient: QueryClient | undefined;
function getQueryClient() {
	if (typeof window === "undefined") {
		// SSR: always create a fresh client per request to prevent cross-user cache leaks
		return makeQueryClient();
	}
	// Browser: reuse the same client across navigations
	if (!browserQueryClient) browserQueryClient = makeQueryClient();
	return browserQueryClient;
}

const KumoLink = forwardRef<
	HTMLAnchorElement,
	React.AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string }
>(function KumoLink({ href, ...props }, ref) {
	if (href && !href.startsWith("http")) {
		return (
			<RouterLink to={href} ref={ref} {...(props as Record<string, unknown>)} />
		);
	}
	return <a href={href} ref={ref} {...props} />;
});

export function Layout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" data-theme="light" suppressHydrationWarning>
			<head>
				<meta charSet="UTF-8" />
                <script dangerouslySetInnerHTML={{__html: `try{var t=localStorage.getItem("fabric-inbox:theme");document.documentElement.dataset.theme=t==="dark"?"dark":"light"}catch{}`}} />
				<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Fabric Inbox</title>
				<Meta />
				<Links />
			</head>
			<body className="bg-kumo-recessed text-kumo-default antialiased">
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export function HydrateFallback() {
	return (
		<div className="flex items-center justify-center h-screen">
			<Loader size="lg" />
		</div>
	);
}

/**
 * The server was updated after this page loaded (P3-13): offer to reload, and reload once by
 * itself when a piece of the old page's code can no longer be fetched.
 */
function UpdateNotice() {
	const [available, setAvailable] = useState(false);
	useEffect(() => {
		const onUpdate = () => setAvailable(true);
		const onMissingCode = (event: Event) => {
			let storage: Storage | undefined;
			try { storage = window.sessionStorage; } catch { storage = undefined; }
			if (reloadForMissingCode(storage, () => window.location.reload())) event.preventDefault();
			else setAvailable(true);
		};
		window.addEventListener(UPDATE_EVENT, onUpdate);
		window.addEventListener("vite:preloadError", onMissingCode);
		return () => {
			window.removeEventListener(UPDATE_EVENT, onUpdate);
			window.removeEventListener("vite:preloadError", onMissingCode);
		};
	}, []);
	if (!available) return null;
	return (
		<div className="fi-update-notice" role="status">
			A new version of Fabric Inbox is on the server.{" "}
			<button type="button" className="fi-text-button" onClick={() => window.location.reload()}>Reload to update</button>
		</div>
	);
}

export default function App() {
	// Use useState to ensure each SSR request gets a fresh client while the
	// browser reuses the same singleton across navigations.
	const [queryClient] = useState(getQueryClient);
	return (
		<QueryClientProvider client={queryClient}>
			<LinkProvider component={KumoLink}>
				<TooltipProvider>
					<Toasty>
						<MutationErrorToasts />
						<UpdateNotice />
						<Outlet />
					</Toasty>
				</TooltipProvider>
			</LinkProvider>
		</QueryClientProvider>
	);
}

export function ErrorBoundary({ error }: { error: unknown }) {
	let title = "Something went wrong";
	let description = "An unexpected error occurred. Please try again.";
	let status: number | null = null;

	if (isRouteErrorResponse(error)) {
		status = error.status;
		if (error.status === 404) {
			title = "Page not found";
			description =
				"The page you're looking for doesn't exist or has been moved.";
		} else {
			title = `Error ${error.status}`;
			description = error.statusText || description;
		}
	} else if (error instanceof Error && import.meta.env.DEV) {
		description = error.message;
	}

	return (
		<div className="flex items-center justify-center min-h-screen p-8">
			<Empty
				icon={<WarningIcon size={48} className="text-kumo-inactive" />}
				title={status === 404 ? "404 — Page not found" : title}
				description={description}
				contents={
					<Button
						variant="primary"
						onClick={() => {
							window.location.href = "/";
						}}
					>
						Go Home
					</Button>
				}
			/>
		</div>
	);
}
