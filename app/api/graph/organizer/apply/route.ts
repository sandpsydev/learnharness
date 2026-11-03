/**
 * POST /api/graph/organizer/apply — body { proposalId }: the learner accepted
 * a proposal. Only the proposal the server stored is applied (the page sends
 * an id, never the changes), re-checked against the graph as it is now; any
 * problem rejects the whole set (422 with the reasons) and nothing is written.
 * 409 while an extraction run is in flight. The response carries the new
 * graphRevision (the refetch signal) and the updated history.
 */
import { graphOrganizer } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { proposalId?: unknown } | null;
	if (typeof body?.proposalId !== "string" || body.proposalId === "") {
		return Response.json({ error: "proposalId is required" }, { status: 400 });
	}
	const outcome = graphOrganizer.apply(body.proposalId);
	if (!outcome.ok) {
		return Response.json({ error: outcome.error, code: outcome.code, problems: outcome.problems }, { status: outcome.status });
	}
	return Response.json({ entryId: outcome.entryId, summary: outcome.summary, graphRevision: outcome.graphRevision, history: outcome.history });
}
