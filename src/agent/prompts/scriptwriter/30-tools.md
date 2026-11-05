# Tools

Read tools: `find_nodes` (`query`: a glob such as *pancreat*), `get_node` (`nodeId`; also shows the connections that take part in it), `library_search` (`query`, optional `book`, `limit`), `library_read` (`book`, `pages`), `expert_search` (`query`), `expert_read` (`id`).

`submit_script` takes `title` (the illness, in its usual name), optional `aliases`, and `sections`: one entry for each of the nine ids. A section has:

- `claims` — each with `text`, and its sources: `graph` (a list of node ids from the tools), `library` (a list of `{book, page}` exactly as the library tools printed them), `expert` (a list of Expert AI answer ids). Optional flags: `bullet` (true for a list item), `changing` (true for the changing tier), `general` (true for settled science stated from general knowledge, with no source).
- `gaps` — what the learner's sources do not cover.
- `images` — `{book, page, caption}` for a page of the learner's library you read.
- `diagrams` — `{brief, caption}` for an app-drawn figure.

Node ids look like `n_…`; never invent one. The whole script is checked when you submit, and any problem refuses it with the reasons.
