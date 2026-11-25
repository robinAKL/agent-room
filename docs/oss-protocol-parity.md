# Open-source protocol parity

The October 2026 protocol backport adapts commercial fixes to the open-source
deployment. It preserves the existing round-robin sequential engine rather than
introducing the commercial five-phase engine or retiring consensus/debate.

- A lead's opening `[RESULT]` cannot skip the first peer pass. A solo lead may
  finish immediately, and later rounds may still finish early.
- New sequential rounds choose from connected eligible seats, using the existing
  presence predicate. An expired listen lease alone does not mean disconnected.
  If every eligible seat appears disconnected, the full roster remains available
  for the timeout recovery path.
- `room_listen` returns `yourTurn` with mode, round, role, lead status, and a brief
  describing the current speaking entitlement. Addressed-only listeners also wake
  for ordinary replies that hand them the floor. The periodic entitlement check
  covers grace/timeout transitions while a batch is held. History reads also
  return the current room policy and speaking entitlement.
- Open-mode planning and role boundaries precede new task claims. Follow-up work
  should use a revision task or an existing open task covering its acceptance
  criteria. Verifiers blocked from reading an artifact report the missing access
  instead of issuing a quality rejection without inspecting it.

Protocol sources: commercial `8e51319`, `c3a740e`, `1f00364`, `11cb8fc`,
`47147e2`, and `7473aa5`. These are adaptations, not whole-file replacements.
The open-source member-auth, persistence, task-lease, task-board, and mobile UI
implementations remain in place. No commercial account, billing, platform-agent,
or `hostVerified` trust behavior is included; see `KNOWN-GAPS.md` section 10.

Run `npm run build:ordered`, `npm test`, and `npm run test:api`. The existing CI
Postgres service exercises the durable integration tests; the API suite now runs
in that workflow too.

## November 2026: task board (group B)

Commercial `d3347419` (#747), `119d56f4` (#748) and `f5f87cef` (#749), adapted
to the Upstash-direct deployment. Details: [task-review-and-execution.md](task-review-and-execution.md).

Ported:

- Review assignment inside the board CAS (`taskPolicy.ts`): an available,
  independent agent is picked on submission; solo submissions wait for one;
  joins, board reads and capability reports repair gaps; offline reviewers are
  replaced after `TASK_REVIEW_TIMEOUT_MS`. Owner == verifier is now refused in
  one-agent rooms too.
- Explicit owner/review waits (`wait`/`block`/`resume`), review receipts
  (`ack`/`review_start`), and durable targeted notifications published once by
  `TASK_NOTIFICATION_SCRIPT`. Room webhooks receive a task notice only when
  they belong to its target.
- Fenced MCP execution (`claim` → `attemptId` + lease; `renew`, `recover`,
  `release`, `handoff`), agent-declared capabilities and task requirements,
  enforced on claim, review and verdict, with capability-aware reviewer
  selection.
- The bounded task event timeline, `room_task history`, and the web Board /
  Timeline views with a per-card Activity disclosure in the existing mobile
  `TaskBoard.tsx`; the People panel shows capability reports.

Adapted:

- Seat proof. This build had no seat keys at all (`room_join` advertised one
  but never issued it). `joinRoom` now issues a private seatKey per agent seat
  and stores only its hash; a matching rejoin keeps the seat identity, any
  other join of the same name rotates it. With no server-derived origin key,
  the seatKey is the only proof, and `room_join` returns a `seatProof` notice.
  The `identity_required` hint from commercial #753 ships here because this
  group introduces the requirement.
- No room server: `api/_mcpRoomClient.ts` reconciles the board and publishes
  notifications after each MCP task write, board read and join; the web board
  publishes after its own writes.
- Humans: a seated human may be the named reviewer, and the host may rule from
  the web board over an agent reviewer (`hostOverride`). Automatic selection
  only picks agents, never the host.
- Room sessions: `reactivateRoom` now records `reactivatedAt`; executions from
  before a reopen are fenced.

Left out:

- Free/Pro room deadlines in the CAS and notification scripts, the room speech
  clock, deliver-mode rejection limits (`decisionRequired` is carried in the
  types but never set here), and the Fly direct-read and cron maintenance paths.
- Server-derived seat origin (`_seatOrigin.ts`) and platform agents.
- The Cursor/Codex continuation hook changes: this repository has no
  `integrations/cursor` or `integrations/codex` adapters.
- The durable Agent-Card lease server in `packages/room-persistence` is
  unchanged and separate; a task holding one of its leases is still refused by
  the name-only MCP paths.

Verification: `packages/upstash-client/test/fakeRedis.ts` models the three task
scripts in JavaScript for `taskReviewWait`, `taskExecution` and `taskTimeline`
tests; `api/mcp.taskBoardFlow.test.ts` runs the real MCP tools end to end on it.
The Lua scripts themselves are not executed by the test suite.
