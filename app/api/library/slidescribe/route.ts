/**
 * POST /api/library/slidescribe — import a SlideScribe lecture note and its
 * PDF. Multipart form data: `note` (the .md) and optionally `pdf`. The note's
 * `source_pdf` names its PDF but a browser upload can't see the learner's
 * folders, so without `pdf` the response is 422 with `needsPdf.expectedName`
 * and the UI asks for that file. With both, the pair is validated, copied
 * into the data dir, and indexed per `## Slide N:` section (no vision pass).
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
	const note = form.get("note");
	const pdf = form.get("pdf");
	if (!(note instanceof File)) return Response.json({ error: "Pick the SlideScribe .md note." }, { status: 400 });
	const result = await library.importSlideScribe({
		noteName: note.name,
		noteText: await note.text(),
		...(pdf instanceof File ? { pdf: { fileName: pdf.name, bytes: new Uint8Array(await pdf.arrayBuffer()) } } : {}),
	});
	if (!result.ok) {
		return Response.json({ error: result.error, ...(result.needsPdf ? { needsPdf: result.needsPdf } : {}) }, { status: result.status });
	}
	return Response.json({ book: result.book });
}
