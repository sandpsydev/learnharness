/**
 * POST /api/anki/drafts/[id]/push   body {deck?: string}
 *
 * Sends the draft's unsent cards to the running Anki desktop through
 * AnkiConnect. `deck` sends every card to that one deck instead of its
 * system's deck. 503 {code:"anki_unavailable"} when Anki / AnkiConnect is not
 * running; 502 {code:"anki_error"} when it answers with a problem. On success
 * returns {draft, summary:{added,duplicate,failed}}; cards whose front is
 * already in the target deck come back "duplicate" and are not added.
 */
import { anki } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	const body: unknown = await request.json().catch(() => ({}));
	try {
		const out = await anki.push(id, body);
		if (!out.ok) return Response.json({ error: out.error, code: out.code }, { status: out.status });
		return Response.json({ draft: out.draft, summary: out.summary });
	} catch (err) {
		console.error("[anki] push failed:", err);
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
}
