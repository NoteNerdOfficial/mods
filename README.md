# mods

Claude Code mods: plugins that change Claude's interface or behaviour through hooks.

| Mod | What it does |
|---|---|
| [assumptions](assumptions/) | Gives Claude a `log_assumption` tool and asks it to log the non-obvious assumptions it makes while building. You confirm or correct them from a side pane (`/assumptions`). See its [README](assumptions/README.md). |
| [prompt-sharpener](prompt-sharpener/) | Rewrites your draft into a sharper, project-aware prompt in the input box. Nothing is sent until you press Send. See its [README](prompt-sharpener/README.md). |

## Setup

This repo is the source of truth. `~/mods` is a symlink to it, and `~/.claude/settings.json` loads each mod from there:

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "~/mods/prompt-sharpener:~/mods/assumptions"
}
```

On a new machine:

```sh
git clone git@github.com:NoteNerdOfficial/mods.git ~/Documents/Repos/mods
ln -s ~/Documents/Repos/mods ~/mods
```

Then add the `CLAUDE_CODE_PLUGIN_DIRS` line above. To try a single mod without installing it, run `claude --plugin-dir <mod folder>`.

## Layout

Each mod is a folder with:

- `.claude-plugin/plugin.json`: the name, version and description.
- `hooks/register.tsx`: the hook handlers.
- `types/index.d.ts`: the mod's own types.

The `.claude-plugin/types/` folder holds Claude Code's generated type definitions. It is gitignored.

## Tests

```sh
claude plugin test assumptions
claude plugin test prompt-sharpener
```
