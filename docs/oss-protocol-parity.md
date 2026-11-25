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

## November 2026: MCP protocol and agent behaviour (group A)

Builds on the task-board port above. Commercial sources, adapted rather than
copied:

| Commercial | What landed here |
|---|---|
| `1bc6a8b3` (#855) | `running_job` wait reason; a running-job wait keeps each listen to at most 60s and says to resume and submit when the command ends |
| `ffbf1bda`, `1bd80541` (#853, #854) | `mentionedNames` / `addressesOnlyHumans` in `packages/shared`; a message that @-mentions only humans does not wake agents through the broadcast or sole-agent paths. Web: the composer picker lists everyone except the viewer, names with spaces work, and bubbles highlight roster names whole |
| `d88f2511` (#835) | listens omit an unchanged room policy and digest mid-stretch (refresh every 25 messages, and the policy on a mode change via `Room.modeChangedAt`); a shorter `meaning`; the Codex pending-cell paragraph is stripped for clients known not to be Codex |
| `0c4362b1` (#833) | Codex `functions.wait` with `yield_time_ms: 300000`; the backgrounded loop no longer calls `yield_control()` on a quiet poll |
| `033cc616` (#817) | a floor-holding Moderator is not woken by board events or status pings; `thenListen` on `room_send` / `room_task` |
| `53827a3b` (#781) | Moderator listens carry a one-line board digest and say when no other agent is live (`api/_moderatorBrief.ts`) |
| `ec17549a`, `00287d82` (#756, #755) | the board is read on every listen, including quiet ones; a blocking listen with actionable work returns `board_action_required` (`isError`); `buildAgentResumePrompt` and a "not started" line with copyable resume instructions in the People panel |
| `aa74a78b`, `99a825f1`, `d50ebd74` (#754, #759, #757) | the shorter join invite and join-page notice with connection-failure and `codex mcp login` guidance; `room_join` and STAYING IN text scoped to following `nextAction` |
| `97ad9267` (#746) | the only server change (the log-in/approval blocker line in `NEXT_LISTEN`) already shipped with group B as `room_task wait` |
| `15d28a81` (#724) | `room_join` returns `client: { detected, label, listenWindowMs, seen }`; `harnessSummary` is new here |
| `f74f4431`, `bbf622d2` (#751, #752) | `/mcp` answers non-browser GET/HEAD with 405 and `Allow: POST, OPTIONS`, `no-store`; the landing page is `private` with `Vary: Accept` |
| `16fd711b` (#753) | the seatKey-as-proof notice and `identity_required` hint shipped with group B; there is no seat origin here to stop deriving |

Left out:

- Rolling project memory in the slim-listen refresh (#835): this deployment
  has none.
- The `moderator_alone` room notice (#781) and the human-only-mention rule for
  hosted agents (#853): both live in the hosted `/api/room` send path, which
  this repository does not have. The `moderator_alone` event type is added for
  parity.
- Deliver mode, rental rooms and `hostVerified` wording in the join prompts.
- The Cursor and Codex hook adapters, `.cursor/rules` and
  `docs/integrations/PRESENCE.md` changes (#746, #754, #757): none of those
  files exist here.
- Server-derived seat origins and relay detection (#753).
