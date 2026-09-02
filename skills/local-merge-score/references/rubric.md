# Local Merge Score rubric (0–5)

Aligned with Greptile’s merge-confidence semantics (not identical algorithm).

## Score meanings

| LMS | Meaning | Action |
|-----|---------|--------|
| **5** | Production ready | Merge |
| **4** | Minor polish | Merge after small fixes |
| **3** | Implementation issues | Address feedback first |
| **2** | Significant bugs | Needs rework |
| **0–1** | Critical problems | Major rethink / block |

## Inputs

1. **Agent findings** after confidence ≥ 80 filter: counts of P0, P1, P2<br>
2. **fallow audit** verdict (optional): `pass` | `warn` | `fail` | `skipped`<br>
3. **graphify signals** (optional): risk zone, blast radius notes<br>

## Base score (take first match top → bottom)

1. If **P0 ≥ 1** → **LMS = 1** (use **0** if exploitability/data-loss is clear)<br>
2. Else if **P1 ≥ 2** OR (**P1 ≥ 1** AND fallow = `fail`) → **LMS = 2**<br>
3. Else if **P1 = 1** OR (**P2 ≥ 3** AND fallow = `warn`/`fail`) → **LMS = 3**<br>
4. Else if **P2 ≥ 1** OR fallow = `warn` → **LMS = 4**<br>
5. Else (P0=P1=P2=0, fallow pass/skipped) → **LMS = 5**

## Contextual caps (apply after base; keep the **minimum**)

| Diff touches (path heuristics) | Rule |
|--------------------------------|------|
| `services/fiscal/**` | Any remaining P1 → LMS ≤ 2; any P2 only → LMS ≤ 4 |
| Auth / session / RLS / tenant middleware | Same as fiscal |
| Payments / acquirer / money paths | Same as fiscal |
| `**/*.{sql,prisma}` schema | Any P1 → LMS ≤ 2 |
| Only `**/*.md`, `.github/**`, lockfiles, generated | Do not invent P1; empty review → LMS 5 |

## Lens caps

| Lens signal | Rule |
|-------------|------|
| Any **code-safety P0** (conf ≥ 80) | LMS ≤ 1 (0 if clear exploit/data loss) |
| Any **code-safety P1** on fiscal/auth/tenant | LMS ≤ 2 |
| Only **code-structure** / **code-efficiency** P2 | LMS 4 is allowed |
| **code-quality P1** correctness | Base table (usually LMS 2–3) |

Graphify-assisted (when oriented):

| Signal | Rule |
|--------|------|
| Changed symbol is a god-node or high fan-in hub | Prefer not to claim LMS 5 if any P2 remains |
| `graphify path` shows new edge into auth/tenant/fiscal | Treat as risk zone for caps above |

## Confidence filter

- Only findings with **confidence ≥ 80** enter the count.<br>
- Speculative “might be nice” items are P2 at most and should usually be dropped below 80.<br>
- Pre-existing debt outside the diff: **exclude**.

## Loop policy

| Target | When |
|--------|------|
| **4** (default) | Ship-ready for most PRs; residual cosmetic P2 OK |
| **5** | Zero P0/P1/P2 after filter; use for sensitive areas or user request |

Target **5/5** to go up to PR. Plateau rule: 2 consecutive iterations without score improvement → stop and escalate to Master (a stuck score signals a pending human decision, e.g. a P0 cap — not lack of iterations). Hard ceiling **8** iterations as runaway backstop; report final LMS either way.

## Explicit non-goals

- Matching Greptile’s proprietary model mix or graph index<br>
- Spending Greptile credits<br>
- Replacing CI (lint/test still required separately)<br>
