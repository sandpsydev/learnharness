import { deleteGraphNode, editGraphNodeTags } from "@/src/server";

/**
 * DELETE /api/graph/nodes/[id] — single-node deletion, FULL DEATH (owner
 * ruling 2026-09-23: the user pointing at the node is intent — references
 * from other sessions do not preserve it). The node's every line, every
 * edge touching it, every quiz/observation event naming it, its mapping
 * lines, and its position die in one atomic ledger rewrite
 * (core/graph-deletion.ts deleteNodeTraces); derived data (birth
 * partition, clusters) self-heals on read.
 *
 * Guards (server/graph.ts deleteGraphNode): 409 while ANY extraction run
 * is registered — a mid-flight run holds pre-deletion findings and could
 * re-reference the dying node; the run is never aborted (its spend belongs
 * to another session), the UI retries once the dock drains. No turn/jobs
 * gates: they never write the graph ledgers, and this orchestration is
 * synchronous end to end — nothing interleaves. The response carries what
 * was removed plus the new graphRevision (the refetch signal).
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const outcome = deleteGraphNode(id);
	if (!outcome.ok) {
		return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	}
	return Response.json({ stats: outcome.stats, graphRevision: outcome.graphRevision });
}

/**
 * PATCH /api/graph/nodes/[id] — the learner's edit of a node's medical tags
 * (docs/medical-spec.md Phase 4): body `{ systems: string[], factType: string | null }`
 * REPLACES both tags. The edit is appended to the ledger, never rewritten in
 * (server/graph.ts editGraphNodeTags); the response carries the new tags
 * plus the new graphRevision (the refetch signal).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const outcome = editGraphNodeTags(id, body);
	if (!outcome.ok) {
		return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	}
	return Response.json({ tags: outcome.tags, graphRevision: outcome.graphRevision });
}
