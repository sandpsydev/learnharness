"use client";

import { CaptureBox, CaptureRow, useCaptures } from "@/components/captures";
import { SidebarToggle } from "@/components/sidebar";

/**
 * /capture — the phone's front door for Pocket mode: type a question or topic
 * in seconds (the phone keyboard's dictation works), see what is waiting, and
 * start a session right away if you want. Single narrow column that fits a
 * phone and still looks fine on the Mac. pocket-layout builds the rest of the
 * phone layout around this page.
 */
export function CapturePage({ initialConfigured }: { initialConfigured: boolean }) {
	const state = useCaptures(initialConfigured);
	return (
		<div className="min-h-dvh">
			<header className="flex items-center gap-2 px-3 py-2">
				<SidebarToggle />
				<h1 className="font-ui text-sm uppercase tracking-wider text-muted-foreground">Capture</h1>
			</header>
			<main className="mx-auto flex w-full max-w-[34rem] flex-col gap-5 px-4 pb-10 pt-2 max-sm:pb-28">
				<CaptureBox state={state} />
				{state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
				<section aria-label="Tonight's questions" className="flex flex-col gap-2">
					<h2 className="font-ui text-xs uppercase tracking-wider text-muted-foreground">
						Tonight&apos;s questions · {state.captures.length}
					</h2>
					{state.captures.length === 0 ? (
						<p className="text-sm text-muted-foreground">Nothing waiting. Anything you save shows up here and on the Mac&apos;s home screen.</p>
					) : (
						<ul className="flex flex-col gap-2">
							{state.captures.map((c) => <CaptureRow key={c.id} capture={c} actions={state} />)}
						</ul>
					)}
				</section>
			</main>
		</div>
	);
}
