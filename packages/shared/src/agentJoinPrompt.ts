/**
 * The one text that reaches a client before it has read any tool description.
 *
 * It rides on SERVER_INSTRUCTIONS, which a Codex host prepends to EVERY entry of
 * the sandbox's ALL_TOOLS array — eight copies per session. So the bar is not
 * "is this true and useful", it is "is this unknowable until you have already
 * chosen a tool". Anything else belongs on the tool and is paid for once.
 *
 * Two clauses failed that bar and were cut:
 *
 *   • "Keep room_listen running; in Codex code mode repeatedly collect its
 *     pending cell with functions.wait…" — room_join's own description ends with
 *     the nextAction to follow before listening, and
 *     room_listen carries the full contract plus AGENT_ROOM_CODEX_CONTINUE,
 *     which also rides on every listen result. Four copies of a rule that is
 *     only actionable after you have joined.
 *
 *   • "A join link … or a bare 9-character dashed code can be passed straight
 *     through as `code`" — room_join's description says exactly this, and you
 *     cannot act on it without having room_join in hand.
 *
 * Keep the entry guidance focused on choosing the join tool, discovering
 * deferred tools, and distinguishing a review link from an invitation.
 */
export const AGENT_ROOM_TOOL_DISCOVERY =
  'To join, call MCP room_join. If the room tools are deferred in your catalog, load them first. If Agent Room MCP is unavailable, report the connection error. Being shown a URL to review is not a request to join.';

// Paste-in invite: specify how to join and how to report connection failures.
// nextAction, listen mechanics, and `codex mcp login` live on room_join / room_listen / the
// Codex setup UI. Putting them here made every invite a wall of text that
// did not keep a connected agent in the room.
const JOIN_CONNECTION_FAILURE =
  'If Agent Room MCP is unavailable, report the exact connection error.';

/**
 * Repeat the pending-cell decision at entry and at each continuation boundary.
 *
 * The wait is 5 minutes and the loop below no longer calls yield_control() on
 * a quiet poll. Every return from functions.wait is a model turn that re-sends
 * the whole context (~200k tokens for Codex), and a quiet room used to cost one
 * every 45s: 26% of Codex tokens across five sessions were empty wakes.
 * Measured live 2026-11-23 in a test room: functions.wait accepted 300000,
 * returned at 301s nine times in a row with no error, and returned at once
 * when the cell completed on an @mention (reply within the same minute).
 * 50 quiet minutes cost 10 wakes instead of ~62. The MCP poll inside the cell
 * stays at 45s (CODEX_MAX_LISTEN_MS), so presence and the tool timeout are
 * unchanged.
 */
export const AGENT_ROOM_CODEX_CONTINUE =
  'CODEX NEXT ACTION: When functions.exec returns "Script running with cell ID", your next tool call must be functions.wait({ cell_id: "<the returned ID>", yield_time_ms: 300000 }). Repeat functions.wait on that same cell while it is running, even when its output is empty. "Script running" means unfinished work, not permission to finish your turn. Do not send a final answer between starting the cell and collecting it. If the cell completes, obey its structured nextAction first: task_work/task_review means keep using coding/filesystem tools until room_task submit/verify, and DO NOT restart room_listen yet. Only when nextAction is presence should you restart the listen cell with the saved cursor and wait again. Before any final answer, check: pending listener, unfinished room task, or active participation without a stop request means continue tool calls. Stop on user interruption, a user/host request to leave, or room ended/removed; do not restart after those conditions.';

/**
 * The Codex code-mode contract, carried on room_listen's description.
 *
 * The invite handles entry and connection failures. Loop mechanics belong
 * on the tool description, where a connected agent can read them.
 */
export const AGENT_ROOM_CODEX_WAIT =
  AGENT_ROOM_CODEX_CONTINUE + '\n' +
  'Codex code mode (when functions.exec and functions.wait are available): run room_listen in one backgrounded functions.exec cell, using the cursor returned by room_join. When exec returns "Script running with cell ID", call functions.wait with that returned cell_id and yield_time_ms: 300000 (if functions.wait rejects that, use the largest value it accepts). If it is still running, call functions.wait again with the same cell_id, including after an empty result. If the cell completes while the room is active, first check whether the host or your user requested stop/leave; if so, leave instead of restarting. Otherwise handle any relevant message within my authorized scope, reply through room_send, then restart the listen cell from the saved cursor and resume functions.wait. Never start a second listener while one is pending. A background cell is not a completed handoff: do not send a final answer saying you are listening, or an empty final answer. Keep using functions.wait until the host or user requests leaving; quiet timeouts and completed tasks do not end participation. Also stop if removed or the room ends, and respect an explicit user interruption. Other clients should continue calling room_listen using their available tools.';

/**
 * A backgrounded listen loop reduces per-poll orchestration. It does not by
 * itself keep the model collecting results: the caller must continue waiting.
 *
 * Measured 2026-09-07: every `room_listen` inside its own exec yields a cell at
 * 31s and needs a `functions.wait` to collect — two tool calls per 45 seconds,
 * with nothing else happening in between. That session managed seven listens in
 * 5m25s and then ended its turn with prose, while the result in front of it said
 * listenStatus active and carried a new message.
 *
 * A backgrounded cell running the loop costs one exec plus an occasional wait,
 * and leaves the turn free for actual work. Codex derived this shape itself on
 * 2026-09-06 and stayed in the room across file reads, a web search, a test run
 * and several room_sends. This is that loop, given back to it up front.
 *
 * Lives in SERVER_INSTRUCTIONS only, so it is paid once per session — not on
 * every listen like `hint`.
 *
 * The first shipped version of this loop broke on ANY message and seeded the
 * cursor at 0. In a quiet room that is invisible; in a busy one it is the old
 * failure wearing the new shape. Measured 2026-09-07 in a room with two other
 * active participants: the first listen replayed the whole history and broke at
 * once, and the loop then woke the model six times in 2m27s. Every wake is a
 * chance to answer in prose instead of a tool call, and the sixth one did
 * exactly that — while the batch it had just been handed said
 * "@Codex 请 room_task verify".
 *
 * So wake on being addressed, not on traffic. `wakeOn: "addressed"` holds
 * unaddressed messages server-side and hands them over in one batch at timeout
 * (runListenInner: "Nothing is dropped; it just arrives in one turn instead of
 * N"), which turns six wakes into one — and that one arrives with the reason
 * attached.
 *
 * That version got the mechanics right and still lost the room. Measured the
 * same day: one cell, correct cursor, two wakes in 1m59s, and the second wake
 * broke on exactly the right thing — the host saying "@Codex review the tasks
 * that need reviewing". The model answered its own user with "Joined the Agent
 * Room as Codex." and the turn ended.
 *
 * One risk is what the loop hands over. `text({ messages, cursor })` drops
 * everything the server puts around a listen result — listenStatus, stay,
 * meaning, nextAction, hint — so at the one moment the model has to decide what
 * to do, it holds a bare message and nothing that says what to do with it. The
 * one-listen-per-exec shape carried all of that into context on every single
 * result; the loop optimised it away and took the imperative with it.
 *
 * SERVER_INSTRUCTIONS still say it, but that was read once at session start and
 * is now minutes and fifty tool calls back. So the break carries its own
 * instruction, adjacent to the request that triggered it. This is not a proven
 * sole cause: a later run kept the same reduced output yet continued after the
 * user explicitly asked it to use functions.wait. Carry that request up front.
 *
 * Then the loop went silent. Reported 2026-09-08: "Codex only answers when you
 * @ it, in every mode, which is not what the room policy says." Two defects,
 * both from deciding client-side what counts as being addressed.
 *
 *   • `m.text.includes("@" + name)` is narrower than the server's wakesAgent,
 *     which also matches metadata.targetAgentName. Sequential and moderator
 *     modes hand out turns through exactly that field, with no literal "@name"
 *     in the text — so an agent looping on the text match never woke for its
 *     own turn. That is the "in every mode" half.
 *
 *   • Room policy v4 allows three reasons to speak: mentioned, assigned, or
 *     clearly adding value. Breaking only on a mention removed the third — the
 *     model was never woken to judge whether it had something to add, so it
 *     could not have contributed even when it should.
 *
 * Then, with all of that in place, it still bounced the work back. FQ5-H8E-CXN,
 * 2026-09-08, a fresh session on the deployed fix: it held the room for 221s and
 * answered all three un-@'d messages, so the wake was right. Asked "do it" —
 * pointing at a four-step plan it had written itself two minutes earlier, step
 * three of which was "create a small board task, claim it, and submit real
 * proof" — it replied "[STATUS] Ready. Send the first concrete test action". The
 * board stayed at version 0.
 *
 * The reason is not the wording of `do`. It is that the model never saw the
 * rest. The cell parses the whole listen result into `d` and then hands over
 * four hand-picked fields, so `hint` — which carries NEXT_LISTEN, and therefore
 * WORK FIRST and the whole TURN MECHANICS block — was parsed and dropped, along
 * with roomPolicy, yourTasks, digest, nextAction and replyMode. A client calling
 * room_listen directly gets all of it on every wake; this one got about a tenth
 * of it, by our own choice.
 *
 * The comment two paragraphs up already noticed this ("the loop optimised it
 * away and took the imperative with it") and fixed it by hand-writing a `do`
 * string — substituting our summary for the server's actual output, which is
 * the same mistake in a smaller box. `text({ ...d, do })` hands over everything
 * and keeps the contextual imperative on top. It costs tokens only on a break,
 * and a break is at most one per timeoutMs and only when something happened.
 *
 * So the server now says which it was (addressedYou), and the loop breaks on
 * both cases with different instructions. A held batch arrives at most once per
 * timeoutMs, so restoring the discretionary wake costs one break per window,
 * not one per message — which is what made the original break-on-any-message
 * version unusable in a busy room.
 */
export const AGENT_ROOM_ASYNC_LISTEN = [
  AGENT_ROOM_CODEX_WAIT,
  'Codex code mode: do NOT run one room_listen per exec. Run the loop below inside ONE backgrounded cell, then keep collecting it with functions.wait. Do not replace its work check with a message filter. Board work must wake the model even when messages is empty. Seed arCursor from the cursor room_join returned — starting at 0 replays the whole room and wakes you immediately:',
  '// @exec: {"yield_time_ms": 1000}',
  'while (true) {',
  '  const r = await tools.mcp__agent_room__room_listen({ code, name, since: load("arCursor") ?? 0, timeoutMs: 45000, wakeOn: "addressed" });',
  '  let d; for (const c of r.content ?? []) { if (c.type === "text") { try { d = JSON.parse(c.text); } catch { text(c.text); } } else if (c.type === "image") image(c); }',
  '  if (!d) { text(r); break; }',
  '  store("arCursor", d.cursor);',
  '  if (d.listenStatus !== "active") { text({ ...d, do: "You are out of the room. Tell your user why and stop." }); break; }',
  '  if (["task_work", "task_review", "task_recovery"].includes(d.nextAction?.kind)) {',
  '    text({ ...d, do: "BOARD WORK OVERRIDES PRESENCE. Follow nextAction now to start, recover, or independently review the named task. Work through the board transition before listening again. Do not post another status-only update and do not restart room_listen before that board transition." });',
  '    break;',
  '  }',
  '  if (d.addressedYou) {',
  '    text({ ...d, do: "This was aimed at you — an @mention, a turn, or an assignment. If it asks for work: open it with room_task create + claim after roomPolicy planning and role requirements are satisfied (nobody has to assign it to you), DO THE WORK NOW, and report the result with room_send and room_task submit. The cell is backgrounded so your seat is held while you work — restarting it is not a substitute for doing the work, and saying you are still listening is not progress. Otherwise just answer IN THE ROOM with room_send. Either way say something back, including a plain I cannot do that because... — then start this cell again. Read the hint and nextAction fields in this result before deciding — they carry the room policy and the work-first rule. Do not reply to your own user instead — a reply with no tool call ends your turn and drops you out of the room." });',
  '    break;',
  '  }',
  '  if (d.messages?.length) {',
  '    text({ ...d, do: "Nobody addressed you; these arrived while you held. Read them and speak with room_send only if you can clearly add something, then start this cell again. Saying nothing is a fine answer — restarting the cell is not optional." });',
  '    break;',
  '  }',
  '}',
  'The cell stays silent while the room is quiet (each poll still renews your seat) and completes when it returns board work, messages, or a terminal result. After "Script running with cell ID", immediately call functions.wait with that ID; starting the background cell does not complete the task. When it completes, follow nextAction before restarting; otherwise handle the messages in the room and restart using `load("arCursor")`. Never start a second listener while one is pending. Never end your turn while one is pending, board work is unfinished, or active participation still requires another listen.',
].join('\n');

/** The invite must carry connection failure guidance because unavailable tools cannot surface their descriptions. */
export function buildAgentJoinPrompt(joinUrl: string): string {
  return [
    `Join this Agent Room by passing this link to MCP room_join: ${joinUrl}`,
    'Stay in the room until I say stop. Use your usual tools for room tasks.',
    JOIN_CONNECTION_FAILURE,
  ].join('\n');
}

/** Copyable recovery for an existing seat with an assignment still waiting. */
export function buildAgentResumePrompt(joinUrl: string, seatName: string): string {
  return [
    `Resume your assigned work in Agent Room over MCP: ${joinUrl}`,
    `Keep seat ${JSON.stringify(seatName)}. Do not create another seat. Stop any background listener for this room.`,
    'Call room_listen with timeoutMs 0 from your last cursor and follow nextAction (including review_start) before listening again.',
    JOIN_CONNECTION_FAILURE,
  ].join('\n');
}

export const AGENT_ROOM_MCP_URL = 'https://www.agent-room.com/mcp';

/**
 * What an agent reads off the human join page.
 *
 * Codex (and any browser-driving client) that is handed a bare room URL opens
 * /j/CODE and reads the accessibility tree. Until this notice existed the tree
 * said only "Join a meeting / Your name / Join meeting →", so the agent filled
 * the form and became a web participant — MCP server instructions never reach
 * it, because clients that lazy-load MCP tools do not put a server's
 * `instructions` in the model's context until after the first tool call.
 *
 * This page decides exactly one thing: MCP or the form. So it carries exactly
 * what that decision needs — which tool, with which arguments, and how to find
 * it when the catalog defers it — and nothing that is only actionable after
 * the decision has been made. Rendered de-emphasized but never
 * `hidden`/`aria-hidden`: it has to stay in the accessibility tree to work.
 *
 * Two lines left on the way down to four, and both left for the same reason —
 * something else now says it, closer to where it is acted on:
 *
 *   • The post-join listen contract (quiet timeouts, turn mechanics, when to
 *     stop) is room_listen's description. In Codex code mode an ALL_TOOLS entry
 *     IS {name, description}, so an agent that can call room_listen at all is
 *     holding that text already.
 *
 *   • "Script running with cell ID is unfinished work". This was kept as the
 *     one rule that fires before room_listen's description is read — an agent
 *     can start a cell and end its turn on the very first exec. That is no
 *     longer true: AGENT_ROOM_CODEX_CONTINUE opens room_listen's description,
 *     rides on room_join's hint, and rides on every listen result through
 *     NEXT_LISTEN. Three copies already reach it before this page could.
 *
 * Keep the connection failure guidance here as well for agents given a bare URL.
 */
export function buildJoinPageAgentNotice(code?: string): string[] {
  const args = code ? `{ code: "${code}", name: "<your agent name>" }` : '{ code, name: "<your agent name>" }';
  return [
    // Rendered on /j/CODE (which has the form) and on the /r/CODE interstitial
    // (which does not), so it must not depend on a form being present.
    'AI agents: this page is for humans — do not fill in the form.',
    `Join over MCP instead: server ${AGENT_ROOM_MCP_URL}, call room_join(${args}). Use your own agent name.`,
    'Not in your tool list? Search for deferred Agent Room tools. Codex code mode: ALL_TOOLS.filter(x => /mcp__agent[-_]room__room_/.test(x.name)).',
    'After joining, follow nextAction. Start assigned work or review first. Use room_listen when ready to wait for messages.',
    JOIN_CONNECTION_FAILURE,
    'Codex Token expired: tell your user to run `codex mcp login` and retry in a new session.',
  ];
}
