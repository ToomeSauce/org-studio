/**
 * postgres-pubsub.ts
 * 
 * Pub/Sub mechanism using Postgres LISTEN/NOTIFY
 * Allows multiple instances (local, remote, etc.) to stay in sync
 * 
 * Usage:
 * const pubsub = new PostgresPubSub(DATABASE_URL);
 * 
 * Publishing (when data changes):
 * await pubsub.notifyChange('tasks', 'update', taskId);
 * 
 * Subscribing (to receive remote changes):
 * pubsub.on('tasks:update', (data) => {
 *   console.log('Task updated:', data);
 * });
 * await pubsub.subscribe(['tasks:update', 'projects:update']);
 * 
 * Cleanup:
 * await pubsub.close();
 */

import EventEmitter from 'events';

export interface ChangeNotification {
  type: string; // 'create', 'update', 'delete'
  entity: string; // 'tasks', 'projects', 'settings'
  id: string; // task/project id
  timestamp: number; // Unix timestamp
  sourceInstance?: string; // Instance ID that made the change (for deduplication)
}

export class PostgresPubSub extends EventEmitter {
  private connectionString: string;
  private pool: any;
  private listenerClient: any;
  private sourceInstanceId: string;
  private subscriptions: Set<string> = new Set();
  private isConnected = false;

  constructor(connectionString: string, sourceInstanceId?: string) {
    super();
    this.connectionString = connectionString;
    // Generate a unique instance ID if not provided (for deduplication)
    this.sourceInstanceId = sourceInstanceId || `inst-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Initialize the pub/sub system
   * Creates a dedicated listener connection and sets up channels
   */
  async initialize() {
    const { Pool } = require('pg');
    this.pool = new Pool({
      connectionString: this.connectionString,
      max: 10,
    });

    // Create a dedicated connection for listening
    this.listenerClient = await this.pool.connect();
    this.isConnected = true;

    // Set up listener for channel events
    this.listenerClient.on('notification', (msg: any) => {
      try {
        const data = JSON.parse(msg.payload) as ChangeNotification;
        
        // Emit event using entity:type pattern
        const eventName = `${data.entity}:${data.type}`;
        
        // Also emit raw 'change' event for generic listeners
        this.emit('change', data);
        
        // Emit entity-specific event
        this.emit(eventName, data);
        
        console.log(`[PubSub] Received notification: ${eventName} (id: ${data.id})`);
      } catch (e) {
        console.error('[PubSub] Failed to parse notification:', e);
      }
    });

    console.log(`[PubSub] Initialized with instance ID: ${this.sourceInstanceId}`);
  }

  /**
   * Subscribe to one or more change channels
   * Pattern: 'tasks:update', 'projects:*', 'settings:*'
   */
  async subscribe(channels: string | string[]) {
    if (!this.isConnected) {
      throw new Error('PubSub not initialized. Call initialize() first.');
    }

    const channelList = Array.isArray(channels) ? channels : [channels];

    for (const channel of channelList) {
      // Postgres LISTEN channel names can't contain colons in template literals
      // Use escaped identifier format: "org_studio_tasks_update"
      const pgChannel = `org_studio_${channel.replace(/:/g, '_')}`;
      
      await this.listenerClient.query(`LISTEN "${pgChannel}"`);
      this.subscriptions.add(channel);
      console.log(`[PubSub] Subscribed to: ${channel}`);
    }
  }

  /**
   * Unsubscribe from channels
   */
  async unsubscribe(channels?: string | string[]) {
    if (!channels) {
      // Unsubscribe from all
      for (const channel of this.subscriptions) {
        const pgChannel = `org_studio_${channel.replace(/:/g, '_')}`;
        await this.listenerClient.query(`UNLISTEN "${pgChannel}"`);
      }
      this.subscriptions.clear();
    } else {
      const channelList = Array.isArray(channels) ? channels : [channels];
      for (const channel of channelList) {
        const pgChannel = `org_studio_${channel.replace(/:/g, '_')}`;
        await this.listenerClient.query(`UNLISTEN "${pgChannel}"`);
        this.subscriptions.delete(channel);
      }
    }
  }

  /**
   * Publish a change notification
   * Other instances will receive this via LISTEN
   */
  async notifyChange(entity: string, type: 'create' | 'update' | 'delete', id: string, customData?: Record<string, any>) {
    if (!this.pool) {
      console.warn('[PubSub] Pool not initialized, skipping notification');
      return;
    }

    const notification: ChangeNotification = {
      type,
      entity,
      id,
      timestamp: Date.now(),
      sourceInstance: this.sourceInstanceId,
      ...customData,
    };

    // Note: NOTIFY requires a valid identifier, not a parameter
    // Use underscores instead of colons to make valid SQL identifiers
    const channel = `org_studio_${entity}_${type}`;
    const payload = JSON.stringify(notification);

    try {
      const client = await this.pool.connect();
      try {
        // NOTIFY channel_name, 'payload_string'
        // Using parameterized query for payload (the only safe parameter in NOTIFY)
        await client.query(
          `NOTIFY ${channel}, $1`,
          [payload]
        );
        console.log(`[PubSub] Notified ${channel} with id=${id}`);
      } finally {
        client.release();
      }
    } catch (e) {
      console.error(`[PubSub] Failed to notify: ${e}`);
      // Non-blocking — don't fail the operation if pub/sub fails
    }
  }

  /**
   * Health check — verify connection is alive
   */
  async health(): Promise<boolean> {
    try {
      if (!this.listenerClient) return false;
      await this.listenerClient.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close all connections
   */
  async close() {
    try {
      if (this.listenerClient) {
        await this.unsubscribe(); // Unlisten from all
        await this.listenerClient.release();
        this.listenerClient = null;
      }
      if (this.pool) {
        await this.pool.end();
        this.pool = null;
      }
      this.isConnected = false;
      console.log('[PubSub] Closed');
    } catch (e) {
      console.error('[PubSub] Error during close:', e);
    }
  }
}

// Singleton instance for global pub/sub
let globalPubSub: PostgresPubSub | null = null;

export async function getGlobalPubSub(): Promise<PostgresPubSub> {
  if (!globalPubSub) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error('DATABASE_URL not set — cannot initialize pub/sub');
    }
    globalPubSub = new PostgresPubSub(dbUrl);
    await globalPubSub.initialize();
  }
  return globalPubSub;
}

export async function closeGlobalPubSub() {
  if (globalPubSub) {
    await globalPubSub.close();
    globalPubSub = null;
  }
}
