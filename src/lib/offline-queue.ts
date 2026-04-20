/**
 * offline-queue.ts — Client-side offline message queue with exponential backoff.
 *
 * Queues chat messages when the network is unavailable or the server returns
 * an error, then retries automatically with 1s → 2s → 4s → 8s backoff.
 *
 * Singleton — import { getOfflineQueue } from '@/lib/offline-queue';
 */

import type { CommentScope } from '@/lib/store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorType =
  | 'networkError'
  | 'timeout'
  | 'serverError'
  | 'rateLimited'
  | 'unauthorized'
  | 'generic';

export type QueuedMessageStatus = 'pending' | 'failed' | 'retrying' | 'sent';

export interface QueuedMessage {
  id: string;
  scope: CommentScope;
  comment: {
    author: string;
    content: string;
    type: 'comment';
    mentions?: string[];
  };
  status: QueuedMessageStatus;
  retryAttempts: number;
  nextRetryAt: number | null;
  errorType: ErrorType | null;
  errorMessage: string | null;
  createdAt: number;
  /** Timer handle for scheduled auto-retry */
  _timerId?: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Error → user-friendly message mapping
// ---------------------------------------------------------------------------

export function friendlyError(errorType: ErrorType | null): string {
  switch (errorType) {
    case 'networkError':
      return '📡 Offline — message will send when online';
    case 'timeout':
      return '⏱️ Network slow — retrying…';
    case 'serverError':
      return '❌ Server error — will retry automatically';
    case 'rateLimited':
      return '🚦 Rate limited — will retry shortly';
    case 'unauthorized':
      return '🔐 Auth expired — please log in again';
    case 'generic':
    default:
      return '❌ Send failed — tap to retry';
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 8000;

function backoffMs(attempts: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempts), MAX_DELAY_MS);
}

// ---------------------------------------------------------------------------
// OfflineQueue
// ---------------------------------------------------------------------------

type Listener = () => void;

let _instance: OfflineQueue | null = null;

export class OfflineQueue {
  private queue = new Map<string, QueuedMessage>();
  private listeners = new Set<Listener>();
  private _onlineHandler: (() => void) | null = null;

  // Cached snapshot for useSyncExternalStore. Must be a STABLE reference
  // between calls when nothing mutates — otherwise React's getSnapshot
  // stability check fails and re-renders in a loop (React error #185).
  // Invalidated by emit() on every mutation.
  private _snapshot: QueuedMessage[] = [];
  private _snapshotDirty = true;

  constructor() {
    // Listen for online events — flush pending/failed items
    if (typeof window !== 'undefined') {
      this._onlineHandler = () => this.flushOnReconnect();
      window.addEventListener('online', this._onlineHandler);
    }
  }

  // ---- Subscriptions -------------------------------------------------------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit() {
    // Any mutation invalidates the cached snapshot.
    this._snapshotDirty = true;
    this.listeners.forEach(fn => fn());
  }

  // ---- Public API ----------------------------------------------------------

  getAll(): QueuedMessage[] {
    if (this._snapshotDirty) {
      this._snapshot = Array.from(this.queue.values()).sort((a, b) => a.createdAt - b.createdAt);
      this._snapshotDirty = false;
    }
    return this._snapshot;
  }

  get count(): number {
    return this.queue.size;
  }

  /**
   * Enqueue a message and immediately attempt to send it.
   * Returns the queue item id.
   */
  enqueue(scope: CommentScope, comment: QueuedMessage['comment']): string {
    const id = crypto.randomUUID();
    const item: QueuedMessage = {
      id,
      scope,
      comment,
      status: 'pending',
      retryAttempts: 0,
      nextRetryAt: null,
      errorType: null,
      errorMessage: null,
      createdAt: Date.now(),
    };
    this.queue.set(id, item);
    this.emit();
    this.attemptSend(item);
    return id;
  }

  /**
   * Manually retry a single message.
   */
  retryOne(messageId: string): void {
    const item = this.queue.get(messageId);
    if (!item) return;
    // Don't retry unauthorized — user must re-login
    if (item.errorType === 'unauthorized') return;
    // Clear any existing timer
    if (item._timerId) clearTimeout(item._timerId);
    item.status = 'retrying';
    item.errorType = null;
    item.errorMessage = null;
    this.emit();
    this.attemptSend(item);
  }

  /**
   * Remove a single message from the queue (user dismissal).
   */
  remove(messageId: string): void {
    const item = this.queue.get(messageId);
    if (item?._timerId) clearTimeout(item._timerId);
    this.queue.delete(messageId);
    this.emit();
  }

  /**
   * Clear entire queue (e.g. on logout).
   */
  clear(): void {
    for (const item of this.queue.values()) {
      if (item._timerId) clearTimeout(item._timerId);
    }
    this.queue.clear();
    this.emit();
  }

  /**
   * Destroy singleton — for cleanup/tests.
   */
  destroy(): void {
    this.clear();
    this.listeners.clear();
    if (typeof window !== 'undefined' && this._onlineHandler) {
      window.removeEventListener('online', this._onlineHandler);
    }
    _instance = null;
  }

  // ---- Internals -----------------------------------------------------------

  private async attemptSend(item: QueuedMessage): Promise<void> {
    // If browser is offline, skip the fetch — mark as network error immediately
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.handleError(item, 'networkError');
      return;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      const res = await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'addComment',
          scope: item.scope,
          comment: item.comment,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        this.handleSuccess(item);
        return;
      }

      // Map HTTP status to error type
      const status = res.status;
      if (status === 401 || status === 403) {
        this.handleError(item, 'unauthorized');
      } else if (status === 429) {
        this.handleError(item, 'rateLimited');
      } else if (status >= 500) {
        this.handleError(item, 'serverError');
      } else {
        this.handleError(item, 'generic');
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        this.handleError(item, 'timeout');
      } else {
        this.handleError(item, 'networkError');
      }
    }
  }

  private handleSuccess(item: QueuedMessage): void {
    item.status = 'sent';
    item.errorType = null;
    item.errorMessage = null;
    this.emit();

    // Remove from queue after 3s (so UI can show brief success)
    setTimeout(() => {
      this.queue.delete(item.id);
      this.emit();
    }, 3000);
  }

  private handleError(item: QueuedMessage, errorType: ErrorType): void {
    item.retryAttempts += 1;
    item.errorType = errorType;
    item.errorMessage = friendlyError(errorType);

    // Unauthorized: don't auto-retry
    if (errorType === 'unauthorized') {
      item.status = 'failed';
      item.nextRetryAt = null;
      this.emit();
      return;
    }

    // Exceeded max retries — stay failed, let user manually retry
    if (item.retryAttempts >= MAX_RETRIES) {
      item.status = 'failed';
      item.nextRetryAt = null;
      this.emit();
      return;
    }

    // Schedule auto-retry with backoff
    const delay = backoffMs(item.retryAttempts - 1);
    item.status = 'retrying';
    item.nextRetryAt = Date.now() + delay;
    this.emit();

    if (item._timerId) clearTimeout(item._timerId);
    item._timerId = setTimeout(() => {
      // Only retry if still in the queue and still in retrying state
      if (this.queue.has(item.id) && item.status === 'retrying') {
        this.attemptSend(item);
      }
    }, delay);
  }

  /**
   * Called when the browser comes back online — retry all pending/failed items.
   */
  private flushOnReconnect(): void {
    for (const item of this.queue.values()) {
      if (item.status === 'failed' || item.status === 'retrying') {
        if (item.errorType === 'unauthorized') continue;
        if (item._timerId) clearTimeout(item._timerId);
        item.status = 'retrying';
        item.retryAttempts = 0; // Reset on reconnect
        item.errorType = null;
        item.errorMessage = null;
        this.emit();
        this.attemptSend(item);
      }
    }
  }
}

/**
 * Get the singleton OfflineQueue instance.
 */
export function getOfflineQueue(): OfflineQueue {
  if (!_instance) {
    _instance = new OfflineQueue();
  }
  return _instance;
}
