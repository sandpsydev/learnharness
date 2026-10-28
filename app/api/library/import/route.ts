/**
 * POST /api/library/import — add PDFs to the library. Multipart form data:
 * one or more `files` (PDFs) and, per file, a `mode` field in the same order
 * ("text" or "vision" — the learner's per-PDF choice). Each PDF is validated,
 * copied into the app's data dir, and indexed in the background; the response
 * returns right away with one result per file and the progress rides
 * GET /api/library.
 */
import { library } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return Response.json({ error: "The upload couldn't be read — the file may be too large." }, { status: 400 });
	}
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	const modes = form.getAll("mode");
	if (files.length === 0) return Response.json({ error: "no files" }, { status: 400 });

	const results = [];
	for (const [index, file] of files.entries()) {
		const mode = modes[index] === "vision" ? "vision" : "text";
		const result = await library.importPdf({ fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()), mode });
		results.push({ fileName: file.name, requestIndex: index, ...result });
	}
	return Response.json({ results });
}
