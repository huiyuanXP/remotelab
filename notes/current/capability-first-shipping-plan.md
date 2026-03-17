# Capability-First Shipping Plan

Status: active working direction as of 2026-03-17

Concrete execution companion: `notes/current/board-fanout-next-push.md`

## Decision

- Prioritize shaping the next product expression before another deep refactor pass.
- Accept some local architectural roughness during discovery as long as the system stays session-first, restart-safe, and easy to recover.
- Limit refactor work to the slices directly required by the next product capabilities or by regressions those slices expose.

## Target product shape

- `Board` becomes the primary owner overview of live work.
- One high-trust manager surface can accept a user request and fan it out into multiple focused child sessions.
- Child sessions stay mostly hidden by default; the board and handoff links are the main visibility layer.
- Context carry stays explicit and bounded; compaction/context reuse is infrastructure, not the main product surface.
- Sessions remain the canonical durable object; the board is a derived surface over session metadata and activity.

## Why the current system can bend into this shape

- The owner UI already ships a real `Board` tab and session-derived workflow columns.
- Session metadata already includes useful board signals such as `name`, `group`, `description`, `workflowState`, `workflowPriority`, and `lastReviewedAt`.
- Single-session delegation already exists through `POST /api/sessions/:sessionId/delegate` and `remotelab session-spawn`.
- Context compaction, continuation summaries, and prepared fork-context reuse already exist as infrastructure primitives.

## Product judgment

### 1. Board first

- Do not introduce a separate durable `Task` object yet.
- Treat the board as a session-first orchestration surface.
- Use board work to decide whether `project`, `status`, `priority`, and child-session visibility need stronger contracts.

### 2. Multi-session fan-out second

- The product win is not only "forking"; it is one user turn intentionally spawning several bounded worker sessions.
- Keep the manager/parent session lightweight and orchestration-focused.
- Return visible child-session links and concise aggregation back into the parent, rather than pushing every sub-step into the main thread.

### 3. Context carry/cache as enabling infrastructure

- Fan-out is only pleasant if child sessions receive bounded handoff context instead of replaying an entire parent transcript.
- Compaction and prepared context reuse matter because they keep the manager and child sessions small enough to remain cheap and fast.
- This should be verified and tuned now, but it should not become a larger refactor program by itself.

## Immediate gaps to close

### Board gaps

- Finalize the product contract for the shipped `Board` surface: columns, default sort, and how much child-session detail is visible by default.
- Make session presentation fields easier to mutate through session APIs so the agent can maintain the board without UI-only hacks.
- Decide whether `group` is enough for v1 grouping or whether a separate lightweight `project` field is needed immediately.

### Multi-session gaps

- Promote the existing delegation primitive into an intentional many-child workflow contract.
- Confirm the parent session always receives visible handoff notices and child-result aggregation when one turn fans out.
- Decide whether the first shipped surface is agent-internal only, owner-visible UI, or both.

### Context/cache gaps

- Confirm the shipped compaction path, summary/refs cache path, and prepared fork-context path all behave as expected in current code.
- Add lightweight observability so we can tell whether a session continued from raw history, summary handoff, or prepared branch context.
- Keep this as focused validation/tuning work, not a speculative cache architecture rewrite.

## Suggested near-term execution order

1. Productize the existing `Board` into the default owner work surface.
2. Make session presentation fields (`title`, `group`, `description`) and the minimum board-driving metadata reliably writable through APIs.
3. Turn single-child delegation into a deliberate multi-session orchestration pattern with parent aggregation.
4. Add context-carry/cache observability and tune the paths that the new orchestration pattern depends on.
5. Layer the `Control Inbox` / dispatcher surface on top once the board and fan-out contracts feel real.

## Shipping candidate for the next push

- The owner lands on `Board` as the default orchestration surface rather than treating it as a secondary tab experiment.
- A manager/control session can fan one user turn out into several focused child sessions and report back with visible handoff/result links.
- Session cards on the board tell the truth well enough for daily operation using only session-derived metadata and activity.
- Context carry remains bounded and observable so a child session or resumed session is not silently replaying too much history.

## The next four slices

### Slice 1 — `Board v1` as the primary owner surface

- Keep the current session-derived board model; do not add a new durable task object.
- Make the shipped board contract explicit: `Active`, `Waiting`, `Open`, `Parked`, `Done` stay the primary columns.
- Keep grouping/project expression lightweight for now: use `group` first, and only add `project` if board usage immediately proves `group` is too weak.
- Child sessions should stay mostly hidden by default unless they are waiting on the user, manually opened, pinned, or otherwise promoted by priority.

### Slice 2 — board-driving metadata write path

- Add the missing write path for `group` and `description` through the session APIs so the model can maintain the board directly.
- Keep `workflowState`, `workflowPriority`, and `lastReviewedAt` as the main explicit board-state controls for v1.
- Treat `title` / `group` / `description` as the minimum presentation contract needed before the board can feel AI-maintained instead of hand-curated.

### Slice 3 — one-turn multi-session fan-out

- Promote the current single-child delegation primitive into a deliberate multi-child orchestration pattern.
- Require one visible parent-side handoff note per spawned child plus one concise parent-side aggregation result at the end.
- Keep child sessions operationally independent; avoid over-modeling persistent hierarchy before lived use proves we need it.
- Use the existing failing recursive fan-out validation as the first concrete regression to fix rather than inventing a new orchestration abstraction.

### Slice 4 — context carry/cache confirmation

- Verify the three paths that matter for the new product shape: compaction handoff, summary/refs cache reuse, and prepared fork-context reuse.
- Add lightweight observability for which continuation path a run actually used: raw history, summary handoff, or prepared branch context.
- Keep this scoped to enabling the board + fan-out workflow; do not turn it into a general cache architecture rewrite.

## Push gate

- `Board` is good enough to use as the owner’s primary work overview.
- `group` and `description` are writable through session APIs, not only via side effects or UI-only flows.
- One-turn multi-session fan-out is demoable end to end with visible parent handoffs and child links.
- The known recursive fan-out regression is fixed.
- The known fork-context regression is either fixed or explicitly judged non-blocking for this push.
- We can tell, at least in debug/operator surfaces, whether continuation came from history, summary handoff, or prepared context.

## What not to optimize yet

- Do not restart a broad core-domain cleanup just because the old refactor map exists.
- Do not introduce a heavyweight project/task hierarchy before the board proves it is needed.
- Do not let provider-registry or broader app-model cleanup outrank the board + fan-out validation pass unless they directly block it.

## Current validation snapshot

- Single delegate/session-spawn flow is already validated by `tests/test-http-runtime-phase1.mjs`.
- Session-state/board workflow classification is validated by `tests/test-chat-session-state-model.mjs`.
- Auto-compaction and summary/refs cache contracts are validated by `tests/test-auto-compaction.mjs` and `tests/test-http-session-summary-refs.mjs`.
- Recursive fan-out and fork-context validation still need focused follow-up because current dedicated tests expose regressions before the full happy path is green.
