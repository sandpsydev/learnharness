"use client";

import { useEffect, useRef } from "react";
import { CornerDownLeftIcon, XIcon } from "lucide-react";
import { FigureCredit } from "@/components/artifacts/figure-card";
import { figureImagePath } from "@/src/core";
import type { FigureCardRef } from "@/src/core";

/**
 * The pop-up: the pictures a link names, large, each with its caption, credit line and source.
 * Mounts absolute inside the session area like the other focuses (the top bar stays usable);
 * it never touches the transcript's scroll, so closing leaves the learner exactly where they were.
 * Esc, the X, or a tap outside the panel closes; "Show in chat" closes and scrolls to that card.
 */
export function FigurePeek({
	chatId,
	cards,
	trigger,
	onClose,
	onShowInChat,
}: {
	chatId: string;
	cards: ReadonlyArray<FigureCardRef>;
	trigger: HTMLElement | null;
	onClose: () => void;
	onShowInChat: (cardId: string) => void;
}) {
	const closeRef = useRef<HTMLButtonElement>(null);

	// Esc closes — claimed at the document level, like every overlay (one Esc, one action).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Focus moves into the pop-up, and back to the link on close — without scrolling anything.
	useEffect(() => {
		closeRef.current?.focus({ preventScroll: true });
		return () => {
			if (trigger?.isConnected) trigger.focus({ preventScroll: true });
		};
	}, [trigger]);

	if (cards.length === 0) return null;
	return (
		<div
			data-testid="figure-peek"
			role="dialog"
			aria-modal="true"
			aria-label={cards.length > 1 ? "Figures from this page" : "Figure"}
			className="absolute inset-0 z-40 flex items-start justify-center overflow-y-auto overscroll-contain bg-background/80 p-3 backdrop-blur-sm sm:items-center sm:p-6"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="relative my-auto flex w-full max-w-3xl flex-col gap-4 rounded-xl border bg-card p-3 text-card-foreground shadow-lg sm:p-5">
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium">{cards.length > 1 ? `Figures · ${cards.length} from this page` : "Figure"}</span>
					<button
						ref={closeRef}
						type="button"
						onClick={onClose}
						aria-label="Close"
						data-testid="figure-peek-close"
						className="ml-auto flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<XIcon className="size-4" />
					</button>
				</div>
				{cards.map((card) => {
					const src = figureImagePath(chatId, card.image.file);
					return (
						<figure key={card.id} className="flex flex-col gap-2" data-testid="figure-peek-card" data-card-id={card.id}>
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img
								src={src}
								alt={card.result.caption}
								draggable={false}
								className="mx-auto block h-auto max-h-[70vh] w-auto max-w-full rounded-lg border bg-white object-contain"
								data-testid="figure-peek-image"
							/>
							<figcaption className="flex flex-col gap-1 text-sm">
								<span>{card.result.caption}</span>
								{card.result.keyFeature && (
									<span className="text-muted-foreground">
										<span className="font-medium text-foreground">Look for: </span>
										{card.result.keyFeature}
									</span>
								)}
								<FigureCredit image={card.image} />
							</figcaption>
							<div>
								<button
									type="button"
									onClick={() => onShowInChat(card.id)}
									data-testid="figure-peek-show"
									className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								>
									<CornerDownLeftIcon className="size-3.5" aria-hidden="true" />
									Show in chat
								</button>
							</div>
						</figure>
					);
				})}
			</div>
		</div>
	);
}
