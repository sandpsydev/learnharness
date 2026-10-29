/**
 * POST /api/attachments — save one pasted or dropped image into the app's
 * data dir and return its path, so the chat box can attach it like any
 * other file path (and the model can read it). The request body is the raw
 * image bytes; nothing else is stored and nothing is sent anywhere.
 */
import { MAX_ATTACHMENT_BYTES, saveImageAttachment } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	// Refuse an obviously oversized body before reading it into memory.
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > MAX_ATTACHMENT_BYTES) {
		return Response.json({ error: "That image is too large. Crop the screenshot and try again." }, { status: 413 });
	}
	const bytes = new Uint8Array(await request.arrayBuffer());
	const result = saveImageAttachment(bytes);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ path: result.path });
}
