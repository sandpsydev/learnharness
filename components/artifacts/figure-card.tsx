"use client";

import { useContext } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { ChatActionsContext } from "@/components/chat";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { figureImagePath, isSubagentFailure } from "@/src/core";
import type { ArtifactPartProps, FigureLink, FigureResult } from "@/src/core";

/**
 * The real-figure card (medical fork). The tool part is only the dispatch ack, so
 * the tool-call box is the DispatchCard; the figure itself renders from the steer
 * message via FigureOutputCard.
 *
 * Three outcomes: a picture (image, caption, the key feature to find, credit and
 * licence, link to the source), links when no picture can be shown, and a quiet
 * line when nothing was found. The picture is a plain <img> of the session cache,
 * so it scales to the column on a phone and never overflows.
 */

export function FigureCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="figure" />;
}

const isHttps = (url: string | undefined): url is string => typeof url === "string" && url.startsWith("https://");

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
	return (
		<a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
			{children}
			<ExternalLinkIcon className="ml-1 inline size-3 align-[-1px]" aria-hidden="true" />
		</a>
	);
}

function LinkList({ links }: { links: FigureLink[] }) {
	return (
		<ul className="flex flex-col gap-2" data-testid="figure-links">
			{links
				.filter((l) => isHttps(l.url))
				.map((l) => (
					<li key={l.url} className="min-w-0 text-sm">
						<div className="min-w-0 break-words">
							<ExternalLink href={l.url}>{l.title}</ExternalLink>
						</div>
						<div className="text-xs text-muted-foreground">{l.source}</div>
						<div className="text-muted-foreground">{l.note}</div>
					</li>
				))}
		</ul>
	);
}

/** The delivered figure — exported: the steer card renders it. */
export function FigureOutputCard({ output }: { output: unknown }) {
	const result = output as FigureResult | undefined;
	const actions = useContext(ChatActionsContext);
	if (!result || typeof result.brief !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Figure search finished, but the result could not be displayed.
			</div>
		);
	}
	if (isSubagentFailure("figure", result)) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="figure-card-failed">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Figure
					<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>
				</div>
				<p className="mt-2 text-sm text-muted-foreground">{result.brief.replace(/^Figure failed:\s*/i, "")}</p>
			</div>
		);
	}
	const image = result.image;
	if (result.outcome === "image" && image && actions?.chatId) {
		const src = figureImagePath(actions.chatId, image.file);
		return (
			<figure className="my-4 w-full max-w-full" data-testid="figure-card">
				{/* A real picture, scaled to the column (never wider), tall ones capped so a phone screen still shows the caption. */}
				<a href={src} target="_blank" rel="noopener noreferrer" aria-label="Open the picture full size">
					{/* A plain <img>: the file is already cached on this machine, so next/image's optimizer has nothing to add. */}
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img
						src={src}
						alt={result.caption}
						loading="lazy"
						draggable={false}
						className="mx-auto block h-auto max-h-[75vh] w-auto max-w-full rounded-lg border bg-white object-contain"
						data-testid="figure-image"
					/>
				</a>
				<figcaption className="mt-2 flex flex-col gap-1 text-sm">
					<span data-testid="figure-caption">{result.caption}</span>
					{result.keyFeature && (
						<span className="text-muted-foreground" data-testid="figure-key-feature">
							<span className="font-medium text-foreground">Look for: </span>
							{result.keyFeature}
						</span>
					)}
					<span className="break-words text-xs text-muted-foreground" data-testid="figure-credit">
						{image.credit} · {image.licenceUrl && isHttps(image.licenceUrl) ? <ExternalLink href={image.licenceUrl}>{image.licence}</ExternalLink> : image.licence}
						{isHttps(image.sourceUrl) && (
							<>
								{" · "}
								<ExternalLink href={image.sourceUrl}>{image.title}</ExternalLink>
							</>
						)}
						{!isHttps(image.sourceUrl) && <> · {image.title}</>}
					</span>
				</figcaption>
			</figure>
		);
	}
	if (result.outcome === "link" && result.links.length > 0) {
		return (
			<div className="my-4 rounded-xl border bg-card p-4 text-card-foreground" data-testid="figure-card-links">
				<div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Figure · link only</div>
				<LinkList links={result.links} />
			</div>
		);
	}
	return (
		<div className="text-xs text-muted-foreground" data-testid="figure-card-none">
			No figure found for “{result.concept}”.
		</div>
	);
}
