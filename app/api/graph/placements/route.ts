/**
 * /api/graph/placements — the outline placement service (medical fork,
 * docs/medical-spec.md "Textbook outline placement").
 *
 *   GET    what the placer is doing: running, facts still waiting, the newest run
 *   POST   { action: "revert", runId }   take a placer run back (each fact returns to
 *                                        what it had before; 409 while placing runs)
 *          { action: "run" }             place facts a revert withdrew (and anything
 *                                        waiting) now — returns at once, the pass runs on
 *          { action: "stop" }            stop the pass in progress; what landed stays
 *
 * Placing is automatic (src/server/placement.ts watches the graph); these
 * routes exist for the subtle status line and the undo link in the outline.
 */
import { graphRevision, placementService } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ ...placementService.status(), graphRevision: graphRevision() });
}

export async function POST(request: Request) {
	let body: { action?: unknown; runId?: unknown };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (body.action === "revert") {
		if (typeof body.runId !== "string" || body.runId === "") return Response.json({ error: "runId is required." }, { status: 400 });
		const result = placementService.revert(body.runId);
		if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
		return Response.json({ ok: true, reverted: result.reverted, status: placementService.status(), graphRevision: graphRevision() });
	}
	if (body.action === "run") {
		void placementService.runPass({ retryCleared: true }).catch((err) => console.warn("[placement] manual pass failed:", err));
		return Response.json({ ok: true, status: placementService.status() }, { status: 202 });
	}
	if (body.action === "stop") {
		placementService.stop();
		return Response.json({ ok: true, status: placementService.status() });
	}
	return Response.json({ error: 'action must be "revert", "run" or "stop".' }, { status: 400 });
}
