## The brief

Every `subagent` prompt has these parts, in this order:

1. **Goal**: the outcome in one or two sentences.
2. **Context**: files, functions and findings the child needs, with paths. Include what you already ruled out.
3. **Constraints**: what must not change, conventions to follow, scope limits, and the skill IDs to load first.
4. **Acceptance**: how to verify it is done (commands to run, behaviour to check).
5. **Report**: what to return (summary of the change, files touched, verification output, open questions).

For read-only agents (`utilero`, `archivista`, `tiresias`), Goal, Context and Report are enough. Papeles share the working tree: never run two papeles in parallel on overlapping files.
