import { describe, expect, it } from 'vitest';
import { insertMentionText, mentionCandidates, mentionQueryAt, mentionRoleLabel, mentionTokenSource } from './mentions.js';

// The room from the report: Robin (host) could not @ the member "x t d".
const ROOM = [
  { name: 'Claude', client: 'cc', role: 'Moderator' },
  { name: 'Grok', client: 'cc', role: '' },
  { name: 'Codex', client: 'cc', role: '' },
  { name: 'Robin', client: 'web', role: '' },
  { name: 'x t d', client: 'web', role: '' },
];
const NAMES = ROOM.map(p => p.name);

describe('mentionCandidates', () => {
  it('offers every participant except the viewer, agents first', () => {
    expect(mentionCandidates(ROOM, '', 'Robin').map(p => p.name)).toEqual(['Claude', 'Grok', 'Codex', 'x t d']);
  });

  it('offers the host and agents to a member', () => {
    expect(mentionCandidates(ROOM, '', 'x t d').map(p => p.name)).toEqual(['Claude', 'Grok', 'Codex', 'Robin']);
  });

  it('finds a member by any part of a spaced name', () => {
    expect(mentionCandidates(ROOM, 'x', 'Robin').map(p => p.name)).toEqual(['x t d', 'Codex']);
    expect(mentionCandidates(ROOM, 'x t', 'Robin').map(p => p.name)).toEqual(['x t d']);
    expect(mentionCandidates(ROOM, 't d', 'Robin').map(p => p.name)).toEqual(['x t d']);
  });

  it('only hides the viewer’s own web seat, not an agent with the same name', () => {
    const room = [...ROOM, { name: 'Robin', client: 'cc', role: '' }];
    expect(mentionCandidates(room, 'rob', 'Robin').map(p => `${p.name}/${p.client}`)).toEqual(['Robin/cc']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `Agent ${i}`, client: 'cc' }));
    expect(mentionCandidates(many, 'agent', 'Robin')).toHaveLength(8);
  });
});

describe('mentionQueryAt', () => {
  it('opens on a bare @', () => {
    expect(mentionQueryAt('@', 1, NAMES)).toEqual({ start: 0, end: 1, query: '' });
    expect(mentionQueryAt('hi @', 4, NAMES)).toEqual({ start: 3, end: 4, query: '' });
  });

  it('keeps the query open across spaces while it still starts a name', () => {
    expect(mentionQueryAt('@x t', 4, NAMES)).toEqual({ start: 0, end: 4, query: 'x t' });
    expect(mentionQueryAt('ping @X T D', 11, NAMES)).toEqual({ start: 5, end: 11, query: 'x t d' });
  });

  it('closes once the text after @ is a sentence, not a name', () => {
    expect(mentionQueryAt('@Claude please look', 19, NAMES)).toBeNull();
    expect(mentionQueryAt('@x t d ', 7, NAMES)).toBeNull();
  });

  it('ignores email addresses and new lines', () => {
    expect(mentionQueryAt('me@x', 4, NAMES)).toBeNull();
    expect(mentionQueryAt('@x\nt', 4, NAMES)).toBeNull();
  });
});

describe('insertMentionText', () => {
  it('inserts a spaced name whole and puts the caret after it', () => {
    const text = 'hey @x t';
    const lookup = mentionQueryAt(text, text.length, NAMES)!;
    expect(insertMentionText(text, lookup, 'x t d')).toEqual({ text: 'hey @x t d ', caret: 11 });
  });

  it('keeps the text after the caret', () => {
    const text = '@x please check';
    const lookup = mentionQueryAt(text, 2, NAMES)!;
    expect(insertMentionText(text, lookup, 'x t d')).toEqual({ text: '@x t d please check', caret: 7 });
  });
});

describe('mentionRoleLabel', () => {
  it('labels agents, the host and members', () => {
    expect(mentionRoleLabel(ROOM[0]!, 'Robin')).toBe('Moderator');
    expect(mentionRoleLabel(ROOM[1]!, 'Robin')).toBe('Agent');
    expect(mentionRoleLabel(ROOM[3]!, 'Robin')).toBe('Host');
    expect(mentionRoleLabel(ROOM[4]!, 'Robin')).toBe('Member');
  });
});

describe('mentionTokenSource', () => {
  const tokens = (text: string, names: string[]) =>
    [...text.matchAll(new RegExp(mentionTokenSource(names), 'giu'))].map(m => m[0]);

  it('highlights a spaced name whole', () => {
    expect(tokens('@x t d 看下这个', NAMES)).toEqual(['@x t d']);
    expect(tokens('thanks @X T D', NAMES)).toEqual(['@X T D']);
  });

  it('keeps plain names as before', () => {
    expect(tokens('@Claude and @Grok', NAMES)).toEqual(['@Claude', '@Grok']);
    expect(tokens('@x t d', [])).toEqual(['@x']);
  });

  it('does not claim a spaced name that runs into more letters', () => {
    expect(tokens('@x t dog', NAMES)).toEqual(['@x']);
  });

  it('escapes regex characters in names', () => {
    expect(tokens('@Claude (2) go', ['Claude (2)'])).toEqual(['@Claude (2)']);
  });
});
