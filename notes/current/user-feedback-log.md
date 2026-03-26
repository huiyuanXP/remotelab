# Shared User Feedback Log

Status: active evidence log as of 2026-03-25

Companion operating note: `notes/current/product-mainline.md`

Directional synthesis: `notes/directional/product-vision.md`

## Purpose

- Keep product feedback visible to both human and AI collaborators.
- Preserve the signals that should change product judgment without storing raw private transcripts in the repo.
- Make it easy to see what repeated evidence already exists before starting new product discussions.

## Capture rules

- Log only sanitized product evidence.
- Prefer short entries with clear implications.
- Merge repeated evidence into existing themes when possible instead of duplicating near-identical entries.
- When a signal becomes stable product direction, promote it into `notes/directional/product-vision.md`, `README.md`, `README.zh.md`, or a current execution note.

## Current carried-forward signals

### 2026-03-26 — new instances need an auto-open welcome session, not an empty chat shell

- Source: direct user feedback while testing a fresh trial instance
- User slice: first-time owner opening a newly created RemoteLab instance on mobile
- Observed friction or ask: landing on an empty session list (or a stray blank default chat) gives no guidance and makes the product feel broken instead of guided
- Signal: new instances should auto-create the built-in Welcome session and open it by default; zero-active-session owner states should prefer guided recovery over an empty shell
- Implication: server-side bootstrap should guarantee an active Welcome session for owner-first entry, and onboarding must be resilient to legacy blank archived sessions
- Promote to: onboarding implementation, welcome-session regression tests

### 2026-03-25 — mainstream automation framing beats orchestration-first framing

- Source: synthesis of recent user interviews and product review
- User slice: early high-fit non-technical operators and coordinators
- Signal: users respond more strongly to "hand repetitive digital work to AI" than to orchestration or session jargon
- Implication: keep multi-session and context carry as enabling-capability language, not the first-sentence product promise
- Promoted to: `README.md`, `README.zh.md`, `notes/directional/product-vision.md`

### 2026-03-25 — early high-fit users are time-pressed coordinators with digital admin work

- Source: recent interview summary
- User slice: traditional-industry middle managers and small owner-operators
- Signal: the best early users already delegate to people, still carry digital admin overhead themselves, and care sharply about saved time
- Implication: onboarding and examples should center on repetitive information work, not AI-native power-user language
- Promoted to: `notes/directional/product-vision.md`

### 2026-03-25 — first trusted automation win matters more than capability breadth

- Source: product-direction reset and interview synthesis
- User slice: mainstream guided-automation users
- Signal: people need a fast, concrete automation win before advanced workflow organization matters
- Implication: prioritize intake, welcome flow, review, delivery, and a trusted first outcome over showcasing orchestration depth
- Promoted to: `notes/directional/product-vision.md`, `notes/current/product-mainline.md`

## Entry template

### YYYY-MM-DD — short title

- Source:
- User slice:
- Recurring work:
- Observed friction or ask:
- Signal strength:
- Product implication:
- Promote to:
- Follow-up:
