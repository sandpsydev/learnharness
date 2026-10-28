/**
 * POST /api/graph/tags/backfill — the one-off "tag existing nodes" action
 * (docs/medical-spec.md Phase 4). Asks the model for the organ system(s) and
 * fact type of every node that has none and APPENDS the answers; tags that
 * already exist are never touched. Runs to completion before answering (the
 * graph view shows a spinner meanwhile) and returns what it did. 409 while
 * another back-fill is running; the config refusals (no model / no key) use
 * the same 503 envelopes as the notes import.
 */
import { extraction, graphRevision } from "@/src/server";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "@/src/core";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	try {
		const stats = await extraction.tagExistingNodes(request.signal);
		return Response.json({ ...stats, graphRevision: graphRevision() });
	} catch (err) {
		if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
			return Response.json(err.envelope, { status: 503 });
		}
		const message = err instanceof Error ? err.message : String(err);
		if (message === "Tagging is already running.") return Response.json({ error: message }, { status: 409 });
		console.error("[graph] tag back-fill failed:", err);
		return Response.json({ error: message }, { status: 500 });
	}
}
