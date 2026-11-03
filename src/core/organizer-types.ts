/**
 * Knowledge-organizer types (medical fork, docs/medical-spec.md "Knowledge
 * organizer"): the change vocabulary the organizer agent proposes, the
 * preview the learner reviews, and the undo journal. Pure types plus two
 * tiny constants — browser-safe, so the graph page can import them.
 *
 * The agent never writes the graph. It PROPOSES a set of changes; the
 * learner sees what changes (before and after) and only an accepted set is
 * applied (core/graph-organizer.ts), as one all-or-nothing step that can be
 * undone.
 */

/** The seven things the organizer can do. Deleting or merging nodes is
 *  deliberately absent (not asked for — a possible follow-up). */
export const ORGANIZER_OPS = [
	"create_node",
	"rename_node",
	"edit_node",
	"set_tags",
	"add_connection",
	"remove_connection",
	"change_connection",
] as const;
export type OrganizerOp = (typeof ORGANIZER_OPS)[number];

/** Most changes one proposal may carry — keeps a set reviewable. */
export const ORGANIZER_MAX_CHANGES = 40;
/** Name = a short handle, like a glossary headword. */
export const ORGANIZER_NAME_MAX = 80;
/** Statement = one self-contained proposition. */
export const ORGANIZER_STATEMENT_MAX = 600;

/** One change, as the agent submits it. A flat shape (weak models handle it
 *  better than a union); `parseOrganizerChanges` checks the fields each op
 *  needs and reports what is missing in plain words. Node references
 *  (`nodeId`, `premises`, `conclusion`) are existing node ids ("n_…") or the
 *  `ref` of a `create_node` in the SAME set. */
export interface RawOrganizerChange {
	op: string;
	/** create_node: a short handle other changes in this set can point at. */
	ref?: string;
	/** create_node / rename_node: the node's short name. */
	name?: string;
	/** create_node / edit_node: the node's statement. */
	statement?: string;
	/** create_node / set_tags: organ-system ids (set_tags: [] clears them). */
	systems?: string[];
	/** create_node / set_tags: a fact-type id (set_tags: "none" clears it). */
	factType?: string;
	/** rename_node / edit_node / set_tags: the node to change. */
	nodeId?: string;
	/** remove_connection / change_connection: the connection ("arg_…") id. */
	chainId?: string;
	/** add_connection / change_connection: node ids that TOGETHER imply the conclusion. */
	premises?: string[];
	/** add_connection / change_connection: the node the premises imply. */
	conclusion?: string;
}

/** One before/after row on a change card. `before`/`after` are display text;
 *  an absent side means "nothing there" (a creation or a removal). */
export interface OrganizerPreviewRow {
	field: string;
	before?: string;
	after?: string;
}

/** What the learner sees for one change. */
export interface OrganizerChangePreview {
	op: OrganizerOp;
	/** One line: "Rename “Old” → “New”". */
	title: string;
	rows: OrganizerPreviewRow[];
}

/** A proposed set, as shown to the learner. `changes` is the validated raw
 *  form the server re-checks (and applies) on accept. */
export interface OrganizerProposal {
	id: string;
	/** The agent's one-line description of the whole set. */
	summary: string;
	createdAt: string;
	changes: RawOrganizerChange[];
	previews: OrganizerChangePreview[];
}

/** A line-level diff of one ledger: lines that were removed (with their
 *  original position) and lines that were added. Lines are the exact JSON
 *  text written to the ledger. */
export interface OrganizerLineDiff {
	removed: Array<{ index: number; line: string }>;
	added: string[];
}

/** One applied set — the undo journal entry. */
export interface OrganizerHistoryEntry {
	id: string;
	appliedAt: string;
	summary: string;
	/** What the learner accepted, for the history list. */
	previews: OrganizerChangePreview[];
	nodes: OrganizerLineDiff;
	chains: OrganizerLineDiff;
	/** Node ids this set created (undo refuses if anything else touched them since). */
	createdNodeIds: string[];
	undoneAt?: string;
}

/** The history list the page shows: no line diffs. */
export interface OrganizerHistoryItem {
	id: string;
	appliedAt: string;
	summary: string;
	changeCount: number;
	undone: boolean;
	/** True only for the newest applied, not-yet-undone set. */
	canUndo: boolean;
}

/** One turn of the conversation the page sends. */
export interface OrganizerMessage {
	role: "user" | "assistant";
	text: string;
}
