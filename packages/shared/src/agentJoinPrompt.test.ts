// A client that lazy-loads MCP tools (Codex desktop, verified 2026-09-07) never
// puts a server's `instructions` in the model's context — the text first appears
// in a tool RESULT, i.e. after the agent has already chosen how to join. So the
// only instructions that can steer that choice are the ones carried by the
// invite the user pastes, or printed on the page the agent lands on.
//
// Both entry points must tell an agent what to do even when its MCP tools
// never loaded and it cannot read their descriptions.

import { describe, it, expect } from 'vitest';
import {
  AGENT_ROOM_TOOL_DISCOVERY,
  buildAgentJoinPrompt,
  buildAgentResumePrompt,
  buildJoinPageAgentNotice,
  AGENT_ROOM_MCP_URL,
  AGENT_ROOM_ASYNC_LISTEN,
  AGENT_ROOM_CODEX_WAIT,
  AGENT_ROOM_CODEX_CONTINUE,
} from './agentJoinPrompt.js';

const CODE = 'ABC-DEF-GHJ';

describe('buildJoinPageAgentNotice', () => {
  const text = (code?: string) => buildJoinPageAgentNotice(code).join('\n');

  it('tells the agent not to use the page it is looking at', () => {
    const t = text(CODE);
    // Shown on /r/CODE too, where there is no form — so the line cannot
    // presuppose one being filled in, only that it must not be.
    expect(t).toContain('this page is for humans');
    expect(t).toContain('do not fill in the form');
    expect(t).toContain('report the exact connection error');
    expect(t).not.toMatch(/\b(browser|shell|HTTP)\b/);
  });

  it('carries a callable room_join, not a description of one', () => {
    const t = text(CODE);
    expect(t).toContain(AGENT_ROOM_MCP_URL);
    expect(t).toContain(`room_join({ code: "${CODE}", name: "<your agent name>" })`);
    // The observed failure was Codex stopping to ask for a display name.
    expect(t).toContain('Use your own agent name');
  });

  it('asks the agent to discover deferred tools before declaring a failure', () => {
    const t = text(CODE);
    expect(t).toContain('deferred Agent Room tools');
    expect(t).toContain('ALL_TOOLS');
  });

  // This page decides one thing: MCP or the form. Everything only actionable
  // after that decision belongs where it is acted on — and a wall of text is
  // not free, because it buries the four lines that do the deciding.
  it('points at room_listen rather than restating its contract', () => {
    const t = text(CODE);
    expect(t).toContain('Start assigned work or review first');
    expect(t).toContain('Use room_listen when ready to wait for messages');
    for (const moved of [
      'quiet timeout is not a stop condition',
      'reply with no tool call ends your turn',
      'Script running with cell ID',
      'functions.wait',
    ]) {
      expect(t, `${moved} belongs on room_listen`).not.toContain(moved);
    }
    expect(t).toContain('codex mcp login');
  });

  it('still names the tool when the code is not known yet', () => {
    const t = text();
    expect(t).toContain('room_join({ code, name: "<your agent name>" })');
    expect(t).not.toContain('undefined');
  });
});

describe('AGENT_ROOM_ASYNC_LISTEN', () => {
  // One listen per exec is two tool calls per 45s and it ends the turn in
  // minutes. The loop has to arrive as runnable code, not as advice.
  it('hands Codex a runnable backgrounded listen loop', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain(AGENT_ROOM_CODEX_WAIT);
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('// @exec: {"yield_time_ms": 1000}');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('while (true) {');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('tools.mcp__agent_room__room_listen(');
  });

  // Every return from functions.wait is a model turn that re-sends the whole
  // context. Yielding on each quiet 45s poll woke Codex ~80 times an hour in
  // an empty room. Measured 2026-11-23: a 5-minute wait works and still
  // returns the moment the cell completes.
  it('stays in the cell on a quiet poll and waits 5 minutes', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).not.toContain('yield_control');
    expect(AGENT_ROOM_CODEX_CONTINUE).toContain('yield_time_ms: 300000 })');
    expect(AGENT_ROOM_CODEX_WAIT).toContain('yield_time_ms: 300000 (if functions.wait rejects that, use the largest value it accepts)');
    expect(AGENT_ROOM_CODEX_WAIT).not.toContain('45000');
    // The MCP poll itself stays inside Codex's 60s tool timeout.
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('timeoutMs: 45000');
  });

  it('keeps polling through quiet windows and breaks on the first message', async () => {
    const lines = AGENT_ROOM_ASYNC_LISTEN.split('\n');
    const start = lines.findIndex(line => line === 'while (true) {');
    const end = lines.indexOf('}', start);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction('tools', 'code', 'name', 'load', 'store', 'text', 'yield_control', lines.slice(start, end + 1).join('\n'));
    let polls = 0;
    let cursor = 10;
    const sinces: unknown[] = [];
    const output: unknown[] = [];
    await run({ mcp__agent_room__room_listen: async (args: { since: unknown }) => {
      sinces.push(args.since);
      polls++;
      const messages = polls < 7 ? [] : [{ name: 'host', text: '@Codex ping' }];
      return { content: [{ type: 'text', text: JSON.stringify({ listenStatus: 'active', cursor: ++cursor, messages, addressedYou: polls >= 7 }) }] };
    } },
      CODE, 'Codex', () => cursor, (_k: string, v: number) => { cursor = v; }, (value: unknown) => output.push(value),
      () => { throw new Error('a quiet poll handed the turn back to the model'); });
    expect(polls).toBe(7);
    expect(sinces).toEqual([10, 11, 12, 13, 14, 15, 16]);
    expect(output).toEqual([expect.objectContaining({ addressedYou: true, cursor: 17 })]);
  });

  it('carries the cursor across cells so a restart resumes', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('store("arCursor", d.cursor)');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('load("arCursor")');
  });

  // Breaking on any message is the same failure in a new shape: in a room with
  // other active participants it woke the model six times in 2m27s, and the
  // sixth wake answered in prose and ended the turn. Wake on being addressed;
  // the server holds the rest and hands them over in one batch.
  it('wakes on being addressed, not on room traffic', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('wakeOn: "addressed"');
    expect(AGENT_ROOM_ASYNC_LISTEN).not.toContain('|| d.messages?.length) break');
  });

  // A client-side text match is narrower than the server's wakesAgent, which
  // also matches metadata.targetAgentName — the field sequential and moderator
  // modes use to hand out turns, with no literal "@name" in the text. Deciding
  // this client-side meant an agent never woke for its own turn.
  it('takes "addressed" from the server, not from a text match', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('if (d.addressedYou)');
    expect(AGENT_ROOM_ASYNC_LISTEN).not.toContain('includes("@" + name)');
  });

  // Room policy v4 allows three reasons to speak: mentioned, assigned, or
  // clearly adding value. Breaking only on a mention removed the third.
  it('also wakes for the batch that arrived unaddressed, so it can still add value', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('Nobody addressed you');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('only if you can clearly add something');
    // Bounded: with wakeOn "addressed" a held batch arrives once per timeoutMs,
    // not once per message, which is what made break-on-any-message unusable.
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('Saying nothing is a fine answer');
  });

  it('still breaks when the room ends or removes the agent', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('if (d.listenStatus !== "active")');
  });

  // since: 0 replays the whole room and breaks the loop on the first poll.
  it('says to seed the cursor from room_join', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('Seed arCursor from the cursor room_join returned');
  });

  it('says what to do with the batch it wakes on', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('Do not post another status-only update');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('do not restart room_listen before that board transition');
  });

  it.each(['task_review', 'task_work', 'task_recovery'])(
    'returns %s to Codex even when there are no host messages',
    async (kind) => {
      const lines = AGENT_ROOM_ASYNC_LISTEN.split('\n');
      const start = lines.findIndex(line => line === 'while (true) {');
      const end = lines.indexOf('}', start);
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const run = new AsyncFunction('tools', 'code', 'name', 'load', 'store', 'text', 'yield_control', lines.slice(start, end + 1).join('\n'));
      const directive = { kind, taskId: 'T-08' };
      const payload = { listenStatus: 'active', cursor: 171, messages: [], nextAction: directive };
      const output: unknown[] = [];

      await run({ mcp__agent_room__room_listen: async () => ({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ...payload, error: 'board_action_required' }) }],
      }) },
        CODE, 'Codex', () => 171, () => {}, (value: unknown) => output.push(value),
        () => { throw new Error('Pending board work was lost inside the listen loop'); });

      expect(output).toEqual([expect.objectContaining({ nextAction: directive })]);
    },
  );

  // The prose above is read once at session start. By the time the loop breaks
  // it is minutes and dozens of tool calls back, and the break itself used to
  // hand over a bare `{ messages, cursor }` — the request, with nothing saying
  // what to do about it. The model answered its own user and the turn ended.
  it('carries the imperative in the break, next to the request that caused it', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('answer IN THE ROOM with room_send');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('Do not reply to your own user instead');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('a reply with no tool call ends your turn');
    // Both breaks must say to restart the cell, or the agent leaves by finishing.
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('restarting the cell is not optional');
  });

  // T-01 created, claimed, announced — and then nothing, because the imperative
  // next to the request said "answer, then start this cell again" and never
  // "do the work". Backgrounding the cell exists to free the turn for work;
  // the break has to say so, or listening becomes the whole job.
  it('sends the agent to do the work, not back to the poll', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('DO THE WORK NOW');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('room_task create + claim');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('nobody has to assign it to you');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('restarting it is not a substitute for doing the work');
    // Silence was the reply to the one request it could not do.
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('I cannot do that because');
  });

  // The loop parsed the whole listen result and handed over four hand-picked
  // fields, so `hint` — carrying NEXT_LISTEN, and therefore WORK FIRST — was
  // read and thrown away on every wake. A client calling room_listen directly
  // gets all of it. Ours got about a tenth, and then we wondered why the
  // work-first rule had no effect.
  it('hands over the whole listen result, not a chosen subset', () => {
    // Every break spreads it; none reconstructs a subset by hand.
    expect(AGENT_ROOM_ASYNC_LISTEN.split('text({ ...d,')).toHaveLength(5);
    expect(AGENT_ROOM_ASYNC_LISTEN).not.toContain('text({ messages: d.messages');
    expect(AGENT_ROOM_ASYNC_LISTEN).not.toContain('text({ listenStatus: d.listenStatus,');
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('Read the hint and nextAction fields');
  });

  it('tells the agent what a terminal listenStatus means for it', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('You are out of the room. Tell your user why and stop.');
  });

  it('names the anti-pattern it is replacing', () => {
    expect(AGENT_ROOM_ASYNC_LISTEN).toContain('do NOT run one room_listen per exec');
  });
});

describe('AGENT_ROOM_TOOL_DISCOVERY', () => {
  // It rides on SERVER_INSTRUCTIONS, which a Codex host copies onto every entry
  // of the sandbox's ALL_TOOLS array. So the bar is not "true and useful", it is
  // "unknowable until you have already chosen a tool" — everything else belongs
  // on the tool, where it is paid for once instead of eight times.
  it('carries only what is decidable with no tool description in hand', () => {
    expect(AGENT_ROOM_TOOL_DISCOVERY).toContain('To join, call MCP room_join.');
    expect(AGENT_ROOM_TOOL_DISCOVERY).not.toMatch(/\b(browser|shell|HTTP)\b/);
    expect(AGENT_ROOM_TOOL_DISCOVERY).toContain('deferred in your catalog');
    expect(AGENT_ROOM_TOOL_DISCOVERY).toContain('not a request to join');
  });

  // room_join's own description ends with "Then start the room_listen loop and
  // keep it running", STAYING IN repeats it in the same string, room_listen
  // carries the full contract, and AGENT_ROOM_CODEX_CONTINUE rides on every
  // listen result. None of it is actionable before you have joined.
  it('leaves the listen contract to room_join and room_listen', () => {
    expect(AGENT_ROOM_TOOL_DISCOVERY).not.toContain('functions.wait');
    expect(AGENT_ROOM_TOOL_DISCOVERY).not.toContain('Keep room_listen running');
  });

  // You cannot act on "the URL can be passed straight through as code" without
  // having room_join in hand, and its description already says so.
  it('does not restate the argument handling room_join documents itself', () => {
    expect(AGENT_ROOM_TOOL_DISCOVERY).not.toContain('passed straight through');
    expect(AGENT_ROOM_TOOL_DISCOVERY).not.toContain('9-character');
  });

  it('stays short enough to survive the ALL_TOOLS multiplier', () => {
    expect(AGENT_ROOM_TOOL_DISCOVERY.length).toBeLessThan(300);
  });
});

describe('buildAgentJoinPrompt', () => {
  const invite = () => buildAgentJoinPrompt(`https://www.agent-room.com/j/${CODE}`);

  // Every clause has to be one a tool description cannot supply. Anything else
  // is duplication, and this text is pasted into a chat — it is paid for in the
  // agent's context on every use, unlike a description that is read once.
  it('selects MCP for joining and leaves tools available for room tasks', () => {
    const t = invite();
    expect(t).toContain(`passing this link to MCP room_join: https://www.agent-room.com/j/${CODE}`);
    expect(t).toContain('Use your usual tools for room tasks.');
    expect(t).not.toMatch(/\b(browser|shell|HTTP)\b/);
  });

  it('carries the user\'s own authorisation to stay', () => {
    // Only the person who asked for the join can say how long it lasts. A tool
    // description can state that a quiet hold is not an exit; it cannot state
    // that THIS user wants the agent to stay.
    expect(invite()).toContain('Stay in the room until I say stop.');
  });

  it('restates nothing that ships with the tools', () => {
    const t = invite();
    // TOOL DISCOVERY covers the deferred case and rides on every ALL_TOOLS
    // entry, so it arrives the moment the agent looks up the room_join named
    // above. The listen mechanics are on room_listen.
    expect(t).not.toContain('deferred');
    expect(t).not.toContain('room_listen');
    expect(t).not.toContain('not exits');
    expect(t).not.toContain('tool failures');
    expect(t).not.toContain(AGENT_ROOM_CODEX_WAIT);
    expect(t).not.toContain('functions.wait');
    expect(t).not.toContain('ALL_TOOLS');
  });

  it('asks the agent to report the exact connection error', () => {
    const t = invite();
    expect(t).toContain('If Agent Room MCP is unavailable, report the exact connection error.');
  });

  it('leaves nextAction, listen, and Codex login off the paste', () => {
    const t = invite();
    expect(t).not.toContain('nextAction');
    expect(t).not.toContain('codex mcp login');
    expect(t.length).toBeLessThan(400);
  });
});

describe('buildAgentResumePrompt', () => {
  it('keeps the seat and points at nextAction without the login lecture', () => {
    const t = buildAgentResumePrompt(`https://www.agent-room.com/j/${CODE}`, 'Codex');
    expect(t).toContain('Keep seat "Codex"');
    expect(t).toContain('nextAction');
    expect(t).toContain('report the exact connection error');
    expect(t).not.toMatch(/\b(browser|shell|HTTP)\b/);
    expect(t).not.toContain('codex mcp login');
  });
});

describe('AGENT_ROOM_CODEX_WAIT', () => {
  it('honors host exit requests before restarting, without ignoring the user or terminal states', () => {
    expect(AGENT_ROOM_CODEX_WAIT).toContain('first check whether the host or your user requested stop/leave');
    expect(AGENT_ROOM_CODEX_WAIT).toContain('leave instead of restarting');
    expect(AGENT_ROOM_CODEX_WAIT).toContain('or an empty final answer');
    expect(AGENT_ROOM_CODEX_WAIT).toContain('quiet timeouts and completed tasks do not end participation');
    expect(AGENT_ROOM_CODEX_WAIT).toContain('Also stop if removed or the room ends');
    expect(AGENT_ROOM_CODEX_WAIT).toContain('respect an explicit user interruption');
    // The join page used to echo the stop conditions. It no longer does, and
    // asserting it again here would pull the paragraph back onto a page whose
    // only job is choosing MCP over the form. The conditions live in this
    // constant and on room_listen's description, which is where they are acted
    // on — see 'points at room_listen rather than restating its contract'.
  });

  it('distinguishes pending, empty, and completed cells', () => {
    expect(AGENT_ROOM_CODEX_WAIT).toContain('When exec returns "Script running with cell ID"');
    expect(AGENT_ROOM_CODEX_WAIT).toContain('call functions.wait again with the same cell_id');
    expect(AGENT_ROOM_CODEX_WAIT).toContain('including after an empty result');
    expect(AGENT_ROOM_CODEX_WAIT).toContain('If the cell completes while the room is active');
    expect(AGENT_ROOM_CODEX_WAIT).toContain('restart the listen cell from the saved cursor');
  });

  it('does not confuse background work with a completed handoff or expand authority', () => {
    expect(AGENT_ROOM_CODEX_WAIT).toContain('Never start a second listener while one is pending');
    expect(AGENT_ROOM_CODEX_WAIT).toContain('do not send a final answer saying you are listening');
    expect(AGENT_ROOM_CODEX_WAIT).toContain('within my authorized scope');
    expect(AGENT_ROOM_CODEX_WAIT).toContain('when functions.exec and functions.wait are available');
    expect(AGENT_ROOM_CODEX_WAIT).toContain('Other clients should continue calling room_listen');
  });
});
