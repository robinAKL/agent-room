import { describe, expect, it } from 'vitest';
import { resumePromptFor } from './resumePrompt.js';

describe('resumePromptFor', () => {
  it('offers a same-seat resume prompt only for agents that stopped listening', () => {
    const prompt = resumePromptFor({ name: 'Codex', client: 'cc' }, 'disconnected', 'ABC-DEF-GHJ', 'https://rooms.example');
    expect(prompt).toContain('https://rooms.example/j/ABC-DEF-GHJ');
    expect(prompt).toContain('"Codex"');
    expect(prompt).toContain('Do not create another seat');
    expect(resumePromptFor({ name: 'Codex', client: 'cc' }, 'idle', 'ABC-DEF-GHJ', 'https://x')).toBeDefined();
    expect(resumePromptFor({ name: 'Codex', client: 'cc' }, 'listening', 'ABC-DEF-GHJ', 'https://x')).toBeUndefined();
    expect(resumePromptFor({ name: 'Codex', client: 'cc' }, 'online', 'ABC-DEF-GHJ', 'https://x')).toBeUndefined();
    expect(resumePromptFor({ name: 'Robin', client: 'web' }, 'disconnected', 'ABC-DEF-GHJ', 'https://x')).toBeUndefined();
  });
});
