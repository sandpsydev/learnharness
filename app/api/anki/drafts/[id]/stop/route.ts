/** POST /api/anki/drafts/[id]/stop — stop a draft that is still being drafted (it ends as an error "Stopped."). */
import { anki } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	if (!anki.stop(id)) return Response.json({ error: "Nothing is running for this draft.", code: "not_running" }, { status: 409 });
	return Response.json({ ok: true });
}
