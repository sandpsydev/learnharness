/**
 * GET /api/figures/<chatId>/<file> — a picture the figure finder cached for this
 * session (a fetched figure or a rendered lecture slide). Read-only. The file name
 * must be a cache key (24 hex + png/jpg/gif/webp) and the folder a chat id, so no
 * other path can be named; anything else is a 404.
 */
import { readSessionFigure } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ chatId: string; file: string }> }) {
	const { chatId, file } = await ctx.params;
	const cached = readSessionFigure(chatId, file);
	if (!cached) return new Response("Not found", { status: 404 });
	return new Response(Buffer.from(cached.bytes), {
		headers: {
			"Content-Type": cached.mime,
			// The name is a hash of the picture's source, so the bytes never change.
			"Cache-Control": "private, max-age=31536000, immutable",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'; sandbox",
		},
	});
}
