import type { Room } from './types.js';

// Room retention (from the hosted deployment's #714, adapted).
//
// A room's data is kept for a day after the room ENDS, not for a day after it
// was created: a meeting that runs past 24 hours must not disappear while it
// is live, and an ended room keeps a full day for minutes and exports.
//
// The hosted deployment drops the TTL of an active room entirely and relies
// on a silence sweep to end abandoned rooms. This deployment has no sweep (the
// web client's idle auto-close only runs while a tab is open), so an active
// room keeps a backstop deadline instead: a week after it started or was last
// reopened. Ending the room replaces it with the end-based deadline.
export const ROOM_RETENTION_GRACE_MS = 24 * 60 * 60 * 1000;
export const ROOM_ACTIVE_BACKSTOP_MS = 7 * 24 * 60 * 60 * 1000;

/** Epoch ms at which every key of this room expires. */
export function roomDestroyAt(room: Pick<Room, 'status' | 'createdAt'> & Partial<Pick<Room, 'endedAt' | 'reactivatedAt'>>, now = Date.now()): number {
  if (room.status === 'ended' || typeof room.endedAt === 'number') {
    return (typeof room.endedAt === 'number' && Number.isFinite(room.endedAt) ? room.endedAt : now) + ROOM_RETENTION_GRACE_MS;
  }
  const started = room.reactivatedAt ?? room.createdAt;
  return (Number.isFinite(started) ? started : now) + ROOM_ACTIVE_BACKSTOP_MS;
}

/** The same deadline as a Redis EXPIREAT argument (whole seconds). */
export function roomExpireAtSeconds(room: Parameters<typeof roomDestroyAt>[0], now = Date.now()): number {
  return Math.floor(roomDestroyAt(room, now) / 1000);
}
