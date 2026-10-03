# claude-code-mods

Plugins for Claude Code that run code around the agent's tool calls: they can block a call before it runs, add a note to its result, or put a message in front of the person. They work in the terminal and in the desktop app's Code tab. Each folder is one plugin.

| Mod | What it does |
|---|---|
| [`tripwire`](tripwire/) | Blocks or annotates shell mistakes that recur in Claude Code sessions: whole-disk `find`, long foreground sleep loops, errors hidden by `\| tail`, forgotten background shells |

The hook API these mods use is marked early access in Claude Code's own type declarations and can change between releases. Those declarations were written by Claude Code 2.1.286, the version tripwire was developed against.

## Layout

A mod folder holds `.claude-plugin/plugin.json`, `hooks/hooks.json` naming one module, the module itself, and `types/index.d.ts` when the mod keeps state. Claude Code generates `.claude-plugin/types/` the first time it loads a mod, so that directory is not in the repo.

## Enabling

List each mod folder, `:`-separated, in the `env` block of `~/.claude/settings.json`. Claude Code reads this variable only from user settings, never from a project's:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-code-mods/tripwire" }
```

Interactive sessions watch the folder and reload on save. To check a change before committing it:

```bash
claude plugin validate tripwire
```

## tripwire

Tripwire was built from 17 local session transcripts: 546 Bash calls. Each rule below answers a mistake that appears in them more than once. A rule can block a call before it runs, add a note the model reads after the result, or show the person a toast or a status line.

| Rule | Kind | Evidence (replayed on the transcripts) |
|---|---|---|
| `find` over `/`, `~`, `$HOME` or `/Users/<name>` with no `-maxdepth` | block | 5 calls, each moved to the background automatically and left running past the end of the task |
| foreground loop whose `sleep` totals more than 120s (an unbounded `while`/`until` with sleep ≥ 5 counts; `timeout N` caps the total) | block | 35 calls; the person's reaction to one: "what on earth is taking so long?" |
| error text in output whose pipeline ends in `tail`/`head` and exits 0 | note | 20 of 233 such calls |
| zsh glob abort, macOS has no `timeout`, `gh pr create` without `--head`, `gh pr view --json merged` | note | one fix line each |
| background shells still open | status line, plus a toast at turn end | "what are the 5 shells that are open still doing?" |
| foreground call running longer than 5 minutes | status line, then a toast | a 51-minute foreground Agent call |
| non-`main` branch pushed with no PR in the same turn | toast | for workflows where every pushed branch gets a PR |

The replay applies the same patterns the rules use to the Bash calls in those transcripts. The counts describe one person's sessions, so another machine will see different numbers.

`# tripwire:allow` in a command lets a block through when the person asked for exactly that. `/tripwire` lists the counts for the current session and for all sessions (kept in the plugin store) and the open background tasks. The counts show whether a rule still fires, and a rule that never trips is a candidate for deletion.
