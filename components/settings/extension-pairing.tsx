"use client";
/**
 * Settings → Browser extension (medical fork): the two things the learner
 * pastes into the LearnHarness browser extension — the app's local address
 * and the pairing token (docs/verify-api.md). Collapsed until asked, so
 * opening Settings never fetches the token and the secret is not on screen
 * by default. GET /api/verify/pairing.
 */

import { useState } from "react";

interface Pairing {
	running: boolean;
	address: string | null;
	token: string;
	extensionLastSeen: string | null;
}

export function ExtensionPairing() {
	const [pairing, setPairing] = useState<Pairing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState<"address" | "token" | null>(null);

	async function show() {
		setError(null);
		try {
			const resp = await fetch("/api/verify/pairing");
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			setPairing((await resp.json()) as Pairing);
		} catch (err) {
			setError(`Could not load the pairing details (${err instanceof Error ? err.message : String(err)}).`);
		}
	}

	async function copy(what: "address" | "token", value: string) {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(what);
			setTimeout(() => setCopied(null), 1500);
		} catch {
			setError("Copying was blocked — select the text and copy it by hand.");
		}
	}

	if (!pairing) {
		return (
			<div data-testid="extension-pairing">
				<button
					type="button"
					onClick={() => void show()}
					data-testid="extension-pairing-show"
					className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent/50"
				>
					<span className="font-ui text-xs text-foreground">Pairing details</span>
					<span className="font-mono text-[11px] text-muted-foreground">show</span>
				</button>
				{error && <p role="alert" className="px-1 text-xs text-red-500">{error}</p>}
			</div>
		);
	}

	return (
		<div data-testid="extension-pairing" className="flex flex-col gap-1.5 px-1">
			{!pairing.running && (
				<p role="alert" data-testid="extension-pairing-off" className="text-xs text-red-500">
					The extension connection is off: its local port is already in use (is another LearnHarness running?).
				</p>
			)}
			<Field label="Address" value={pairing.address ?? "unavailable"} copied={copied === "address"} onCopy={pairing.address ? () => void copy("address", pairing.address as string) : undefined} />
			<Field label="Pairing token" value={pairing.token} copied={copied === "token"} onCopy={() => void copy("token", pairing.token)} />
			<p className="text-[11px] leading-relaxed text-muted-foreground/70">
				{pairing.extensionLastSeen
					? `The extension last connected ${new Date(pairing.extensionLastSeen).toLocaleString()}.`
					: "The extension has not connected yet this run."}
			</p>
			{error && <p role="alert" className="text-xs text-red-500">{error}</p>}
		</div>
	);
}

function Field({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy?: () => void }) {
	return (
		<div className="flex items-center gap-2">
			<span className="w-24 shrink-0 font-ui text-xs text-foreground">{label}</span>
			<code className="min-w-0 flex-1 truncate rounded-sm border border-border bg-background px-1.5 py-1 font-mono text-[11px] text-foreground">{value}</code>
			{onCopy && (
				<button type="button" onClick={onCopy} className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline">
					{copied ? "Copied" : "Copy"}
				</button>
			)}
		</div>
	);
}
