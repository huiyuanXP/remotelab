# UI Icons

> Status: directional note. The current shipped baseline uses a hand-selected VS Code Codicons subset for the chat and share UI, with future work left open for a more automated loading pipeline.

## Current baseline

RemoteLab now uses a small VS Code Codicons-derived subset for the high-friction control surfaces:

- header and sidebar chrome
- session actions such as pin, rename, archive, and restore
- composer controls such as attach image, send, and stop
- thinking / disclosure affordances in chat and shared snapshots

The current implementation deliberately stays simple:

- no full Codicons font or full icon package is loaded at runtime
- only the icons currently used in the UI are shipped in `static/chat/icons.js`
- the icon names stay aligned with Codicon names so future expansion can remain predictable

## Deferred TODO

- if the icon surface grows, replace the current manual subset with a generated subset or sprite pipeline sourced from `@vscode/codicons`
- keep watching payload cost so we do not silently drift into shipping the full icon set just because it is convenient
- centralize the icon registry further if future UI surfaces outside chat/share start reusing the same icon language
