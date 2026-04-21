'use client';

/**
 * useOfflineQueue.ts — React hook for the client-side offline message queue.
 *
 * Provides reactive access to queued messages, enqueue/retry/remove helpers,
 * and auto-retry lifecycle management.
 *
 * Usage:
 *   const { items, count, enqueue, retryOne, remove, clear } = useOfflineQueue();
 */

import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import {
  getOfflineQueue,
  type QueuedMessage,
  type QueuedMessageStatus,
} from '@/lib/offline-queue';
import type { CommentScope } from '@/lib/store';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useOfflineQueue() {
  const queue = getOfflineQueue();

  // useSyncExternalStore keeps React in sync with the queue's internal state.
  const items = useSyncExternalStore(
    useCallback((cb: () => void) => queue.subscribe(cb), [queue]),
    () => queue.getAll(),
    () => [] as QueuedMessage[], // SSR snapshot
  );

  const count = items.length;

  const enqueue = useCallback(
    (scope: CommentScope, comment: QueuedMessage['comment']) => queue.enqueue(scope, comment),
    [queue],
  );

  const retryOne = useCallback(
    (messageId: string) => queue.retryOne(messageId),
    [queue],
  );

  const remove = useCallback(
    (messageId: string) => queue.remove(messageId),
    [queue],
  );

  const clear = useCallback(() => queue.clear(), [queue]);

  return { items, count, enqueue, retryOne, remove, clear } as const;
}

/**
 * Lightweight variant that only exposes the count (avoids re-renders from
 * the full items array when you only need a badge number).
 */
export function useOfflineQueueCount(): number {
  const queue = getOfflineQueue();
  return useSyncExternalStore(
    useCallback((cb: () => void) => queue.subscribe(cb), [queue]),
    () => queue.count,
    () => 0,
  );
}
