import { describe, expect, it } from 'vitest';
import {
  classifyAttachmentRisk,
  isCodeExecutionEnabled,
  redactSecrets,
  safeAttachmentPromptText,
} from './security.js';

describe('secret redaction', () => {
  it('redacts canary credentials without reproducing them', () => {
    const canary = ['API_KEY=' + 'sk-' + 'A'.repeat(24), 'Authorization: Bearer canary-value-123'].join('\n');
    const result = redactSecrets(canary);
    expect(result.redacted).toBe(true);
    expect(result.matches).toBeGreaterThanOrEqual(2);
    expect(result.text).toContain('[REDACTED]');
    expect(result.text).not.toContain('canary-value-123');
    expect(result.text).not.toContain('sk-' + 'A'.repeat(24));
  });

  it('redacts private-key blocks and secret JSON fields', () => {
    const input = '-----BEGIN PRIVATE KEY-----\ncanary\n-----END PRIVATE KEY-----\n{"TunnelSecret":"not-a-real-secret"}';
    const result = redactSecrets(input);
    expect(result.text).not.toContain('canary');
    expect(result.text).not.toContain('not-a-real-secret');
  });
});

describe('attachment prompt projection', () => {
  it('blocks the 5YJ double-extension script and dotenv config', () => {
    expect(classifyAttachmentRisk('index.js.txt', 'text/plain')).toBe('executable');
    expect(classifyAttachmentRisk('package.json', 'application/json')).toBe('executable');
    expect(classifyAttachmentRisk('.env.txt', 'text/plain')).toBe('sensitive');
    expect(safeAttachmentPromptText('index.js.txt', 'text/plain', 'spawn("node")')).toBeUndefined();
    expect(safeAttachmentPromptText('.env.txt', 'text/plain', 'TOKEN=canary')).toBeUndefined();
  });

  it('allows ordinary documents after redaction', () => {
    expect(safeAttachmentPromptText('notes.md', 'text/markdown', 'hello world')).toBe('hello world');
  });
});

describe('execution kill switch', () => {
  it('is fail-closed and only accepts the explicit value 1', () => {
    expect(isCodeExecutionEnabled(undefined)).toBe(false);
    expect(isCodeExecutionEnabled('true')).toBe(false);
    expect(isCodeExecutionEnabled('0')).toBe(false);
    expect(isCodeExecutionEnabled('1')).toBe(true);
  });
});

// From #745: executable uploads are shared with a warning, so classification
// and byte sniffing decide what gets the warning.
import { hasExecutableSignature, isExecutableAttachment } from './security.js';

describe('executable attachments', () => {
  it('recognises native binaries and scripts by their bytes, whatever the name', () => {
    expect(hasExecutableSignature(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBe(true); // ELF
    expect(hasExecutableSignature(new TextEncoder().encode('#!/bin/sh\necho hi'))).toBe(true);
    const pe = new Uint8Array(128); pe[0] = 0x4d; pe[1] = 0x5a; pe[0x3c] = 64; pe.set([0x50, 0x45, 0, 0], 64);
    expect(hasExecutableSignature(pe)).toBe(true);
    expect(hasExecutableSignature(new TextEncoder().encode('MZ but just text that is long enough to have a header field at 0x3c ...'))).toBe(false);
    expect(hasExecutableSignature(new TextEncoder().encode('plain text'))).toBe(false);
  });

  it('treats macro-enabled Office files and scripts as executable, documents as not', () => {
    for (const name of ['report.xlsm', 'deck.pptm', 'run.ps1', 'tool.exe', 'install.sh ']) {
      expect(isExecutableAttachment({ name, mime: 'application/octet-stream' })).toBe(true);
    }
    expect(isExecutableAttachment({ name: 'x', mime: 'application/vnd.ms-excel.sheet.macroEnabled.12' })).toBe(true);
    expect(isExecutableAttachment({ name: 'report.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).toBe(false);
    expect(isExecutableAttachment({ name: 'notes.md', mime: 'text/markdown', riskClass: 'executable' })).toBe(true);
  });
});
