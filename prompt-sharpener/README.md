# prompt-sharpener

A Claude Code mod that rewrites a rough draft in the prompt box into a sharper prompt that knows about your project. The rewrite goes back into the box so you can review and edit it. It is sent only when you press **Send**.

## Use

Start typing and a line appears above the prompt: `✨ Enhance · Send   ctrl+x e to enhance`. When the box is empty the line is hidden.

- **Enhance**: press `ctrl+x e` or click it. While it runs, the line reads `✨ Enhancing…`. The rewrite replaces your draft, tinted until your next edit. This never sends anything.
- After an enhancement the line reads `✓ Enhanced · Undo · Send`. **Undo** puts your original draft back.
- **Send** submits whatever is in the box right now, as your own message.

You can also press `ctrl+x tab` to focus the line and then use `e`, `u` or `s`. Pressing Enter in the box still sends as usual, and only when you do it.

The `ctrl+x e` shortcut comes from `~/.claude/keybindings.json`, which binds it to `diff:back`. Mods can't define shortcut actions of their own, so the button borrows that one. Claude Code only uses it inside the diff dialog, so it does nothing else while you're typing. To change the key, edit that binding.

## Project context

Enhance reads these files from the session's working directory:

- `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`, in full, up to 12k characters each. These hold the project's stack, conventions and terminology.
- `.claude/skills/*/SKILL.md`, but only each skill's `name` and `description`. That is enough to name the right skill without pulling in its whole procedure.

## When something goes wrong

If the model call fails, times out (45 s), or returns an empty reply, a toast tells you and your draft stays exactly as it was. If you edit the draft while Enhance is running, your edits are kept and the rewrite is thrown away. If a send fails, your text goes back into the box.

## Files

- `hooks/system-prompt.ts` holds the enhancer's instructions.
- `hooks/register.tsx` has the band, the context gathering, and the enhance, undo and send logic. The model is set by `MODEL` (`sonnet`).
- `hooks/register.test.ts` runs a test using "make the dashboard better" against a fake project and model. Run it with `claude plugin test <this folder>`.

## Install elsewhere

Run `claude --plugin-dir <this folder>`. You can also copy the folder into a plugin marketplace repo.
