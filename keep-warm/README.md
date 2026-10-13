# keep-warm

Keeps the prompt cache warm while you're away, so your next message reads the conversation from the cache instead of paying to write it again.

- When a turn ends, keep-warm schedules a refresh at 90% of the cache lifetime. A refresh copies the conversation and adds one short prompt with every tool denied, which reads the cache and resets its timer. Nothing is added to your conversation.
- It refreshes only while you're idle. While a turn runs, its own requests keep the cache warm.
- A refresh is sent only when it's expected to save at least $0.05. That assumes a 15% chance you'll return before the cache expires, the figure [cache-warmer](https://github.com/paulbkim-dev/claude-code-cache-warmer) borrowed from Pi. In practice, small conversations are never refreshed. For Opus 5.5 that means anything under about 100k tokens on the 5-minute cache.
- It stops after 3 idle refreshes. That keeps a 5-minute cache alive for about 18 minutes and a 1-hour cache for about 3¾ hours.
- It also stops:
  - on compaction, `/clear`, a model switch or the session's end, since those lose the cache anyway
  - when a refresh finds the cache already expired, which usually means the lifetime setting is wrong
  - when a refresh is due too late to read the cache, such as after the computer slept
  - for models it has no price for
- The status line shows the next refresh time and how many refreshes are used, or why it stopped.
- `/keep-warm` shows what it has spent, saved and wasted, this session and all time. `/keep-warm off` and `/keep-warm on` switch it for this session.

## Settings

In `/config`:

| Setting | Default | |
|---|---|---|
| Cache lifetime | `auto` | `auto` reads `FORCE_PROMPT_CACHING_5M` and `CLAUDE_CODE_PROMPT_CACHE_TTL`, else assumes `5m`. Set `1h` if your sessions use the 1-hour cache. |
| Idle refreshes | 3 | 0 to 10; 0 turns it off. |
| Minimum expected saving (USD) | 0.05 | |

## How it differs from cache-warmer

- **It never changes your cache lifetime.** cache-warmer switches every request to the 1-hour cache by default. keep-warm only needs to know the lifetime you use.
- **When unsure, it assumes 5 minutes.** If it assumed 1 hour on a 5-minute cache, it would refresh after the cache had expired and pay for a full rewrite. Assuming 5 minutes on a 1-hour cache only wastes a few cheap reads.
- **It only refreshes while you're idle.**
- **It uses a lower idle limit:** 3 refreshes by default instead of 5.
- **It uses the status line instead of a pane, mascot or transcript rows.**

## Caveats

- Mods can't read which cache lifetime the session uses. With `auto` and neither variable set, it assumes 5 minutes. If you know your sessions use the 1-hour cache, set Cache lifetime to `1h`. Otherwise it refreshes every 4½ minutes for no benefit.
- Costs are estimated at API list prices, from `hooks/warm.ts` (dated 2026-10-04). On a subscription you pay in plan usage rather than dollars, and Anthropic doesn't publish how cache tokens count towards it.
- Claude Code caps nothing on a refresh's reply. The prompt asks for one word, which took Opus 5.5 about 180 tokens in cache-warmer's measurements.
- The 15% return chance comes from Pi and hasn't been measured for this mod. "Saved" counts a prompt that came back after the cache would have expired and still read it from the cache.

## Testing

Automated tests, from the repo root:

```sh
claude plugin test keep-warm
```

To try it in a live session without installing it:

```sh
claude --plugin-dir ~/mods/keep-warm
```

Then hold a conversation past about 100k tokens on Opus 5.5 and leave it idle. Within 4½ minutes (5-minute cache) the status line should show a refresh, then the time of the next one. Send a prompt after more than 5 minutes and run `/keep-warm`: the refresh should count as saved.
