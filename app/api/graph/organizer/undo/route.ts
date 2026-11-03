/**
 * POST /api/graph/organizer/undo — body { entryId }: put the newest applied
 * change set back exactly as it was. 404 for an unknown entry; 409 when it is
 * not the newest, was already undone, the graph changed under it, or an
 * extraction is running — nothing is changed in any of those cases.
 */
import { graphOrganizer } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { entryId?: unknown } | null;
	if (typeof body?.entryId !== "string" || body.entryId === "") {
		return Response.json({ error: "entryId is required" }, { status: 400 });
	}
	const outcome = graphOrganizer.undo(body.entryId);
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json({ entryId: outcome.entryId, graphRevision: outcome.graphRevision, history: outcome.history });
}
