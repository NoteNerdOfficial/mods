# cross-session

See and control the messages that pass between your Claude sessions and agents (the `SendMessage` tool), from one place.

## Why use it

- **Running several sessions at once.** Messages between sessions otherwise appear only as scattered transcript rows. The pane keeps them in one place, in order, so you can see who told whom what.
- **Checking what a subagent or teammate was told.** Open a row to read the exact text an agent sent or received, instead of guessing from its summary.
- **Keeping secrets out of other sessions.** An agent that pastes a key or token into a message gets it masked before it leaves, and the log shows that a redaction happened.
- **Silencing a noisy peer.** A session that keeps sending status updates can be muted without stopping it. Its messages stay in the log, so you can still read them.
- **Testing a multi-session setup.** `/cross-session-send` sends a message by hand, so you can check that another session receives and answers it before you rely on it.
- **Catching replies you'd miss.** A toast shows when a peer's message arrives, so a reply doesn't sit unnoticed while you work.

## Use

- `/cross-session` opens the **Cross-session messages** pane: a log of every message sent to or received from another session or agent, newest first. Select a row to read the full text.
- `/cross-session clear` empties the log. The pane has a **Clear** button too.
- `/cross-session-send <to> <text>` sends a message yourself. `<to>` is a name from `ListAgents`.
- **Mute:** select an incoming message and press **Mute <peer>**. Later messages from that peer are dropped before they are queued, so the model never reads them. They stay in the log, marked `[muted]`. Press **Unmute <peer>** to undo. Nothing is muted by default.
- **Redaction:** outgoing text is scanned for common secrets (`sk-…`, GitHub and Slack tokens, AWS access keys, and `token=`, `password:`, `api_key=` style values). Matches are replaced with `[redacted]` before the message leaves, and the log row says how many.
- **Toasts:** a toast shows when a peer's message arrives. The **Toasts** button turns that off.
- The status line shows `cross-session: 4 in · 2 out · 1 muted`.

## Limits

- History is for the current session only, and is not written to disk.
- A peer is identified by what the message carries: a teammate's name, else the plugin that composed it, else just `peer`. Two unnamed peers share one label, so muting one mutes both.
- Redaction is pattern-based and will miss secrets with no recognizable shape.
- The receiving session's own permission mode still applies: it may hold or refuse a message this mod delivered.
- Tested with `claude plugin test` and type-checked. Not yet tried in a live two-session setup.
