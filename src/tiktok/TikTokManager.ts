import { EventEmitter } from 'node:events';
import { WebcastPushConnection } from 'tiktok-live-connector';

export type TikTokEvent = {
  type: string;
  payload: unknown;
  timestamp: number;
  room: string; // uniqueId (username)
};

export type ConnectOptions = {
  uniqueId: string; // TikTok username/room uniqueId
  sessionId?: string; // optional session id for multi-tenant tracking
};

export class TikTokManager extends EventEmitter {
  private connections: Map<string, WebcastPushConnection> = new Map();

  constructor() {
    super();
  }

  public async connect(options: ConnectOptions): Promise<void> {
    const key = options.uniqueId;
    if (this.connections.has(key)) {
      return; // already connected
    }

    const connection = new WebcastPushConnection(options.uniqueId, {
      // You may configure request headers/proxy here if needed
      // requestOptions: {}
    });

    // Bind all relevant events and re-emit in a normalized shape
    const relay = (type: string) => (payload: unknown) => {
      const evt: TikTokEvent = { type, payload, timestamp: Date.now(), room: options.uniqueId };
      this.emit('event', evt);
    };

    connection.on('connected', relay('connected'));
    connection.on('disconnected', relay('disconnected'));
    connection.on('streamEnd', relay('streamEnd'));
    connection.on('streamStart', relay('streamStart'));

    connection.on('chat', relay('chat'));
    connection.on('member', relay('member'));
    connection.on('gift', relay('gift'));
    connection.on('like', relay('like'));
    connection.on('social', relay('social'));
    connection.on('follow', relay('follow'));
    connection.on('share', relay('share'));
    connection.on('questionNew', relay('questionNew'));
    connection.on('goalUpdate', relay('goalUpdate'));
    connection.on('subscribe', relay('subscribe'));
    connection.on('emote', relay('emote'));

    connection.on('error', (err) => {
      const evt: TikTokEvent = { type: 'error', payload: serializeError(err), timestamp: Date.now(), room: options.uniqueId };
      this.emit('event', evt);
    });

    try {
      await connection.connect();
      this.connections.set(key, connection);
    } catch (err) {
      const evt: TikTokEvent = { type: 'error', payload: serializeError(err), timestamp: Date.now(), room: options.uniqueId };
      this.emit('event', evt);
      throw err;
    }
  }

  public async disconnect(uniqueId: string): Promise<void> {
    const conn = this.connections.get(uniqueId);
    if (!conn) return;
    try {
      await conn.disconnect();
    } finally {
      this.connections.delete(uniqueId);
      const evt: TikTokEvent = { type: 'disconnected', payload: { uniqueId }, timestamp: Date.now(), room: uniqueId };
      this.emit('event', evt);
    }
  }

  public getStatus() {
    return Array.from(this.connections.keys());
  }
}

function serializeError(err: unknown) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}


