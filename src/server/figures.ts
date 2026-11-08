/**
 * Real figures (medical fork): the server's read of the session picture cache
 * (agent/figures/cache.ts), for app/api/figures. Read-only.
 */
import { PATHS } from "../../config.ts";
import { readCachedFigure, type CachedFigure } from "../agent/figures/cache.ts";

/** A cached figure of this session, or null for anything that is not one. */
export function readSessionFigure(chatId: string, file: string, root: string = PATHS.figures): CachedFigure | null {
	return readCachedFigure(root, chatId, file);
}
