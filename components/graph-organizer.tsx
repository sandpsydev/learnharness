"use client";

/**
 * The knowledge-organizer on the graph page (medical fork, docs/medical-spec.md
 * "Knowledge organizer"). A chat panel: the learner says how they want the
 * graph arranged; the organizer agent answers and may attach a PROPOSAL — a set
 * of changes shown as before → after. Nothing in the graph changes until the
 * learner presses Accept; an applied set can be undone while it is the newest.
 *
 * The conversation lives here (the server keeps no chat state). The agent
 * sees it as plain text, each proposal tagged with what the learner decided,
 * so "the second one is wrong" and "yes, do that" keep working.
 */

import { useEffect, useRef, useState } from "react";
import { CheckIcon, Loader2Icon, Undo2Icon, WandSparklesIcon, XIcon } from "lucide-react";
import type {
	OrganizerChangePreview,
	OrganizerHistoryItem,
	OrganizerMessage,
	OrganizerProposal,
} from "@/src/core";
import { Hint } from "@/components/ui/hint";

// ---- Conversation model (pure) ----------------------------------------------

/** What happened to a proposal. */
export type ProposalDecision = "pending" | "applying" | "applied" | "rejected" | "undone" | "failed";

export type OrganizerItem =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string; proposal?: OrganizerProposal; decision?: ProposalDecision; entryId?: string; problems?: string[]; error?: string }
	| { kind: "error"; text: string };

const DECISION_NOTE: Record<ProposalDecision, string> = {
	pending: "The learner has not decided on this proposal yet.",
	applying: "The learner has not decided on this proposal yet.",
	applied: "The learner accepted this proposal and it was applied to the graph.",
	rejected: "The learner rejected this proposal; nothing was changed.",
	undone: "The learner accepted this proposal, then undid it; the graph is back as it was.",
	failed: "The learner accepted this proposal but it could not be applied; nothing was changed.",
};

/** The turns the server's agent receives: each proposal followed by its fate. */
export function toAgentMessages(items: readonly OrganizerItem[]): OrganizerMessage[] {
	const out: OrganizerMessage[] = [];
	for (const item of items) {
		if (item.kind === "user") out.push({ role: "user", text: item.text });
		else if (item.kind === "assistant") {
			const note = item.proposal ? `\n\n[${DECISION_NOTE[item.decision ?? "pending"]}]` : "";
			out.push({ role: "assistant", text: `${item.text}${note}` });
		}
	}
	return out;
}

// ---- Presentational pieces (exported for static render tests) ---------------

export function OrganizerChangeCard({ preview }: { preview: OrganizerChangePreview }) {
	return (
		<div data-testid="organizer-change" className="rounded-lg border bg-background/60 px-2.5 py-2">
			<div className="text-xs font-medium leading-snug text-foreground">{preview.title}</div>
			<dl className="mt-1.5 flex flex-col gap-1">
				{preview.rows.map((row, i) => (
					<div key={`${row.field}-${i}`} className="text-[11px] leading-snug">
						<dt className="text-muted-foreground">{row.field}</dt>
						{row.before !== undefined && (
							<dd data-testid="organizer-before" className="text-muted-foreground line-through decoration-muted-foreground/50">
								{row.before}
							</dd>
						)}
						{row.after !== undefined && (
							<dd data-testid="organizer-after" className="text-foreground">
								{row.after}
							</dd>
						)}
					</div>
				))}
			</dl>
		</div>
	);
}

const DECISION_LABEL: Partial<Record<ProposalDecision, string>> = {
	applied: "Applied",
	rejected: "Rejected — nothing changed",
	undone: "Undone — the graph is back as it was",
	failed: "Not applied — nothing changed",
};

export function OrganizerProposalCard({
	proposal,
	decision,
	problems,
	error,
	canUndo,
	onAccept,
	onReject,
	onUndo,
}: {
	proposal: OrganizerProposal;
	decision: ProposalDecision;
	problems?: readonly string[];
	error?: string;
	canUndo: boolean;
	onAccept: () => void;
	onReject: () => void;
	onUndo: () => void;
}) {
	const open = decision === "pending" || decision === "applying";
	return (
		<div data-testid="organizer-proposal" data-decision={decision} className="mt-2 rounded-xl border bg-card p-2.5">
			<div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
				Proposed change{proposal.previews.length === 1 ? "" : `s (${proposal.previews.length})`}
			</div>
			<div className="mt-1.5 flex flex-col gap-1.5">
				{proposal.previews.map((preview, i) => (
					<OrganizerChangeCard key={i} preview={preview} />
				))}
			</div>
			{problems && problems.length > 0 && (
				<ul data-testid="organizer-problems" className="mt-2 list-disc pl-4 text-[11px] text-destructive">
					{problems.map((p, i) => (
						<li key={i}>{p}</li>
					))}
				</ul>
			)}
			{error && (
				<div data-testid="organizer-error" className="mt-2 text-[11px] text-destructive">
					{error}
				</div>
			)}
			{open ? (
				<div className="mt-2.5 flex gap-2">
					<button
						type="button"
						disabled={decision === "applying"}
						data-testid="organizer-accept"
						onClick={onAccept}
						className="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-50"
					>
						{decision === "applying" ? <Loader2Icon className="size-3 animate-spin" /> : <CheckIcon className="size-3" />}
						Accept
					</button>
					<button
						type="button"
						disabled={decision === "applying"}
						data-testid="organizer-reject"
						onClick={onReject}
						className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
					>
						<XIcon className="size-3" />
						Reject
					</button>
				</div>
			) : (
				<div className="mt-2.5 flex items-center gap-2 text-[11px] text-muted-foreground">
					<span data-testid="organizer-status">{DECISION_LABEL[decision]}</span>
					{decision === "applied" && canUndo && (
						<button
							type="button"
							data-testid="organizer-undo"
							onClick={onUndo}
							className="flex items-center gap-1 rounded-lg border px-2 py-0.5 text-foreground transition-colors hover:bg-accent"
						>
							<Undo2Icon className="size-3" />
							Undo
						</button>
					)}
				</div>
			)}
		</div>
	);
}

/** The panel body, props-only: the transcript, the composer, the hint. */
export function OrganizerPanelBody({
	items,
	history,
	busy,
	input,
	onInput,
	onSend,
	onClose,
	onAccept,
	onReject,
	onUndo,
}: {
	items: readonly OrganizerItem[];
	history: readonly OrganizerHistoryItem[];
	busy: boolean;
	input: string;
	onInput: (value: string) => void;
	onSend: () => void;
	onClose: () => void;
	onAccept: (index: number) => void;
	onReject: (index: number) => void;
	onUndo: (index: number) => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, [items.length, busy]);
	const undoable = history.find((h) => h.canUndo)?.id;
	return (
		<div
			data-testid="organizer-panel"
			data-graph-occluder=""
			className="absolute right-0 top-full z-30 mt-2 flex h-[min(34rem,70vh)] w-[26rem] max-w-[calc(100vw-1.5rem)] flex-col rounded-xl border bg-card/95 text-xs shadow-lg backdrop-blur"
		>
			<div className="flex items-center justify-between border-b px-3 py-2">
				<div className="text-sm font-medium">Organize your graph</div>
				<button
					type="button"
					aria-label="Close organizer"
					data-testid="organizer-close"
					onClick={onClose}
					className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-3.5" />
				</button>
			</div>
			<div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-2.5">
				{items.length === 0 && (
					<p data-testid="organizer-empty" className="leading-relaxed text-muted-foreground">
						Tell me how you want the graph arranged — create, rename or reword nodes, change their tags, add or remove
						connections. I&apos;ll propose the changes first; nothing happens until you accept, and you can undo it
						afterwards. I can&apos;t delete or merge nodes.
					</p>
				)}
				{items.map((item, i) =>
					item.kind === "user" ? (
						<div key={i} className="ml-8 self-end rounded-xl bg-primary px-2.5 py-1.5 text-primary-foreground">
							{item.text}
						</div>
					) : item.kind === "error" ? (
						<div key={i} data-testid="organizer-failure" className="text-[11px] text-destructive">
							{item.text}
						</div>
					) : (
						<div key={i} className="mr-4">
							<div className="whitespace-pre-wrap leading-relaxed text-foreground">{item.text}</div>
							{item.proposal && (
								<OrganizerProposalCard
									proposal={item.proposal}
									decision={item.decision ?? "pending"}
									problems={item.problems}
									error={item.error}
									canUndo={item.entryId !== undefined && item.entryId === undoable}
									onAccept={() => onAccept(i)}
									onReject={() => onReject(i)}
									onUndo={() => onUndo(i)}
								/>
							)}
						</div>
					),
				)}
				{busy && (
					<div className="flex items-center gap-1.5 text-muted-foreground">
						<Loader2Icon className="size-3 animate-spin" />
						Looking at your graph…
					</div>
				)}
			</div>
			<div className="border-t p-2">
				<textarea
					value={input}
					onChange={(e) => onInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							onSend();
						}
					}}
					rows={2}
					placeholder="e.g. Rename “Anion gap” to “Serum anion gap” and tag it Renal, Diagnosis"
					aria-label="Message to the organizer"
					data-testid="organizer-input"
					className="w-full resize-none rounded-lg border bg-background px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
				/>
				<div className="mt-1 flex justify-end">
					<button
						type="button"
						disabled={busy || input.trim() === ""}
						data-testid="organizer-send"
						onClick={onSend}
						className="rounded-lg bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
					>
						Send
					</button>
				</div>
			</div>
		</div>
	);
}

// ---- The control: button + panel + the conversation's state -----------------

async function postJson<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string; problems?: string[] } }> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await res.json().catch(() => ({}))) as T & { error?: string; problems?: string[] };
	return { ok: res.ok, status: res.status, data };
}

export function GraphOrganizerControl({
	onGraphChanged,
	initiallyOpen = false,
}: {
	/** The graph changed (applied or undone): the caller refetches it. */
	onGraphChanged: (graphRevision: number) => void;
	initiallyOpen?: boolean;
}) {
	const [open, setOpen] = useState(initiallyOpen);
	const [items, setItems] = useState<OrganizerItem[]>([]);
	const [history, setHistory] = useState<OrganizerHistoryItem[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);

	// The applied-sets list decides which Undo button is live; load it when
	// the panel first opens (a reload keeps the newest set undoable).
	const loaded = useRef(false);
	useEffect(() => {
		if (!open || loaded.current) return;
		loaded.current = true;
		void fetch("/api/graph/organizer")
			.then((r) => r.json())
			.then((b: { history?: OrganizerHistoryItem[] }) => setHistory(b.history ?? []))
			.catch(() => {});
	}, [open]);

	const patchItem = (index: number, patch: Partial<Extract<OrganizerItem, { kind: "assistant" }>>) =>
		setItems((cur) => cur.map((it, i) => (i === index && it.kind === "assistant" ? { ...it, ...patch } : it)));

	const send = async () => {
		const text = input.trim();
		if (text === "" || busy) return;
		const next: OrganizerItem[] = [...items, { kind: "user", text }];
		setItems(next);
		setInput("");
		setBusy(true);
		try {
			const { ok, data } = await postJson<{ reply?: string; proposal?: OrganizerProposal | null }>(
				"/api/graph/organizer",
				{ messages: toAgentMessages(next) },
			);
			if (!ok || data.reply === undefined) {
				setItems((cur) => [...cur, { kind: "error", text: data.error ?? "The organizer could not answer." }]);
				return;
			}
			const proposal = data.proposal ?? undefined;
			setItems((cur) => [
				...cur,
				{ kind: "assistant", text: data.reply!, ...(proposal ? { proposal, decision: "pending" as const } : {}) },
			]);
		} catch {
			setItems((cur) => [...cur, { kind: "error", text: "The organizer could not answer." }]);
		} finally {
			setBusy(false);
		}
	};

	const accept = async (index: number) => {
		const item = items[index];
		if (!item || item.kind !== "assistant" || !item.proposal) return;
		patchItem(index, { decision: "applying", problems: undefined, error: undefined });
		try {
			const { ok, data } = await postJson<{ entryId?: string; graphRevision?: number; history?: OrganizerHistoryItem[] }>(
				"/api/graph/organizer/apply",
				{ proposalId: item.proposal.id },
			);
			if (!ok) {
				// Nothing was written. Keep the card visible with the reasons.
				patchItem(index, { decision: "failed", problems: data.problems, error: data.error ?? "Applying failed." });
				return;
			}
			patchItem(index, { decision: "applied", entryId: data.entryId });
			if (data.history) setHistory(data.history);
			onGraphChanged(data.graphRevision ?? 0);
		} catch {
			patchItem(index, { decision: "failed", error: "Applying failed." });
		}
	};

	const undo = async (index: number) => {
		const item = items[index];
		if (!item || item.kind !== "assistant" || !item.entryId) return;
		try {
			const { ok, data } = await postJson<{ graphRevision?: number; history?: OrganizerHistoryItem[] }>(
				"/api/graph/organizer/undo",
				{ entryId: item.entryId },
			);
			if (!ok) {
				patchItem(index, { error: data.error ?? "Undo failed." });
				return;
			}
			patchItem(index, { decision: "undone", error: undefined });
			if (data.history) setHistory(data.history);
			onGraphChanged(data.graphRevision ?? 0);
		} catch {
			patchItem(index, { error: "Undo failed." });
		}
	};

	return (
		<div className="relative">
			<Hint label="Ask an agent to organize the graph" side="bottom">
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
					data-testid="open-organizer"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
				>
					<WandSparklesIcon className="size-3" />
					Organize
				</button>
			</Hint>
			{open && (
				<OrganizerPanelBody
					items={items}
					history={history}
					busy={busy}
					input={input}
					onInput={setInput}
					onSend={() => void send()}
					onClose={() => setOpen(false)}
					onAccept={(i) => void accept(i)}
					onReject={(i) => patchItem(i, { decision: "rejected" })}
					onUndo={(i) => void undo(i)}
				/>
			)}
		</div>
	);
}
