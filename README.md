# claude-code-mods

Plugins for Claude Code that run code around the agent's tool calls: they can block a call before it runs, add a note to its result, or put a message in front of the person. They work in the terminal and in the desktop app's Code tab. Each folder is one plugin.

| Mod | What it does |
|---|---|
| [`tripwire`](tripwire/) | Blocks or annotates shell mistakes that recur in Claude Code sessions: whole-disk `find`, long foreground sleep loops, errors hidden by `\| tail`, forgotten background shells |
| [`usage-dollars`](usage-dollars/) | Spend in dollars for today and the month so far against a monthly budget: status line, toast at 80% and 100%, `/spend` |
| [`model-advisor`](model-advisor/) | Classifies a session's first prompt with Jev and, when it needs a stronger model than the session is on, offers to run `/model` and resend it |

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

The replay applies the same patterns the rules use to the Bash calls in those transcripts. The counts describe one person's sessions, so another machine will see different numbers.

`# tripwire:allow` in a command lets a block through when the person asked for exactly that. `/tripwire` lists the counts for the current session and for all sessions (kept in the plugin store) and the open background tasks. The counts show whether a rule still fires, and a rule that never trips is a candidate for deletion.

## usage-dollars

Books each session's cost (`$.session.usage().cost.usd`, what `/cost` totals) into a per-day ledger in the plugin store, shared by every session on the machine. The status line shows `$1.20 today · $34.10/$100.00 month (34%)`, a toast fires once at 80% and once at 100% of the budget, and `/spend` prints the same figures plus what remains. Per-conversation spend is not shown: the default donut chart button covers it.

Set the budget in the config menu (`monthlyBudgetUsd`, default 100, 0 hides it). The ledger starts when the mod is first loaded, so earlier spend is not counted, and a resumed session's past cost is not re-booked.

## model-advisor

The first-prompt model advisor from `oaustegard/claude-workspace` (`scripts/model_advisor.py`), rebuilt as a mod. The hook version guessed the session's model from the CLI's argv and could only block the prompt and ask the person to switch and resend by hand. The mod reads the model with `$.session.model()`. On a confident upgrade it holds the prompt and offers three buttons above the prompt box: *Switch to Opus 5.5 and send* (it runs `/model opus` and resends), *Send on Sonnet 5.5*, or *Edit*, which puts the text back in the box. `/advisor switch` and `/advisor send` do the same from the keyboard, and plain `/advisor` lists the recent decisions.

The rules are the hook's: upgrades only, fired at 75% confidence. A prompt that only points at the work (`Resume 71afa1b8`) makes no call, and only the first prompt of a fresh session is classified, since a switch after the first turn re-reads the whole context at full price. A prompt from a phone or the web (the Remote Control bridge), or one carrying an attachment, is never held. It runs, and the model is told to quote the advice and give the substantive work to a subagent on the stronger model. `#no-advice` in a prompt skips it. A Routine or SDK session (`CLAUDE_CODE_ENTRYPOINT` `remote_trigger*`/`sdk*`) is never advised, and `MODEL_ADVISOR=off` turns it off. Any classifier failure lets the prompt through.

The classifier is Jev, reached through TypeSafe (`TYPESAFE_API_KEY`) or the Cloudflare AI Gateway (`CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_GATEWAY_ID`), read from the environment. With neither present the mod does nothing. Options: `autoSwitch` switches and resends without asking; `downgrade` also suggests cheaper tiers; `quiet` hides the one-line verdict the status line otherwise shows when it stays silent.

The mod exports `MODEL_ADVISOR_MOD=1`, and the workspace hook stands down when it sees that, so loading both advises once. `hooks/advice.ts` carries the tier table and criteria, and `scripts/model_advisor.py` has a copy that must change with it.
