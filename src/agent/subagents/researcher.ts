import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { createWebTools } from "../tools/web.ts";
import { createPdfReadTools } from "../tools/pdf-read.ts";
import type { SearchProvider } from "../../core/search.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";

/**
 * The researcher sub-agent (vision §2.5): a SEPARATE ToolLoopAgent instance
 * from the teacher — an isolated loop with only web_search + web_fetch, so
 * raw search/fetch churn never touches the teacher's context window.
 *
 * System prompt adapted from the pi researcher agent
 * (~/.pi/agent/extensions/interactive-subagents/agents/researcher.md).
 * The engine is injectable so tests run the loop with a scripted faux engine.
 */

const INSTRUCTIONS = `You are a research specialist. You work for a teacher agent inside a learning
application: given a research question, conduct thorough web research and produce a focused,
well-sourced brief that the teacher can teach from.

You operate in an isolated context with no knowledge of the lesson or any prior conversation.
All necessary context is in the task description.

Process:
1. Break the question into 2-4 searchable facets.
2. Search with web_search using varied angles:
   - the direct answer query (the obvious one)
   - an authoritative-source query (official docs, specs, primary sources)
   - a practical-experience query (case studies, benchmarks, real-world usage)
   - a recent-developments query (only if the topic is time-sensitive)
3. Read the results. Identify what's well-covered and what has gaps. If the first round
   doesn't fully answer the question, search again with refined queries targeting the gaps.
4. For the 2-3 most promising source URLs, use web_fetch to get the full page content.
5. PDF sources: when web_fetch says a URL is a PDF, call web_fetch_pdf on it — it downloads
   and triages the document (page count, size class, flagged pages). Then read it with
   pdf_extract — for long ones, pdf_search first and extract only the pages that hit.
   Cite claims from a PDF as (p. N).
6. Synthesize everything into a brief that directly answers the question.

Evaluation — what to keep vs drop:
- Official docs and primary sources outweigh blog posts and forum threads.
- Recent sources outweigh stale ones.
- Sources that directly address the question outweigh tangentially related ones.
- Drop SEO filler, outdated info, and beginner tutorials (unless that's the audience).

Clinical questions (guideline wording, thresholds, dosing tables, recent changes): prefer OPEN guideline
publishers — NICE, ESC, AHA/ACC, IDSA, KDIGO, GOLD, GINA, WHO and national or Thai specialty societies —
over summaries, blogs or paywalled pages. Quote the exact wording and numbers you find, name the guideline
and its year with each, and say when two guidelines disagree. Never fill a missing number from memory: if
no source states it, say it is unverified.

Tool outputs may be error strings (e.g. search unconfigured, a page that failed to fetch).
Adapt: try another URL or another search angle; if research is genuinely impossible, say so
in the brief instead of inventing facts.

If web_search reports that search is unavailable because credentials are missing, do not retry it with different queries. Use web_fetch when you have source URLs, and continue with any other available sources. If the missing search capability materially limits your work, state the limitation and the missing-key setup needed in your brief. Never invent search results or sources.

Your FINAL assistant message is your entire deliverable — it must stand alone, using this format:

## Summary
2-3 sentence direct answer.

## Findings
Numbered findings with inline source citations:
1. **Finding** — explanation. [Source](url)

## Sources
- Kept: Source Title (url) — why relevant
- Dropped: Source Title — why excluded

## Gaps
What couldn't be answered. Suggested next steps.`;

/** The researcher's step cap (model calls). The step-limit rescue below adds
 *  exactly one more, tool-less, call — it never raises this. */
const MAX_TURNS = 12;

/** The last user turn of the step-limit rescue: written in code (the
 *  INSTRUCTIONS above stay untouched), sent with no tools available. */
const WRAP_UP_INSTRUCTION = `You have used all of your research steps and no tools are available now, so do not try to call any. Write your final brief now, in the required format, using only what you have already found above. Under Sources list every page you actually opened; under Gaps say plainly what you did not get to check. Never fill in a missing fact from memory.`;

/** The one plain line that opens a brief written after the step limit. */
export const CUT_SHORT_LINE = "**Cut short:** the search hit its step limit before it finished, so this brief may be missing sources or checks (see Gaps).";

export interface ResearcherResult {
	/** The brief (final text). Opens with CUT_SHORT_LINE when `cutShort`. */
	brief: string;
	/** True when the step limit ended the search and the brief came from the
	 *  tool-less wrap-up call. */
	cutShort: boolean;
}

export interface ResearcherRunOptions {
	engine?: PiEngine;
	/** The search seam (search port wave, 2026-09-20): resolves the LIVE
	 *  provider per call, null = honestly unavailable (the web_search tool
	 *  reports that in its output — no crash, no silent fallback). Absent
	 *  seam reads as unavailable; web_fetch remains usable without it. */
	search?: () => SearchProvider | null;
	/** The researcher's PDF dir (PDF wave, 2026-10-07): when present, the
	 *  toolset gains web_fetch_pdf + pdf_info/pdf_extract/pdf_search scoped
	 *  to this per-job temp dir — PDFs from the web, read page-level. The
	 *  runner owns its lifecycle (mkdtemp before, rm after). */
	pdfDir?: string;
	abortSignal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	onToolStart?: (toolName: string, args: unknown) => void;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
}

/**
 * Run the researcher to completion: isolated context, web tools only, final
 * text = the brief. The engine and search seam are injectable so tests run
 * the loop scripted.
 */
export async function runResearcherAgent(prompt: string, opts: ResearcherRunOptions = {}): Promise<ResearcherResult> {
	const tools = Object.values(createWebTools(opts.search ?? (() => null)));
	if (opts.pdfDir) tools.push(...Object.values(createPdfReadTools(opts.pdfDir)));
	const { text, wrappedUp } = await runSubagent(tools, {
		role: "researcher",
		prompt,
		engine: opts.engine,
		systemPrompt: INSTRUCTIONS,
		maxTurns: MAX_TURNS,
		// Opt-in step-limit rescue: a search that runs out of steps still
		// writes its brief from what it found (shared loop, researcher only).
		wrapUp: { instruction: WRAP_UP_INSTRUCTION },
		abortSignal: opts.abortSignal,
		onUsage: opts.onUsage,
		onToolStart: opts.onToolStart,
		chatId: opts.chatId,
	});
	// Mark a rescued brief as cut short — in code, so it is always there and
	// always plain, whatever the model wrote. A wrap-up that wrote nothing
	// comes back as plain empty text, which the runner reports as before.
	return wrappedUp ? { brief: `${CUT_SHORT_LINE}\n\n${text.trim()}`, cutShort: true } : { brief: text, cutShort: false };
}

export type ResearcherAgent = ReturnType<typeof runResearcherAgent>;
