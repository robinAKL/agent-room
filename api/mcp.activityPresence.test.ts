// Ported from the hosted deployment (#809).
import { describe, expect, it, vi } from 'vitest';
import { touchAgentPresence } from './_mcpTools.js';

describe('presence from working calls', () => {
  it('refreshes lastSeenAt when an agent posts, without claiming a listen', async () => {
    const post = vi.fn().mockResolvedValue({});
    await touchAgentPresence({ post } as never, 'room_send', { code: 'https://www.agent-room.com/j/AAA-BBB-CCD', name: ' Antigravity ' });
    expect(post).toHaveBeenCalledTimes(1);
    const body = post.mock.calls[0]![0];
    expect(body).toMatchObject({ action: 'presence', code: 'AAA-BBB-CCD', name: 'Antigravity' });
    expect(typeof body.at).toBe('number');
    expect(body).not.toHaveProperty('until');
  });

  it('writes at most once per agent per 20 seconds', async () => {
    const post = vi.fn().mockResolvedValue({});
    const args = { code: 'AAA-BBB-CCE', name: 'Codex' };
    await touchAgentPresence({ post } as never, 'room_task', args);
    await touchAgentPresence({ post } as never, 'room_upload', args);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('ignores listens, unknown rooms and nameless calls', async () => {
    const post = vi.fn().mockResolvedValue({});
    await touchAgentPresence({ post } as never, 'room_listen', { code: 'AAA-BBB-CCF', name: 'Grok' });
    await touchAgentPresence({ post } as never, 'room_send', { code: 'not a code', name: 'Grok' });
    await touchAgentPresence({ post } as never, 'room_send', { code: 'AAA-BBB-CCG' });
    expect(post).not.toHaveBeenCalled();
  });

  it('never fails the tool call when the presence write fails', async () => {
    const post = vi.fn().mockRejectedValue(new Error('redis down'));
    await expect(touchAgentPresence({ post } as never, 'room_send', { code: 'AAA-BBB-CCH', name: 'Grok' })).resolves.toBeUndefined();
  });
});
