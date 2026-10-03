import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BgTask, Counts } from '../types'

// Each trip below answers a failure mined from this machine's transcripts
// (May–Oct 2026). The deny texts are what the model reads, so they name the
// alternative, not just the rule.

const bg = atom({ plugin: 'tripwire', key: 'bg' } as const, [] as BgTask[])
const counts = atom({ plugin: 'tripwire', key: 'counts' } as const, {} as Counts)

const ALLOW = /#\s*tripwire:allow\b/
const FG_WARN_MS = 5 * 60_000
const BG_MAX_MS = 2 * 60 * 60_000 // Bash's own background ceiling

// `find /`, `find ~`, `find $HOME`, `find /Users/<me>` with no depth limit:
// 5 of these were auto-backgrounded and left running past the PR.
const FIND_ROOT =
  /(?:^|[\s;&|(`])find\s+(?:-[HLP]\s+)*(?:\/|~\/?|\$HOME\/?|\/Users(?:\/[^/\s]+)?\/?|\/System\/?|\/Library\/?)(?=\s|$)/

// A foreground loop that sleeps: 27 runs of `for i in $(seq 1 118); ... sleep 5`
// held the session ~10 minutes each.
// Only a sleep inside a shell loop's do…done body counts, and an explicit
// `timeout N` around it caps the estimate.
function pollSeconds(cmd: string): number {
  const LOOP = /\b(for|while|until)\b([^\n]*?)(?:;|\n)\s*do\b([\s\S]*?)\bdone\b/g
  const cap = cmd.match(/\bg?timeout\s+(\d+)\b/)
  let worst = 0
  for (const [, kind, head = '', body = ''] of cmd.matchAll(LOOP)) {
    const sleep = body.match(/\bsleep\s+(\d+(?:\.\d+)?)/)
    if (!sleep) continue
    const per = Number(sleep[1])
    let total: number
    if (kind !== 'for') {
      total = per >= 5 ? Infinity : 0
    } else {
      const seq = head.match(/\bseq\s+(?:(\d+)\s+)?(\d+)\b/)
      const brace = head.match(/\{(\d+)\.\.(\d+)\}/)
      const list = head.match(/\bin\s+([^$`(){}]+)$/)
      const n = seq
        ? Number(seq[2]) - Number(seq[1] ?? 1) + 1
        : brace
          ? Number(brace[2]) - Number(brace[1]) + 1
          : list
            ? list[1].trim().split(/\s+/).length
            : 1
      total = n * per
    }
    worst = Math.max(worst, total)
  }
  return cap ? Math.min(worst, Number(cap[1])) : worst
}

// Output that says "failed" under an exit status of 0: 146 of 631 Bash calls
// piped into tail/head, which hid ModuleNotFoundError and `gh` aborts.
const MASKED: RegExp[] = [
  /Traceback \(most recent call last\)/,
  /\b[A-Z]\w*(?:Error|Exception): \S/,
  /^(?:error|fatal|aborted)(?:\[\w+\])?: /im,
  /command not found/,
  /^FAILED\b|\b\d+ failed\b/m,
  /npm ERR!/,
]

const HINTS: [RegExp, string][] = [
  [
    /no matches found:/,
    'zsh aborts on an unmatched glob or an unquoted ? or * (URLs with query strings included). Quote the argument, or guard globs with `setopt null_glob`.',
  ],
  [
    /command not found: timeout|timeout: command not found/,
    'macOS has no `timeout`. Use `gtimeout` (brew coreutils) or `perl -e \'alarm shift; exec @ARGV\' <secs> <cmd>`.',
  ],
  [
    /must first push the current branch to a remote, or use the --head flag/,
    '`gh pr create` could not infer the branch. Pass `--head <branch>`, plus `--repo owner/name` when not run from inside the clone.',
  ],
  [/Unknown JSON field: "?merged\b/, '`gh pr view --json` has no `merged` field; ask for `state` or `mergedAt`.'],
]

type BashRecord = {
  backgroundTaskId?: string
  timedOutAfterMs?: number
}

const inFlight = new Map<string, { label: string; startedAt: number; isWarned: boolean }>()

const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))}m`

async function trip($: EngineInterface, name: string) {
  await update($, counts, c => ({ ...c, [name]: (c[name] ?? 0) + 1 }))
  const all = ((await $.store.get('counts')) ?? {}) as Counts
  await $.store.set('counts', { ...all, [name]: (all[name] ?? 0) + 1 })
}

async function liveBg($: EngineInterface, now: number) {
  const list = await read($, bg)
  const live = list.filter(t => now - t.startedAt < BG_MAX_MS)
  if (live.length !== list.length) await update($, bg, () => live)
  return live
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const parts: string[] = []
  const live = await liveBg($, now)
  if (live.length > 0) {
    const oldest = Math.min(...live.map(t => t.startedAt))
    parts.push(`${live.length} bg · oldest ${minutes(now - oldest)}`)
  }
  for (const call of inFlight.values()) {
    const ran = now - call.startedAt
    if (ran < 60_000) continue
    parts.push(`${short(call.label, 28)} ${minutes(ran)}`)
    if (ran > FG_WARN_MS && !call.isWarned) {
      call.isWarned = true
      $.ui.toast(`Still in the foreground after ${minutes(ran)}: ${short(call.label)}`, { timeoutMs: 10_000 })
    }
  }
  $.ui.status(parts.length > 0 ? `tripwire: ${parts.join(' · ')}` : undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tripwire',
      description: 'Show what tripwire caught this session and in total, and which background tasks are open',
    })
    $.clock.every(15_000, () => void tick($))

    return next(e)
  })

  on('command.run', { command: 'tripwire' }, async $ => {
    const now = await $.clock.now()
    const session = await read($, counts)
    const total = ((await $.store.get('counts')) ?? {}) as Counts
    const names = [...new Set([...Object.keys(total), ...Object.keys(session)])].sort()
    const live = await liveBg($, now)
    const lines = [
      names.length === 0
        ? 'Nothing tripped yet.'
        : names.map(n => `${n}: ${session[n] ?? 0} this session, ${total[n] ?? 0} total`).join('\n'),
      live.length === 0
        ? 'No background tasks open.'
        : `Open background tasks:\n${live
            .map(t => `  ${t.id}  ${minutes(now - t.startedAt)}  ${t.isAuto ? '(auto-backgrounded) ' : ''}${t.label}`)
            .join('\n')}`,
    ]

    return { text: lines.join('\n\n') }
  })

  // How long every foreground call has been running, for the status line.
  on('tool.call', async ($, e, next) => {
    const isBackground = 'run_in_background' in e && e.run_in_background === true
    if (isBackground || e.agentId) return next(e)
    const label =
      e.tool === 'Bash' ? (e.description ?? e.command) : e.tool === 'Agent' ? `Agent: ${e.description}` : e.tool
    inFlight.set(e.tool_use_id, { label, startedAt: await $.clock.now(), isWarned: false })
    try {
      return await next(e)
    } finally {
      inFlight.delete(e.tool_use_id)
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = e.command
    const isAllowed = ALLOW.test(cmd)

    // Quoted text is an argument (a prompt, a commit message), not a command.
    const unquoted = cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''")
    if (!isAllowed && FIND_ROOT.test(unquoted) && !/-maxdepth\b/.test(unquoted)) {
      await trip($, 'findRoot')
      return {
        deny:
          'tripwire: `find` over the whole disk or home directory runs for minutes and gets left in the background. ' +
          'Use `mdfind -name <name>` (Spotlight), `mdfind -onlyin <dir> <query>`, or `find <specific dir> -maxdepth N`. ' +
          'If the person asked for exactly this, append `# tripwire:allow`.',
      }
    }

    const pollSecs = e.run_in_background === true || isAllowed ? 0 : pollSeconds(cmd)
    if (pollSecs > 120) {
      await trip($, 'pollLoop')
      return {
        deny:
          `tripwire: this loop sleeps in the foreground for up to ${pollSecs === Infinity ? 'an unbounded time' : `${Math.round(pollSecs)}s`}, ` +
          'and the person cannot do anything meanwhile. Use the Monitor tool with an until-loop (you are notified when it ' +
          'fires), or run the command with run_in_background and wait for its notification.',
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const text = ran.text ?? ''
    const context: string[] = []

    if (ran.isError !== true && /\|\s*(?:tail|head)\b/.test(cmd) && !/pipefail/.test(cmd)) {
      const hit = MASKED.map(re => text.match(re)).find(m => m !== null)
      if (hit) {
        await trip($, 'maskedError')
        context.push(
          `tripwire: the output contains "${short(hit[0].trim(), 60)}", but the exit status is 0 because the pipeline ends ` +
            'in tail/head. Treat this command as failed until you have checked; `set -o pipefail;` keeps the real status.',
        )
      }
    }

    for (const [re, hint] of HINTS) {
      if (re.test(text)) {
        await trip($, 'hint')
        context.push(`tripwire: ${hint}`)
      }
    }

    if (ran.isError !== true) {
      const record = (ran.result ?? {}) as BashRecord
      const now = await $.clock.now()
      if (record.backgroundTaskId) {
        const task: BgTask = {
          id: record.backgroundTaskId,
          label: short(e.description ?? cmd, 60),
          startedAt: now,
          isAuto: record.timedOutAfterMs !== undefined,
        }
        await update($, bg, list => [...list.filter(t => t.id !== task.id), task])
        if (task.isAuto) {
          await trip($, 'autoBg')
          $.ui.toast(`Auto-backgrounded after ${Math.round((record.timedOutAfterMs ?? 0) / 1000)}s: ${task.label}`)
        }
      }
      void tick($)
    }

    return context.length > 0 ? { ...ran, context: [...(ran.context ?? []), ...context] } : ran
  })

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const id = e.task_id ?? e.shell_id
    if (id) await update($, bg, list => list.filter(t => t.id !== id))

    return ran
  })

  // Background tasks end with a <task-notification> row.
  on('session.append', async ($, e, next) => {
    for (const block of e.message.content) {
      const text = block.type === 'text' && typeof block.text === 'string' ? block.text : ''
      if (!text.includes('<task-notification>')) continue
      const done = [...text.matchAll(/<task-id>([^<]+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>/g)]
        .filter(m => m[2] !== 'running')
        .map(m => m[1])
      if (done.length > 0) await update($, bg, list => list.filter(t => !done.includes(t.id)))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result

    const now = await $.clock.now()
    const live = await liveBg($, now)
    if (live.length > 0) {
      await trip($, 'bgAtEnd')
      $.ui.toast(
        `${live.length} background task${live.length === 1 ? '' : 's'} still running: ` +
          live.map(t => `${short(t.label, 30)} (${minutes(now - t.startedAt)})`).join(', '),
        { timeoutMs: 10_000 },
      )
    }

    return result
  })
}
