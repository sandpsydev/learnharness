The empty-thinking-lesson and summarized-thinking-lesson stream fixtures come
from Claude Code 2.1.332 using a neutral jug puzzle and a local acknowledgement
tool in an empty scratch directory. Only stream_event records from the first
message are retained. Session/account metadata, signatures and message IDs
were removed; the tool name/id were replaced for the fake CLI's read tool.

The ordinary text deltas precede the tool intent. With the normal display the
thinking deltas have empty text; explicitly selecting summarized thinking emits
summary prose as thinking_delta, independently of the subsequent text_delta.
No learner data, medical content or real web requests were used.
