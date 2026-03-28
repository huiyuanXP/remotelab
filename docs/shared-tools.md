# Shared Tools

RemoteLab can now load lightweight shared tool definitions from a common directory instead of forcing every instance to duplicate the same `tools.json` entries.

## Goal

- share reusable tool wrappers across instances on the same machine
- keep per-instance enablement and local defaults isolated
- keep the tool definition human-readable with Markdown first

## Scope boundary

- Shared tools are the reusable execution surface, not the shared knowledge layer.
- Keep per-user secrets, credentials, scopes, and account bindings local to that instance or overlay.
- Keep domain knowledge and user-private memory in their own retrieval layers instead of encoding them into shared tool cards.

## Paths

- shared tool library: `~/.remotelab/shared-tools/`
- per-instance enable list: `~/.config/remotelab/tools-enabled.md`
- per-instance overlays: `~/.config/remotelab/tool-overlays/`

Guest or alternate instances already use their own config roots, so `tools-enabled.md` and `tool-overlays/` stay instance-local automatically.

## Tool Folder Shape

Each shared tool lives in its own folder and must include `TOOL.md`:

```text
~/.remotelab/shared-tools/
  review-helper/
    TOOL.md
    run-review
```

`TOOL.md` uses a tiny frontmatter subset plus normal Markdown body text:

```md
---
runtimeFamily: codex-json
command: ./run-review
visibility: private
promptMode: bare-user
flattenPrompt: true
---
# Review Helper

Thin wrapper around Codex with local review defaults.
```

## Supported Frontmatter

- `id`: optional; defaults to the folder name
- `name`: optional; defaults to the first Markdown `# Heading`
- `command`: required; relative paths resolve from the tool folder
- `runtimeFamily`: usually `codex-json` or `claude-stream-json`
- `visibility`: optional; `private` is supported
- `toolProfile`: optional; currently supports `micro-agent`
- `promptMode`: optional; `bare-user` is supported
- `flattenPrompt`: optional boolean

## Enable List

If `tools-enabled.md` does not exist, all shared tools are visible.

If it exists, only listed shared tool ids are loaded:

```md
# Enabled shared tools
- review-helper
- calendar-helper
```

## Overlays

Shared tools can read per-instance local defaults from:

```text
~/.config/remotelab/tool-overlays/<tool-id>.yaml
~/.config/remotelab/tool-overlays/<tool-id>.yml
~/.config/remotelab/tool-overlays/<tool-id>.json
~/.config/remotelab/tool-overlays/<tool-id>.md
```

When RemoteLab launches the tool process, it now injects:

- `REMOTELAB_TOOL_ID`
- `REMOTELAB_TOOL_NAME`
- `REMOTELAB_TOOL_SOURCE`
- `REMOTELAB_SHARED_TOOL_DIR`
- `REMOTELAB_SHARED_TOOL_CARD`
- `REMOTELAB_TOOL_OVERLAY`

That makes wrapper scripts simple. A shared wrapper can stay reusable while reading local defaults from the overlay path when present.

## Recommended Pattern

- keep the shared folder focused on reusable wrappers and notes
- keep secrets, local paths, and default values in the overlay file
- prefer wrapper scripts when a tool needs local behavior beyond a plain `codex` or `claude` command
