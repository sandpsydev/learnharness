/**
 * The knowledge-organizer (graph page agent, medical fork).
 *
 * POST /api/graph/organizer   body { messages: [{role, text}] } — the
 *   conversation so far, the learner's message last. Runs the organizer agent
 *   and answers { reply, proposal? }. A proposal is only a PROPOSAL: nothing
 *   in the graph has changed until it is accepted (…/apply).
 * GET  /api/graph/organizer   the applied change sets (newest first), for the
 *   Undo button. Config refusals use the same 503 envelopes as the other model
 *   features.
 */
import { graphOrganizer, parseOrganizerMessages } from "@/src/server";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "@/src/core";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ history: graphOrganizer.history() });
}

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const messages = parseOrganizerMessages((body as { messages?: unknown } | null)?.messages);
	if (typeof messages === "string") return Response.json({ error: messages }, { status: 400 });
	try {
		const outcome = await graphOrganizer.chat(messages, request.signal);
		if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
		return Response.json({ reply: outcome.reply, proposal: outcome.proposal ?? null });
	} catch (err) {
		if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
			return Response.json(err.envelope, { status: 503 });
		}
		if (request.signal.aborted) return Response.json({ error: "Cancelled" }, { status: 499 });
		console.error("[graph] organizer failed:", err);
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
}
