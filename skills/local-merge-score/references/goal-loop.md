# /goal and /loop templates (Claude Code)

Native Claude Code autonomy for LMS. Not Greptile greploop.

| Command | Next turn when | Stops when |
|---------|----------------|------------|
| `/goal` | Previous turn ends | Evaluator says condition met |
| `/loop` | Time interval | Esc / Claude stop / 7-day expiry |

Requirements: `/goal` ≥ v2.1.139 · `/loop` ≥ v2.1.72.<br>
`/goal` evaluator **does not run tools** — print scorecards and command results in the transcript.

## Full LMS (preferred fix-loop)

```text
/goal LMS = 5/5 with .lms/last.json written this session; zero P0 and zero P1
across code-safety, code-structure, code-quality, code-efficiency (conf≥80);
pnpm local:review evidence in transcript; no @greptile review; stop early and escalate if score plateaus 2 iterations; hard stop after 8 iterations
```

## Per-lens goals (large diffs — order: safety → quality → structure → efficiency)

```text
/goal code-safety clean: no conf≥80 P0/P1 on auth, tenant/RLS, SQL, secrets, fiscal; evidence in transcript; or stop after 6 turns
```

```text
/goal code-quality clean: touched package tests/typecheck green; no conf≥80 P0/P1 correctness; evidence in transcript; or stop after 8 turns
```

```text
/goal code-structure clean: no conf≥80 P1 over-engineering/boundary; DOX updated if durable boundary changed; evidence in transcript; or stop after 6 turns
```

```text
/goal code-efficiency clean: no introduced fallow-audit fail / new high-complexity blocking; evidence in transcript; or stop after 6 turns
```

## /loop (babysit only — do not burn Greptile credits)

```text
/loop 15m check CI on current PR; address new human review comments; never comment @greptile review unless transcript shows Master asked
```

```text
/loop 10m if greptile check already completed, summarize only; do not re-trigger
```

Bare `/loop` uses project `.claude/loop.md` when present (maintenance, LMS-aware, no Greptile auto).

## Hosts without /goal

Use the skill’s `max_iterations` loop and still tag findings with the four lenses.

## Daily mega-PR flow (integration policy)

Default integration: **one PR per day**, not one PR per change.

1. Start of day: `git checkout -b daily/$(date +%Y-%m-%d) origin/master` (or continue the day's branch).
2. All routine work lands on the daily branch; every push is LMS-gated (**5/5 or plateau-escalated**) — quality is enforced continuously at push time, not at PR time.
3. End of day: one PR `daily/YYYY-MM-DD → master`, **1 Greptile credit** on ready, merge `--no-ff`. Granular commits inside preserve bisectability.

**Carve-out:** large/risky workstreams (e.g. a domain migration) get their OWN branch + PR — PR per workstream, not per change and not strictly per day. A giant mixed diff lowers cloud-review quality per finding; separate where it matters.
