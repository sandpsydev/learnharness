"use client";

import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { figureCardsKey, FIGURE_REF_TAG, remarkFigureRefs } from "@/src/core";
import type { FigureCardRef } from "@/src/core";

/**
 * FIGURE LINKS (medical fork). The teacher's text names a figure shown earlier in the chat
 * ("*Schwartz* 2019, p.597, Fig. 17-21, panel C"): that mention becomes a blue link, and the
 * link pops the picture up over the chat — no scrolling back. The rules for what counts as a
 * mention live in src/core/figure-refs.ts; this file is the seam to the page:
 *
 *   • FigureRefsContext — the chat provides the cards it shows and the "open the pop-up" call.
 *   • useFigureRefPlugins — the text renderer adds the markdown plugin when the chat has cards.
 *   • FigureRefLink — what a matched mention renders as (a button that looks like a link).
 *   (The pop-up itself is components/figure-peek.tsx.)
 */

export interface FigureRefsValue {
	/** The cards shown in this chat (stable between renders until the set of pictures changes). */
	cards: ReadonlyArray<FigureCardRef>;
	/** Pop the pictures up; `trigger` is the link to give focus back to on close. */
	open: (ids: string[], trigger: HTMLElement | null) => void;
}

export const FigureRefsContext = createContext<FigureRefsValue | null>(null);

/** The custom tag the plugin emits, let through sanitization with its one attribute (hast property name; it reaches React as data-ids). */
export const FIGURE_ALLOWED_TAGS = { [FIGURE_REF_TAG]: ["dataIds"] };

type PluginBag = { cjk?: { remarkPluginsAfter?: unknown[] } } & Record<string, unknown>;

/** The text renderer's plugin set, plus the figure-link plugin when this chat shows figure cards. */
export function useFigureRefPlugins<T extends object>(base: T): T {
	const cards = useContext(FigureRefsContext)?.cards;
	return useMemo(() => {
		if (!cards || cards.length === 0) return base;
		const bag = base as PluginBag;
		return {
			...bag,
			cjk: { ...bag.cjk, remarkPluginsAfter: [...(bag.cjk?.remarkPluginsAfter ?? []), [remarkFigureRefs, { cards, toJSON: () => figureCardsKey(cards) }]] },
		} as unknown as T;
	}, [base, cards]);
}

/** A matched mention. Reads like a link (blue, underlined on hover), acts like a button. */
export function FigureRefLink({ children, ...rest }: { children?: ReactNode; "data-ids"?: string }) {
	const refs = useContext(FigureRefsContext);
	const ids = (rest["data-ids"] ?? "").split(",").filter(Boolean);
	if (!refs || ids.length === 0) return <>{children}</>;
	const open = (el: HTMLElement) => refs.open(ids, el);
	return (
		<span
			role="button"
			tabIndex={0}
			aria-haspopup="dialog"
			data-testid="figure-ref"
			data-ids={ids.join(",")}
			title={ids.length > 1 ? "Show these pictures here" : "Show this picture here"}
			className="lh-figure-ref"
			onClick={(e) => open(e.currentTarget)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					open(e.currentTarget);
				}
			}}
		>
			{children}
		</span>
	);
}
