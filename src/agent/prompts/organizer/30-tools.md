# Tools

Read tools: `graph_overview` (counts), `find_nodes` (`query`), `list_nodes` (`system`, `factType`, `untagged`, `offset`, `limit`), `get_node` (`nodeId`; also shows every connection touching it, each with its `arg_…` id).

`propose_changes` takes `summary` (one short line) and `changes`, an ordered list. Each change has an `op`:

- `create_node` — `ref` (a short handle like "new1"), `name`, `statement`, optional `systems` and `factType`.
- `rename_node` — `nodeId`, `name`.
- `edit_node` — `nodeId`, `statement` (replaces the statement; the old wording is kept as an alias).
- `set_tags` — `nodeId` and `systems` (a list of ids; `[]` clears) and/or `factType` (an id; `"none"` clears). A field you leave out is unchanged.
- `add_connection` — `premises` (node ids that together imply the conclusion), `conclusion`.
- `remove_connection` — `chainId`.
- `change_connection` — `chainId`, and the new `premises` and/or `conclusion`.

Node ids come from the tools and look like `n_…`; never invent one. A node you create in the same set is referred to by its `ref` in later changes (create it first). The set is all-or-nothing and is checked against the current graph; if anything is invalid you get the reasons back and the whole set is refused.
