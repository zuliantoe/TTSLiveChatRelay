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
  private connectingPromises: Map<string, Promise<void>> = new Map();
  private recentChatKeysByRoom: Map<string, Map<string, number>> = new Map();

  constructor() {
    super();
  }

  public async connect(options: ConnectOptions): Promise<void> {
    const key = options.uniqueId;
    // Already connected?
    if (this.connections.has(key)) return;
    // If a connection is already in progress, wait for it
    const inFlight = this.connectingPromises.get(key);
    if (inFlight) {
      await inFlight;
      return;
    }

    // Prepare promise FIRST to avoid race with concurrent callers
    const connectPromise = new Promise<void>((resolve, reject) => {
      (async () => {
        try {
          const connection = new WebcastPushConnection(options.uniqueId, {
            // requestOptions: {}
          });

          const relay = (type: string) => (payload: unknown) => {
            // Dedupe only for chat events
            if (type === 'chat') {
              const room = options.uniqueId;
              const key = computeChatKey(payload);
              if (key) {
                if (!this.shouldEmitChat(room, key)) return;
              }
            }
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

          await connection.connect();
          this.connections.set(key, connection);
          resolve();
        } catch (err) {
          const evt: TikTokEvent = { type: 'error', payload: serializeError(err), timestamp: Date.now(), room: options.uniqueId };
          this.emit('event', evt);
          reject(err as Error);
        } finally {
          this.connectingPromises.delete(key);
        }
      })();
    });

    this.connectingPromises.set(key, connectPromise);
    await connectPromise;
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

function computeChatKey(payload: unknown): string | null {
  try {
    const anyPayload = payload as any;
    // Prefer stable message ids if available
    const id = anyPayload?.msgId || anyPayload?.messageId || anyPayload?.id;
    if (id) return String(id);
    // Fallback fingerprint
    const user = anyPayload?.uniqueId || anyPayload?.userId || anyPayload?.user?.userId || anyPayload?.user?.uniqueId;
    const text = anyPayload?.comment || anyPayload?.text || anyPayload?.content;
    const time = anyPayload?.createTime || anyPayload?.timestamp || anyPayload?.ts;
    const approx = `${user ?? ''}|${text ?? ''}|${time ?? ''}`;
    if (approx !== '||') return approx;
  } catch {}
  return null;
}

// Methods on prototype to manage recent chat keys
interface TikTokManager {
  shouldEmitChat(room: string, key: string): boolean;
}

TikTokManager.prototype.shouldEmitChat = function (room: string, key: string): boolean {
  const now = Date.now();
  const ttlMs = 2 * 60 * 1000; // 2 minutes
  if (!this.recentChatKeysByRoom.has(room)) this.recentChatKeysByRoom.set(room, new Map());
  const map = this.recentChatKeysByRoom.get(room)!;
  const last = map.get(key);
  if (last && now - last < ttlMs) return false; // duplicate within TTL
  map.set(key, now);
  // Opportunistic cleanup if map grows large
  if (map.size > 1000) {
    for (const [k, ts] of map) {
      if (now - ts >= ttlMs) map.delete(k);
      if (map.size <= 800) break;
    }
  }
  return true;
};


