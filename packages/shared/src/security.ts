export type AttachmentProvenance = 'user_upload' | 'agent_generated' | 'system';
export type AttachmentScanStatus = 'pending' | 'sanitized' | 'blocked';
export type AttachmentRiskClass = 'low' | 'sensitive' | 'executable' | 'archive';

export const EXECUTABLE_ATTACHMENT_WARNING = 'This file can run code and may contain malware. Verify the source and scan it before running or opening it.';

export interface SecretRedactionResult {
  text: string;
  redacted: boolean;
  matches: number;
}

const REDACTION = '[REDACTED]';

/**
 * Model-independent last-mile redaction for text crossing a trust boundary.
 * Keep this deliberately conservative: a false positive is preferable to
 * persisting or streaming a credential. Callers must use the returned text.
 */
export function redactSecrets(value: unknown): SecretRedactionResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { text: typeof value === 'string' ? value : '', redacted: false, matches: 0 };
  }

  let text = value;
  let matches = 0;
  const replace = (pattern: RegExp, replacement: string | ((...args: string[]) => string)) => {
    text = text.replace(pattern, (...args: string[]) => {
      matches += 1;
      return typeof replacement === 'string' ? replacement : replacement(...args);
    });
  };

  replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi, REDACTION);
  replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTION);
  replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|[0-9]{6,12}:AA[A-Za-z0-9_-]{20,})\b/g, REDACTION);
  replace(/\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi, (_all, prefix) => `${prefix}${REDACTION}`);
  replace(/\b(https?:\/\/)[^\s\/@:]+:[^\s\/@]+@/gi, (_all, scheme) => `${scheme}${REDACTION}@`);

  // Covers dotenv, shell assignments, YAML and JSON. It also fails closed on
  // an incomplete streaming value: once a sensitive key and separator appear,
  // the partial value is hidden rather than briefly reaching the client.
  replace(
    /(^|[\s,{])(\"?[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|tunnelsecret)\"?\s*[:=]\s*)(["']?)([^\s,}\]\r\n"']*)\3/gim,
    (_all, lead, key) => `${lead}${key}${REDACTION}`,
  );

  return { text, redacted: matches > 0, matches };
}

export function redactSecretText(value: unknown): string {
  return redactSecrets(value).text;
}

export function classifyAttachmentRisk(name: string, mime: string, extractedText?: string): AttachmentRiskClass {
  const lower = name.toLowerCase().replace(/[.\s]+$/, '');
  const type = mime.split(';')[0]?.trim().toLowerCase();
  if (type && /^(?:application\/(?:x-msdownload|x-msdos-program|vnd\.microsoft\.portable-executable|x-executable|x-pie-executable|x-sharedlib|x-mach-binary|x-msi|x-ms-installer|x-bat|x-sh|java-archive|wasm)|text\/(?:javascript|x-shellscript)|application\/javascript)$/.test(type)) return 'executable';
  if (type?.includes('macroenabled')) return 'executable';
  if (/^(?:package(?:-lock)?\.json|dockerfile|makefile|compose\.ya?ml)$/.test(lower)) return 'executable';
  if (/\.(?:js|mjs|cjs|jse|ts|tsx|py|pyw|rb|php|pl|sh|bash|zsh|ps1|psm1|bat|cmd|vbs|vbe|wsf|wsh|hta|exe|com|msi|msp|scr|dll|cpl|sys|so|dylib|app|appimage|apk|jar|wasm|lnk|reg|desktop|xlsm|xlam|xlsb|docm|dotm|pptm|ppsm|potm)(?:\.|$)/.test(lower)) return 'executable';
  if (/\.(?:zip|tar|tgz|gz|bz2|xz|7z|rar)$/.test(lower) || type === 'application/zip') return 'archive';
  if (/(^|\.)(?:env|pem|key|p12|pfx)(?:\.|$)/.test(lower)) return 'sensitive';
  if (extractedText && redactSecrets(extractedText).redacted) return 'sensitive';
  return 'low';
}

export function isExecutableAttachment(attachment: { name: string; mime: string; riskClass?: AttachmentRiskClass }): boolean {
  return attachment.riskClass === 'executable' || classifyAttachmentRisk(attachment.name, attachment.mime) === 'executable';
}

/** Common native binaries and shell scripts, including files with a misleading extension. */
export function hasExecutableSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = header.getUint32(0);
  if (magic === 0x7f454c46 || magic === 0x0061736d || magic === 0xfeedface
    || magic === 0xcefaedfe || magic === 0xfeedfacf || magic === 0xcffaedfe) return true;
  if (bytes[0] === 0x23 && bytes[1] === 0x21) return true; // script shebang
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return false;
  const peOffset = header.getUint32(0x3c, true);
  return peOffset >= 64 && peOffset <= bytes.length - 4 && header.getUint32(peOffset, true) === 0x4550;
}

/** Only low-risk, redacted document text may enter an agent prompt. */
export function safeAttachmentPromptText(name: string, mime: string, extractedText?: string): string | undefined {
  if (!extractedText) return undefined;
  if (classifyAttachmentRisk(name, mime, extractedText) !== 'low') return undefined;
  return redactSecretText(extractedText);
}

/** Code execution is disabled unless operators deliberately opt in. */
export function isCodeExecutionEnabled(value: unknown): boolean {
  return value === '1';
}
