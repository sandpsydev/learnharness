/**
 * POST /api/captures/[id]/start — start a teaching session on a capture.
 * Creates the session (titled with the capture's text, stamped from the
 * strong model slot like any new session), marks the capture done and links
 * the two. The client then hands the capture text over as the opening prompt
 * (components/start-session.ts) and opens /chat/<id>.
 */
import { createStampedChat, stores, titleFromPrompt } from "@/src/server";

export const dynamic = "force-dynamic";

const CAPTURE_ID = /^cp_[a-z0-9]+_[a-f0-9]{8}$/;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const capture = CAPTURE_ID.test(id) ? stores.captureStore.get(id) : null;
	if (!capture) return Response.json({ error: "Not found" }, { status: 404 });
	const chat = createStampedChat(titleFromPrompt(capture.text));
	const linked = stores.captureStore.update(id, { status: "done", chatId: chat.id });
	return Response.json({ id: chat.id, title: chat.title, text: capture.text, capture: linked });
}
