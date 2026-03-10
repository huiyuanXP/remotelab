# Core Domain Session Prompts

> Status: copy-paste launch prompts for starting focused implementation sessions.
> Use this file when you want to open a new session for one slice with minimal re-briefing.

---

## How To Use This Note

Each prompt below is designed to be pasted as the **first user message** in a new implementation session.

The prompts assume the repo already contains the current baseline docs.

Each prompt intentionally does three things:

1. points the model at the correct docs in the correct order
2. narrows the scope to one slice
3. adds guardrails so the session does not sprawl into unrelated work

If you want an even shorter version, you can usually send only the first sentence plus the slice id.
But the full templates below are safer because they preload the right context hierarchy.

---

## Shared Preamble

All prompts below assume this doc precedence:

1. `AGENTS.md`
2. `docs/project-architecture.md`
3. `notes/current/core-domain-contract.md`
4. `notes/current/core-domain-implementation-mapping.md`
5. `notes/current/core-domain-refactor-todo.md`
6. this file

General rule for all of these sessions:

- do only the named slice
- keep changes narrow
- do not reopen product decisions unless the code reveals a genuine contradiction
- run focused validation for the files and behavior touched

---

## R2 — Principal/Auth-Session Normalization

### Copy-paste prompt

```text
Work on `R2` in `notes/current/core-domain-refactor-todo.md`.

Before changing code, read only these files in order:
1. `AGENTS.md`
2. `docs/project-architecture.md`
3. `notes/current/core-domain-contract.md`
4. `notes/current/core-domain-implementation-mapping.md`
5. `notes/current/core-domain-refactor-todo.md`

Task:
- Implement `R2` Principal/Auth-Session Normalization.
- Keep external behavior backward compatible.
- Treat the goal as internal normalization toward principal/app-scope semantics, not a product redesign.

Guardrails:
- Do not change frontend behavior except for tiny compatibility fixes if strictly required.
- Do not combine this with session ownership migration beyond what is minimally necessary.
- Do not redesign app entry flow in this session.

What I want from this session:
- normalize current auth-session handling so backend code can reason in principal terms
- reduce direct dependence on raw `visitor` thinking inside auth/access code
- keep login/cookie behavior working
- add or update focused tests for owner vs app-scoped non-owner auth normalization

Validation:
- run targeted tests for auth/access behavior you touched
- summarize exactly what auth shape changed and what stayed backward compatible
```

### Ultra-short version

```text
Do `R2` from `notes/current/core-domain-refactor-todo.md`. Read the current contract + mapping first, keep external behavior backward compatible, and keep the scope to internal auth/principal normalization only.
```

---

## R3 — Session Ownership Field

### Copy-paste prompt

```text
Work on `R3` in `notes/current/core-domain-refactor-todo.md`.

Before changing code, read only these files in order:
1. `AGENTS.md`
2. `docs/project-architecture.md`
3. `notes/current/core-domain-contract.md`
4. `notes/current/core-domain-implementation-mapping.md`
5. `notes/current/core-domain-refactor-todo.md`

Task:
- Implement `R3` Session Ownership Field.
- Add the contract-aligned session ownership field additively.
- Do not break old sessions.

Guardrails:
- Keep this mostly backend/storage focused.
- Avoid frontend changes unless a tiny compatibility patch is strictly required.
- Do not redesign app entry flow or share behavior in this session.

What I want from this session:
- introduce a general initiating-principal field for sessions
- keep legacy session readability
- stop relying only on `visitorId` as the ownership clue
- update focused tests around session creation and visibility metadata

Validation:
- run targeted tests around session creation/listing/metadata
- summarize how legacy sessions are handled and how new sessions are written
```

### Ultra-short version

```text
Do `R3` from `notes/current/core-domain-refactor-todo.md`. Add a contract-aligned session ownership field additively, keep old sessions readable, and keep the scope backend-only unless a tiny compatibility fix is required.
```

---

## R8 — Run/Session Truth Boundary Cleanup

### Copy-paste prompt

```text
Work on `R8` in `notes/current/core-domain-refactor-todo.md`.

Before changing code, read only these files in order:
1. `AGENTS.md`
2. `docs/project-architecture.md`
3. `notes/current/core-domain-contract.md`
4. `notes/current/core-domain-implementation-mapping.md`
5. `notes/current/core-domain-refactor-todo.md`

Task:
- Implement `R8` Run/Session Truth Boundary Cleanup.
- Do not redesign the API.
- Tighten the boundary so session owns durable product truth and run owns execution truth.

Guardrails:
- Do not mix this with auth/principal redesign.
- Do not change share semantics.
- Avoid broad read-path cleanup unless a tiny follow-on fix is necessary.

What I want from this session:
- identify what should stay run-only vs what must always flow back into session truth
- reduce obvious duplication between run-level and session-level facts where practical
- tighten helper boundaries/comments so future changes keep the same split
- add or update focused tests around the boundary you touched

Validation:
- run targeted tests for session/run lifecycle behavior you changed
- summarize which facts are now explicitly treated as session truth vs run truth
```

### Ultra-short version

```text
Do `R8` from `notes/current/core-domain-refactor-todo.md`. No API redesign; just tighten the boundary so session owns durable product truth and run owns execution truth.
```

---

## R12 — Docs And Terminology Sweep

### Copy-paste prompt

```text
Work on `R12` in `notes/current/core-domain-refactor-todo.md`.

Before changing docs, read only these files in order:
1. `AGENTS.md`
2. `docs/project-architecture.md`
3. `notes/current/core-domain-contract.md`
4. `notes/current/core-domain-implementation-mapping.md`
5. `notes/current/core-domain-refactor-todo.md`

Task:
- Implement `R12` Docs And Terminology Sweep.
- Align docs and explanatory comments to the new contract.
- Do not make behavior changes unless absolutely required for documentation accuracy.

Guardrails:
- Keep this as a documentation/terminology cleanup session.
- Do not use the session to sneak in runtime refactors.
- Prefer precise, minimal wording changes over broad rewriting where possible.

What I want from this session:
- remove or de-emphasize outdated `visitor`-centric explanations where they conflict with the new contract
- clarify session/app/principal/share terminology
- align the top-level architecture docs and key repo docs with the new domain baseline
- call out any places where docs must intentionally remain transitional because code has not caught up yet

Validation:
- review the changed docs for consistency
- summarize the main terminology changes and any deliberate transitional wording left in place
```

### Ultra-short version

```text
Do `R12` from `notes/current/core-domain-refactor-todo.md`. Align docs to the new contract, keep scope to terminology and documentation, and avoid behavior changes unless required for accuracy.
```

---

## R13 — Regression Harness And Validation Pack

### Copy-paste prompt

```text
Work on `R13` in `notes/current/core-domain-refactor-todo.md`.

Before changing tests, read only these files in order:
1. `AGENTS.md`
2. `docs/project-architecture.md`
3. `notes/current/core-domain-contract.md`
4. `notes/current/core-domain-implementation-mapping.md`
5. `notes/current/core-domain-refactor-todo.md`

Task:
- Implement the first pass of `R13` Regression Harness And Validation Pack.
- Start with auth/session/share contract coverage.

Guardrails:
- Keep the focus on test coverage and validation scaffolding.
- Do not fix unrelated product bugs unless a tiny change is required to make the target behavior testable.
- Keep the test additions aligned to contract boundaries, not incidental file boundaries.

What I want from this session:
- add or improve focused regression coverage for the most important current contract surfaces
- prioritize auth scope, session access, session metadata expectations, and share behavior
- document the lightweight validation path if that helps future slices

Validation:
- run the targeted tests you add or modify
- summarize which contract boundaries are now covered and what still remains uncovered
```

### Ultra-short version

```text
Do `R13` from `notes/current/core-domain-refactor-todo.md`. Start with auth/session/share contract coverage, keep scope to tests/validation scaffolding, and avoid unrelated fixes.
```

---

## Recommended Launch Order

If you want the next few sessions to compound cleanly, this is a good order:

1. `R2`
2. `R3`
3. `R8`
4. `R13`
5. `R12`

Why this order:

- `R2` and `R3` strengthen the model foundation
- `R8` benefits from the cleaner auth/session vocabulary
- `R13` becomes more useful once some boundary cleanup has happened
- `R12` is safest after a bit more code reality has caught up

That said, `R12` can also be pulled earlier if you specifically want a low-risk cleanup session.

---

## One-Line Launcher Menu

If you want the shortest possible starter messages, use these:

- `R2`: Do `R2` from `notes/current/core-domain-refactor-todo.md`. Keep external behavior backward compatible and keep scope to internal auth/principal normalization.
- `R3`: Do `R3` from `notes/current/core-domain-refactor-todo.md`. Add a contract-aligned session ownership field additively and keep old sessions readable.
- `R8`: Do `R8` from `notes/current/core-domain-refactor-todo.md`. No API redesign; tighten the run/session truth boundary only.
- `R12`: Do `R12` from `notes/current/core-domain-refactor-todo.md`. Align docs and terminology to the new contract without sneaking in behavior changes.
- `R13`: Do `R13` from `notes/current/core-domain-refactor-todo.md`. Start with auth/session/share contract coverage and keep the session test-focused.

These are usually enough because the repo now already contains the contract, mapping, and TODO documents.
