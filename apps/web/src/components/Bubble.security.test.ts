// Executable attachments are shared as downloads with a warning (from #745),
// and roster names with spaces highlight whole (from #853).
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MessageAttachment } from '@agent-room/shared';
import { AttachmentList, renderInline } from './Bubble.js';

const attachment = (name: string, mime: string, extra: Partial<MessageAttachment> = {}): MessageAttachment => ({
  id: name, type: 'file', url: 'https://invalid/file', name, size: 1, mime, uploadedAt: 1, ...extra,
});

describe('attachment safety', () => {
  it('warns about executable downloads and keeps the download link available', () => {
    const html = renderToStaticMarkup(createElement(AttachmentList, { attachments: [attachment('setup.exe', 'application/octet-stream')] }));
    expect(html).toContain('may contain malware');
    expect(html).toContain('>Download<');
    expect(html).toContain('href="https://invalid/file"');
    expect(html).not.toContain('>Open<');
  });

  it('never renders an executable as an inline image', () => {
    const html = renderToStaticMarkup(createElement(AttachmentList, {
      attachments: [attachment('photo.png', 'image/png', { type: 'image', riskClass: 'executable' })],
    }));
    expect(html).not.toContain('<img');
    expect(html).toContain('may contain malware');
  });

  it('keeps Open for ordinary files', () => {
    const html = renderToStaticMarkup(createElement(AttachmentList, { attachments: [attachment('notes.md', 'text/markdown')] }));
    expect(html).toContain('>Open<');
    expect(html).not.toContain('malware');
  });
});

describe('mention highlighting', () => {
  const html = (text: string, names = '') => renderToStaticMarkup(createElement('p', null, ...renderInline(text, names)));
  it('highlights a roster name with spaces as one mention', () => {
    expect(html('@x t d can you check', 'Robin\nx t d')).toContain('>@x t d</span>');
    expect(html('@Claude look', '')).toContain('>@Claude</span>');
    expect(html('mail me@example.com', '')).not.toContain('<span');
  });
});
