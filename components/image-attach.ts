/**
 * Pasted / dropped screenshots (medical fork, Phase 7 — Explain my miss).
 *
 * A screenshot pasted with Cmd+V is not a file on disk, so it is sent to
 * POST /api/attachments, which saves it into the app's data dir and hands
 * back a path. The path is then attached exactly like a dropped file (a
 * quoted path chip), so the model sees the picture when it reads that path.
 */

export const ATTACH_FAILED = "Couldn’t attach that image. Try again, or drag the image file in instead.";

/** The image files in a clipboard / drag payload, in order. */
export function imageFilesOf(files: ArrayLike<File> | null | undefined): File[] {
	return Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));
}

/**
 * Save images into the data dir. Resolves to the saved paths (in order) and,
 * if any failed, the server's reason for the first failure — a partial
 * success still attaches what it could.
 */
export async function saveImageFiles(
	files: readonly File[],
	fetchLike: typeof fetch = fetch,
): Promise<{ paths: string[]; error?: string }> {
	const paths: string[] = [];
	let error: string | undefined;
	for (const file of files) {
		try {
			const res = await fetchLike("/api/attachments", {
				method: "POST",
				headers: { "Content-Type": file.type || "application/octet-stream" },
				body: file,
			});
			const body = (await res.json().catch(() => ({}))) as { path?: unknown; error?: unknown };
			if (res.ok && typeof body.path === "string") paths.push(body.path);
			else error ??= typeof body.error === "string" ? body.error : ATTACH_FAILED;
		} catch {
			error ??= ATTACH_FAILED;
		}
	}
	return error ? { paths, error } : { paths };
}
