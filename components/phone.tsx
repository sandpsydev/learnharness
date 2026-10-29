"use client";

/**
 * Pocket mode's phone layout (Phase 8): the one place that says what "phone"
 * means and the few pieces every phone screen shares.
 *
 * A phone is a viewport narrower than Tailwind's `sm` (640px). The desktop
 * app's window can't go below 640px (electron/main.cjs sets that floor), so
 * the Mac app never sees the phone layout; a browser tab on the Mac only
 * does if the learner makes it that narrow. Everything phone-only is written
 * as `sm:hidden` / `max-sm:hidden`, so at 640px and wider the screens render
 * exactly as before.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore, type ReactNode } from "react";
import { ChevronLeftIcon, DumbbellIcon, HomeIcon, ListChecksIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** The same boundary as Tailwind's `max-sm:` (width < 40rem). */
export const PHONE_QUERY = "(max-width: 639.98px)";

function subscribe(onChange: () => void): () => void {
	const media = window.matchMedia(PHONE_QUERY);
	media.addEventListener("change", onChange);
	return () => media.removeEventListener("change", onChange);
}

/** true on a phone-width viewport, false otherwise; null while the server
 *  (or the first client render) can't know yet. */
export function usePhone(): boolean | null {
	return useSyncExternalStore<boolean | null>(
		subscribe,
		() => window.matchMedia(PHONE_QUERY).matches,
		() => null,
	);
}

/**
 * Picks the phone or the desktop version of a whole screen. Until the width
 * is known (the server render and the first client render) BOTH are in the
 * page and CSS shows the right one, so neither flashes; once known only the
 * matching one stays mounted. The keys keep the desktop screen mounted
 * through that hand-over, so it never remounts or refetches.
 */
export function ResponsiveSwitch({ desktop, phone }: { desktop: ReactNode; phone: ReactNode }) {
	const isPhone = usePhone();
	return (
		<>
			{isPhone !== true && <div key="desktop" className="contents max-sm:hidden">{desktop}</div>}
			{isPhone !== false && <div key="phone" className="contents sm:hidden">{phone}</div>}
		</>
	);
}

/** The phone's tab bar. Only things the phone does; the Mac-only parts
 *  (graph, settings, library, Anki, asking Expert AI) have no tab. */
export const PHONE_TABS = [
	{ href: "/", label: "Home", icon: HomeIcon },
	{ href: "/practice", label: "Practice", icon: DumbbellIcon },
	{ href: "/queue", label: "Expert AI", icon: ListChecksIcon },
] as const;

/** Sessions have their own back button and a composer at the bottom, so the
 *  tab bar steps aside there. */
export function showsPhoneNav(pathname: string | null): boolean {
	return !(pathname ?? "").startsWith("/chat/");
}

export function PhoneNavView({ pathname }: { pathname: string | null }) {
	if (!showsPhoneNav(pathname)) return null;
	return (
		<nav
			data-testid="phone-nav"
			aria-label="Pocket mode"
			className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-background pb-[env(safe-area-inset-bottom)] sm:hidden"
		>
			{PHONE_TABS.map(({ href, label, icon: Icon }) => {
				const active = href === "/" ? pathname === "/" || pathname === "/capture" : (pathname ?? "").startsWith(href);
				return (
					<Link
						key={href}
						href={href}
						aria-current={active ? "page" : undefined}
						data-testid={`phone-tab-${label.toLowerCase().replace(/\s+/g, "-")}`}
						className={cn(
							"flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 font-ui text-[11px] uppercase tracking-wider transition-colors",
							active ? "text-foreground" : "text-muted-foreground",
						)}
					>
						<Icon aria-hidden="true" className="size-5" />
						{label}
					</Link>
				);
			})}
		</nav>
	);
}

export function PhoneNav() {
	return <PhoneNavView pathname={usePathname()} />;
}

/** The phone's way back from a session, in place of the hidden sidebar. */
/** The phone's way back from a session, in place of the hidden sidebar. A plain
 *  anchor (a full page load), not next/link: it renders inside TopBar, which
 *  the DOM-mounted tests render without a router. */
export function PhoneBack() {
	return (
		// eslint-disable-next-line @next/next/no-html-link-for-pages -- see the note above
		<a
			href="/"
			aria-label="Back to home"
			data-testid="phone-back"
			className="lh-no-drag -ml-1 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:hidden"
		>
			<ChevronLeftIcon aria-hidden="true" className="size-5" />
		</a>
	);
}

/** A page's phone header: the title, with the room the tab bar needs below. */
export function PhonePage({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="min-h-dvh">
			<header className="px-4 pb-1 pt-4">
				<h1 className="font-ui text-sm uppercase tracking-wider text-muted-foreground">{title}</h1>
			</header>
			<main className="mx-auto flex w-full max-w-[34rem] flex-col gap-5 px-4 pb-28 pt-2">{children}</main>
		</div>
	);
}

/** Shown instead of the setup buttons on a phone: connecting models is a
 *  settings job, and settings stay on the Mac. */
export function PhoneSetupNote() {
	return (
		<span data-testid="phone-setup-note" className="font-ui text-xs text-muted-foreground sm:hidden">
			Set up your models on the Mac first.
		</span>
	);
}
