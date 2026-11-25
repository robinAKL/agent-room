import { describe, expect, it } from 'vitest';
import { ALLOWED_ATTACHMENT_EXTENSIONS, XLSM_MIME, XLS_MIME, XLSX_MIME, resolveAttachmentMime } from './attachmentMime.js';

describe('resolveAttachmentMime', () => {
  it('keeps an allowlisted reported MIME', () => {
    expect(resolveAttachmentMime('q3.xlsx', XLSX_MIME)).toBe(XLSX_MIME);
    expect(resolveAttachmentMime('notes.txt', 'text/plain; charset=utf-8')).toBe('text/plain');
    // Windows reports .csv as application/vnd.ms-excel; the extractor sniffs the bytes.
    expect(resolveAttachmentMime('data.csv', XLS_MIME)).toBe(XLS_MIME);
  });

  it('falls back to the extension when the browser reports no MIME or an unknown one', () => {
    expect(resolveAttachmentMime('q3.xlsx', '')).toBe(XLSX_MIME);
    expect(resolveAttachmentMime('Q3.XLSX', 'application/octet-stream')).toBe(XLSX_MIME);
    expect(resolveAttachmentMime('q3.xlsx', 'application/wps-office.xlsx')).toBe(XLSX_MIME);
    expect(resolveAttachmentMime('old.xls', 'application/x-msexcel')).toBe(XLS_MIME);
    expect(resolveAttachmentMime('README.md', '')).toBe('text/markdown');
    expect(resolveAttachmentMime('photo.JPG', undefined)).toBe('image/jpeg');
  });

  it('recognises macro-enabled workbooks by MIME or extension', () => {
    expect(resolveAttachmentMime('order.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12')).toBe(XLSM_MIME);
    expect(resolveAttachmentMime('order.xlsm', '')).toBe(XLSM_MIME);
    expect(resolveAttachmentMime('order.XLSM', 'application/octet-stream')).toBe(XLSM_MIME);
    expect(ALLOWED_ATTACHMENT_EXTENSIONS).toContain('.xlsm');
  });

  it('uses a binary download for other files and recognizes PowerPoint by extension', () => {
    expect(resolveAttachmentMime('setup.exe', 'application/x-msdownload')).toBe('application/octet-stream');
    expect(resolveAttachmentMime('noext', '')).toBe('application/octet-stream');
    expect(resolveAttachmentMime('slides.ppt', '')).toBe('application/vnd.ms-powerpoint');
    expect(resolveAttachmentMime('slides.PPTX', 'application/octet-stream')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
  });

  it('lists Excel extensions for the file picker', () => {
    expect(ALLOWED_ATTACHMENT_EXTENSIONS).toEqual(expect.arrayContaining(['.xlsx', '.xls', '.csv']));
  });
});
