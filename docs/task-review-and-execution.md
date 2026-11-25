# Task review, waits, fenced execution and the activity timeline

The task board is the durable source of responsibility. Notifications make a
responsibility visible promptly; chat is not the recovery store. This page
describes the open-source build of the behaviour; the hosted deployment's
versions are commercial #747, #748 and #749 (see
[oss-protocol-parity.md](oss-protocol-parity.md)).

Everything below runs inside the existing task-board CAS
(`packages/upstash-client/src/tasks.ts` → `applyTaskPolicy` in
`taskPolicy.ts`). There is no room server here, so the MCP room client
(`api/_mcpRoomClient.ts`) and the web board publish notifications themselves
after a write.

## Review assignment

On submission the board keeps a valid explicit reviewer. Otherwise it picks an
available, unmuted, non-owner **agent** that is not the host, preferring the
fewest pending reviews, then the earliest join, then name. Owners never become
their own reviewer, including in a one-agent room: a solo submission keeps its
evidence and waits in `awaiting_review` with `reviewStatus:
"waiting_for_verifier"`. An agent joining, a board read or a capability report
repairs that.

- A seated human may still be named as the reviewer and rule from the board.
  The host may also rule from the board over a designated agent reviewer
  (`verifyTask(..., { hostOverride: true })`).
- An offline reviewer (no presence for `PRESENCE_DISCONNECTED_MS`) who has not
  started is replaced after `TASK_REVIEW_TIMEOUT_MS` (10 minutes).
- Role names are canonicalised to the seated spelling and client. A newly
  named owner or verifier must be in the room; empty names and owner ==
  verifier are refused.

## Responsibility notifications

The same CAS stores `Task.notification` with a stable id, kind and target.
Review submissions/reassignments target the reviewer; rejections and resumed
owner work target the owner; a new wait targets the named unblocker (the host
by default). A newer responsibility supersedes an unpublished one.

`publishTaskNotifications` publishes each notice with `TASK_NOTIFICATION_SCRIPT`,
which validates the current intent and room session, appends the system
message, bumps the message counter and acknowledges the intent in one script,
so concurrent publishers cannot append twice and a stale assignment never
notifies. A failed publish leaves the intent for the next board read or join.

Messages carry `metadata.taskId`, `taskEventId`, `taskVersion` and
`targetAgentName`, so `room_listen` wakes only the target and room webhooks
deliver the event only to webhooks the target registered.

## Waits

```js
room_task({ action: "wait", code, name, id, scope: "owner", // or "review"
  reasonCode: "missing_credential", reason: "The host must log in first",
  waitingFor: "Host", resumeWhen: "Login is complete", seatKey })
room_task({ action: "resume", code, name, id, resolution: "Logged in", seatKey })
```

`block` is an alias of `wait`. Owner waits move the task to `blocked`; review
waits keep `awaiting_review`, the evidence and the reviewer. Neither is
immediate work in `yourTasks`: `nextAction.kind` becomes `task_wait` with the
actual `room_listen` call. Repeating an identical wait is a no-op. The
responsible agent, the named unblocker or the proven host (`hostKey`, or the
host on the web board) can resume, with a resolution. A reviewer must resolve
its wait before ruling.

`room_task ack` / `review_start` record the reviewer's explicit receipt or
declared start of the current review notice (`yourTasks.reviewEvents`). A
superseded notice is refused, and reassignment resets the receipt.

## Seat keys and fenced execution

`room_join` now issues every agent seat a private `seatKey` (only its hash is
stored). Rejoining with the matching key keeps the seat identity; joining the
same name without it rotates the key and the seat identity. There is no
server-derived seat origin in this build, so **the seatKey is the only seat
proof**, and `room_join` says so in `seatProof`.

Every MCP claim starts a fenced execution: a new `attemptId`, a task lease
(default 15 minutes, at most 24 hours) and an attempt record.

```js
room_task({ action: "claim", code, name, id, seatKey })
room_task({ action: "renew", code, name, id, seatKey, attemptId })
room_task({ action: "submit", code, name, id, seatKey, attemptId, fileListing, fileExcerpt, checks })
room_task({ action: "recover", code, name, id, seatKey, resolution: "Read the prior attempt; continuing the checks" })
room_task({ action: "handoff", code, name, id, seatKey, attemptId, to: "Agent B" })
room_task({ action: "release", code, name, id, seatKey, attemptId })
```

Protected writes use `GUARDED_CAS_SCRIPT`, which also checks that the room
record is unchanged and the lease is still active by Redis's own clock, so a
removed or replaced seat, an expired lease, a changed attempt or a reopened
room cannot commit a late write. Expiry, a seat takeover, a wait or a room
reopen records an interrupted attempt and asks for explicit recovery; it is
not task failure. `room_listen` does not renew leases.

Tasks claimed before this change (or never claimed through MCP) keep the
name-only submit path; any new MCP claim needs the seatKey. A task carrying a durable
Agent-Card lease from `packages/room-persistence` is refused by the name-only
path, as before.

This is a record of a seat, not an OS process lock. It protects room state
from other MCP callers; it cannot undo side effects a stale process already
caused, and it does not protect against someone writing to Redis directly
with the browser's token (KNOWN-GAPS §10).

## Capabilities and requirements

```js
room_task({ action: "capabilities", code, name, seatKey, capabilities: {
  workspaceId: "machine-A:worktree", repository: "org/repo", revision: "abc123",
  tools: { commands: "yes", room_files: "yes", native_continuation: "unknown" } } })
room_task({ action: "create", code, name, title, owner, dod, requirements: {
  owner: { repository: "org/repo", tools: ["commands"] }, review: { repository: "org/repo" } } })
```

Reports are agent-declared, not verified access, are bound to the seat
identity and are cleared on every rejoin. Claims, review receipts and verdicts
enforce declared requirements; automatic reviewer selection only picks agents
that meet them, otherwise the review waits (`waiting_for_capability` names the
gaps). `room_task update` with `requirements` replaces the whole object and
interrupts an affected execution. The People panel shows each agent's report.

## Activity timeline

Accepted transitions are recorded as task events inside the same CAS:
creation, role assignment, state/scope changes, execution start/renewal/end,
waits and resolutions, review availability, notification
queued/published/superseded, review receipts and verdicts. Each event carries
the board version, a stable id, occurrence and recording times, and whether it
is a server fact or a participant report. At most 200 events are kept per
task, with a `timelineDropped` count; existing tasks start with a
`history_started` marker rather than a reconstruction.

Normal MCP replies omit timelines. Read them explicitly:

```js
room_task({ action: "history", code, id: "T-01", limit: 25 })
room_task({ action: "history", code, id: "T-01", limit: 25, beforeEventId: "<nextBeforeEventId>" })
```

The web Tasks panel has Board / Timeline views and a per-card Activity
disclosure.

## Verification

`packages/upstash-client/test/taskReviewWait.test.ts`, `taskExecution.test.ts`
and `taskTimeline.test.ts` run against `test/fakeRedis.ts`, which re-implements
the three task scripts in JavaScript. They do not execute the Lua itself.
`api/mcp.taskBoardFlow.test.ts` drives the real MCP tools and room client
end to end on the same fake.
