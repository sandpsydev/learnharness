import { chainsForSelection, formatChainLine } from "@/src/core";
import { missSessionTitle, newGraphContextMessage, newMissFlowMessage, type GraphContextPick } from "@/src/core";
import { compactionInFlight, createStampedChat, isTurnRunning, listChats, stores, titleFromPrompt } from "@/src/server";
import type { ChatListItem } from "@/src/core";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn marks the session busy
 *  (contracts.ts ChatListItem; the store can't see liveness, the route is
 *  the merge point). Owner, minimal-color round: background jobs NO LONGER
 *  count — the sidebar's Background agents section is their channel now
 *  (a running spinner per row would double-signal them), so busy means
 *  exactly "a teach turn is in flight". */
export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: compactionInFlight(c.id),
	}));
	return Response.json({ chats });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; kind?: unknown; flow?: unknown; graphContext?: unknown };
	// EXPLAIN MY MISS (medical fork, Phase 7): flow "miss" starts an ordinary
	// teaching session (kind stays teach, so extraction runs as normal) with
	// a miss marker as message[0]. The title is FIXED here, whatever the
	// client sent: the learner's pasted question must never become the
	// session title (question-bank wording stays out of the sidebar).
	const miss = body.flow === "miss";
	const title = miss ? missSessionTitle() : typeof body.title === "string" ? body.title : "";
	// Practice sessions (owner, 2026-10-04): kind "practice" marks the
	// record — the practice agent + its tools from turn 1, no extraction.
	const kind = body.kind === "practice" ? ("practice" as const) : undefined;
	// PER-SESSION MODELS (owner, 2026-09-28): the new session is stamped from the
	// strong slot — see createStampedChat.
	const chat = createStampedChat(miss ? title : titleFromPrompt(title || "Untitled session"), miss ? undefined : kind);
	// The session's map context (owner, 2026-10-04): the picked
	// propositions ride the CREATION — message[0] is a graph-context
	// marker (a separate custom message BEFORE the learner's first user
	// message), carrying the picks plus the reasoning chains among them.
	// The picks carry their own name/statement (what the learner saw at
	// pick time); the chains derive from the CURRENT graph snapshot.
	const rawPicks = (body.graphContext as { propositions?: unknown } | undefined)?.propositions;
	const picks: GraphContextPick[] = Array.isArray(rawPicks)
		? rawPicks
				.filter(
						(p): p is GraphContextPick =>
							typeof p === "object" &&
							p !== null &&
							typeof (p as GraphContextPick).id === "string" &&
							typeof (p as GraphContextPick).name === "string" &&
							typeof (p as GraphContextPick).statement === "string",
					)
			: [];
	if (picks.length > 0 && !miss) {
		const byId = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
		// Resolve tags from the current stored graph: older callers also get
		// medical context, and request payloads cannot invent tag values.
		const taggedPicks = picks.map(({ id, name, statement }) => {
			const node = byId.get(id);
			return {
				id, name, statement,
				...(node?.systems ? { systems: node.systems } : {}),
				...(node?.factType ? { factType: node.factType } : {}),
			};
		});
		const pickedNodes = picks.map((p) => byId.get(p.id)).filter((n) => n !== undefined);
		const chainLines = chainsForSelection(pickedNodes, stores.graphStore.readChains()).map((c) =>
			formatChainLine(c, Object.fromEntries(byId)),
		);
		stores.chatStore.saveMessages(chat.id, [newGraphContextMessage(taggedPicks, chainLines)]);
	}
	if (miss) stores.chatStore.saveMessages(chat.id, [newMissFlowMessage()]);
	return Response.json({ id: chat.id, title: chat.title });
}
