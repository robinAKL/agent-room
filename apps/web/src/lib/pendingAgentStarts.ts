import { taskInboxFor, type TaskBoard } from '@agent-room/shared';

/** Presence and starting work are different facts. Use the board's start receipts. */
export function pendingAgentStarts(board: TaskBoard | null | undefined, name: string): string | null {
  if (!board) return null;
  const { queued, toVerify, reviewEvents } = taskInboxFor(board, name);
  const reviews = new Set(toVerify);
  for (const task of board.tasks) {
    const receipt = task.reviewReceipt;
    if (receipt?.startedAt !== undefined && receipt.byClient === 'cc' && receipt.notificationId === reviewEvents?.[task.id]
      && receipt.by.trim().toLowerCase() === name.trim().toLowerCase()) {
      reviews.delete(task.id);
    }
  }
  const labels = [
    ...(queued.length ? [`${queued.length} ${queued.length === 1 ? 'task' : 'tasks'}`] : []),
    ...(reviews.size ? [`${reviews.size} ${reviews.size === 1 ? 'review' : 'reviews'}`] : []),
  ];
  return labels.length ? labels.join(' and ') : null;
}
