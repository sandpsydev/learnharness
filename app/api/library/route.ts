/**
 * GET /api/library — the PDF library for Settings → Library: every book
 * (with live indexing progress), whether ChatGPT vision can run, and the
 * local embedding model's facts. The UI polls this while anything indexes.
 */
import { library } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(library.listing(), { headers: { "Cache-Control": "no-store" } });
}
