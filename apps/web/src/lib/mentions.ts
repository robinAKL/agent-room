// Composer @-mention helpers: which query the caret is in, who the picker
// offers, what gets inserted, and how a rendered message finds the mention.
//
// Everyone in the room can be mentioned — agents, the host and members — and
// display names may contain spaces ("x t d"). The picker used to list agents
// only, and the query was cut at the first space, so a human named "x t d"
// could not be mentioned at all.

export interface MentionablePerson {
  name: string;
  client: string;
  role?: string;
}

export interface MentionLookup {
  /** Index of the "@". */
  start: number;
  /** Caret position; the query runs from start + 1 to here. */
  end: number;
  /** Lower-cased text typed after the "@". */
  query: string;
}

/**
 * The @-query the caret is in, or null.
 *
 * The "@" must start a token (line start, whitespace or an opening bracket) so
 * an email address never opens the picker. A query without spaces is always a
 * lookup. A query with spaces stays a lookup only while it is still the start
 * of somebody's name: "@x t" keeps offering "x t d", while "@Claude please"
 * closes the picker because no name starts with "claude please".
 */
export function mentionQueryAt(value: string, caret: number, names: readonly string[] = []): MentionLookup | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/[\s([{]/.test(before[at - 1]!)) return null;
  const raw = before.slice(at + 1);
  if (/[\n\r]/.test(raw)) return null;
  const query = raw.toLowerCase();
  if (/\s/.test(raw) && !names.some(name => name.toLowerCase().startsWith(query))) return null;
  return { start: at, end: caret, query };
}

/**
 * Who the picker offers for `query`: every participant except the viewer,
 * agents and humans alike. Names that start with the query come first, then
 * names that merely contain it; agents before people within each group.
 */
export function mentionCandidates<T extends MentionablePerson>(
  participants: readonly T[],
  query: string,
  selfName: string,
  limit = 8,
): T[] {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const matches: { person: T; rank: number; index: number }[] = [];
  participants.forEach((person, index) => {
    if (person.client === 'web' && person.name === selfName) return;
    if (!person.name.trim()) return;
    const key = person.name.toLowerCase();
    if (seen.has(key)) return;
    const lower = person.name.toLowerCase();
    if (!lower.includes(q)) return;
    seen.add(key);
    const rank = (lower.startsWith(q) ? 0 : 2) + (person.client === 'cc' ? 0 : 1);
    matches.push({ person, rank, index });
  });
  return matches
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map(m => m.person);
}

/** Replace the active query with "@Name " and say where the caret goes. */
export function insertMentionText(text: string, lookup: MentionLookup, name: string): { text: string; caret: number } {
  const before = text.slice(0, lookup.start);
  const after = text.slice(lookup.end).replace(/^\s*/, '');
  const mention = `@${name} `;
  return { text: `${before}${mention}${after}`, caret: before.length + mention.length };
}

/** Short label shown next to a name in the picker. */
export function mentionRoleLabel(person: MentionablePerson, hostName?: string): string {
  if (person.client === 'cc') return person.role?.trim() || 'Agent';
  return person.name === hostName ? 'Host' : 'Member';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex source for one "@mention" token in rendered text. A plain
 * `@[\p{L}\p{N}_]+` stops at the first space, so "@x t d" lit up as "@x".
 * Names the plain pattern cannot cover whole (spaces, brackets, dots) are
 * tried first, longest first, and must not run straight into more ASCII
 * word characters.
 */
export function mentionTokenSource(names: readonly string[]): string {
  const plain = '@[\\p{L}\\p{N}_]+';
  const special = [...new Set(names.map(n => n.trim()).filter(n => n && /[^\p{L}\p{N}_]/u.test(n)))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (special.length === 0) return plain;
  return `@(?:${special.join('|')})(?![A-Za-z0-9_])|${plain}`;
}
