# model-router

Recommends the right model and effort for each prompt, and can route every turn for you.

- When you pause typing (1.2s), Haiku 5.5 sizes up the draft and picks one of Haiku 5.5, Sonnet 5.5, Opus 5.5 or Fable 5.1, with an effort level from low to max. The rubric is balanced: it picks the cheapest setting that still does the job well, and Sonnet 5.5 · medium when unsure.
- In **recommend** mode (the default), the band above the prompt shows the pick:
  - **⇢ Use Opus 5.5 · high** sends your next prompt on that setting. Press it again (↶) to undo.
  - **Keep current** dismisses the pick for this draft. The band says "✓ Keeping Sonnet 5.5" and ↶ brings the pick back.
  - **Auto** switches to auto mode.
  - When the pick matches the model you're already on, the band just says it fits.
- In **auto** mode, every prompt runs on its pick. While you type, the band shows **⇢ Auto: Opus 5.5 · high** so you can see it before sending:
  - **Override** sends this prompt on your current model instead. ↶ undoes it.
  - **Exit auto** goes back to recommend mode. It stays in the band the whole time auto is on, even with an empty prompt box, where it also shows what the last prompt ran on.
  - The status line shows what each turn ran on.
- `/model-router` on its own toggles auto on or off. `/model-router recommend | auto | off` sets a mode directly. The mode is remembered across sessions.
- Leaving auto takes effect from your next prompt. A turn that's already running keeps its model, so its prompt cache isn't thrown away.
- Keep current and Override apply to the exact draft. If you edit it, the new draft gets a fresh pick, shown in the band again.
- If you press Enter before the band has shown the pick for that draft, auto mode holds the prompt for 3 seconds. The band shows **⏸ Sending on Opus 5.5 · high in 3s** with:
  - **Override**, which sends it on your current model.
  - **Send now**, which skips the wait.
  - **Exit auto**, which sends it on your current model and leaves auto.

  There's no hold when you saw the pick before sending, or when the pick matches what you're already on.

How it works:

- Claude Code gives mods no way to change the session's model, so the mod rewrites the model and effort of each request in the turn (`turn.step`). `/model` keeps showing your own setting.
- Subagents keep their own model.
- A follow-up turn with no new prompt keeps the last turn's routing. So does a slash-command turn.
- Each distinct draft costs one small Haiku call. Results are cached, so retyping the same text is free.

Why it recommends by default: switching models mid-conversation throws away the prompt cache, so a wrong automatic switch costs money as well as quality. Auto is there once you trust its picks.

Caveats:

- If your account can't use a picked model (Fable 5.1, for example), that turn's request fails. Use recommend mode, or edit `MODEL_IDS` and the rubric in `hooks/router.ts`.
- The band draws above any other mod's band. A mod that draws its own band without calling `next(e)` (prompt-sharpener does this while you have a draft) hides this one if it loads first.

## Testing

Automated tests, from the repo root:

```sh
claude plugin test model-router
```

To try it in a live session without installing it:

```sh
claude --plugin-dir ~/mods/model-router
```

Then:

- **Cheap pick:** type `rename getUser to fetchUser` and pause. You should see a cheap pick such as Haiku 5.5 · low.
- **Strong pick:** type something hard, such as `untangle the race between the cache writer and the reconnect logic`. You should see Opus 5.5 · high or similar.
- **Recommend buttons:** try **Use**, **Keep current** and **Auto**.
- **Auto mode:** send quickly, before the pick shows, to get the 3-second hold. Send after it shows to skip the hold. Then press **Exit auto**.

`/model` won't show the routed model. Watch the status line in auto mode, or the per-model breakdown in `/cost`.
