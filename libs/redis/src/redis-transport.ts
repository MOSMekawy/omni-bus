import type { Redis } from 'ioredis';
import {
  type Envelope,
  type InboundHandler,
  type ISerializer,
  type ITransport,
  type Message,
  type TransportCapabilities,
  type TransportErrorHandler,
  type TransportInitContext,
  type TransportStartOptions,
  TypeRegistry,
  newMessageId,
} from '@omni-bus/core';

export interface RedisTransportOptions {
  readonly client: Redis;
  readonly serializer: ISerializer;
  readonly channelPrefix?: string;
  readonly rpcTimeoutMs?: number;
  readonly instanceId?: string;
}

interface PendingRpc {
  resolve: (env: Envelope<Message>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const CAPABILITIES: TransportCapabilities = {
  supportsRequestReply: true,
  supportsBroadcast: true,
  supportsScheduling: false,
  supportsDurability: false,
};

const noopErrorHandler: TransportErrorHandler = () => undefined;

export class RedisTransport implements ITransport {
  readonly name = 'redis';
  readonly capabilities: TransportCapabilities = CAPABILITIES;

  private readonly pub: Redis;
  private sub?: Redis;
  private readonly serializer: ISerializer;
  private readonly channelPrefix: string;
  private readonly rpcTimeoutMs: number;
  private readonly instanceId: string;
  private inbound?: InboundHandler;
  private registry: TypeRegistry = new TypeRegistry();
  private errorHandler: TransportErrorHandler = noopErrorHandler;
  private started = false;
  private readonly pending = new Map<string, PendingRpc>();

  static create(opts: RedisTransportOptions): RedisTransport {
    return new RedisTransport(opts);
  }

  private constructor(opts: RedisTransportOptions) {
    this.pub = opts.client;
    this.serializer = opts.serializer;
    this.channelPrefix = opts.channelPrefix ?? 'omni-bus';
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 30_000;
    this.instanceId = opts.instanceId ?? newMessageId();
  }

  init(ctx: TransportInitContext): void {
    this.registry = ctx.typeRegistry;
    this.errorHandler = ctx.onError;
  }

  onMessage(handler: InboundHandler): void {
    // Idempotent per the ITransport contract; the bus re-registers on every start().
    this.inbound = handler;
  }

  async start(options: TransportStartOptions = {}): Promise<void> {
    if (this.started) return;
    this.started = true;
    const replyListener = options.replyListener ?? true;
    const inbound = options.inbound ?? true;

    // No subscriber connection is needed at all for pure-fanout publishers.
    if (!replyListener && !inbound) return;

    this.sub = this.pub.duplicate();
    if (inbound) {
      this.sub.on('pmessage', (_pattern: string, _channel: string, message: string) => {
        void this.handleIncoming(message);
      });
    }
    if (replyListener) {
      this.sub.on('message', (_channel: string, message: string) => {
        this.handleReply(message);
      });
    }

    if (inbound) {
      const eventPattern = `${this.channelPrefix}.event.*`;
      const commandPattern = `${this.channelPrefix}.command.*`;
      await this.sub.psubscribe(eventPattern, commandPattern);
    }
    if (replyListener) {
      await this.sub.subscribe(this.replyChannelName());
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('RedisTransport stopped while an RPC was pending.'));
    }
    this.pending.clear();

    if (this.sub) {
      try {
        await this.sub.punsubscribe();
      } catch {
        // ignore — sub may already be torn down
      }
      try {
        await this.sub.unsubscribe();
      } catch {
        // ignore
      }
      this.sub.disconnect();
      this.sub = undefined;
    }
  }

  async send(env: Envelope): Promise<Envelope> {
    if (!this.started) {
      throw new Error('RedisTransport.send called before start().');
    }
    const replyTo = this.replyChannelName();
    const outgoing: Envelope<Message> = { ...env, replyTo } as Envelope<Message>;
    const channel = `${this.channelPrefix}.command.${env.messageType}`;
    const bytes = this.serializer.serialize(outgoing);

    return new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(env.messageId);
        reject(
          new Error(
            `RedisTransport RPC for "${env.messageType}" timed out after ${this.rpcTimeoutMs}ms.`,
          ),
        );
      }, this.rpcTimeoutMs);
      this.pending.set(env.messageId, {
        resolve: resolve as (e: Envelope<Message>) => void,
        reject,
        timer,
      });
      this.pub.publish(channel, bytes as string).catch((err: Error) => {
        clearTimeout(timer);
        this.pending.delete(env.messageId);
        reject(err);
      });
    });
  }

  async publish(env: Envelope): Promise<void> {
    if (!this.started) {
      throw new Error('RedisTransport.publish called before start().');
    }
    const channel = `${this.channelPrefix}.event.${env.messageType}`;
    const bytes = this.serializer.serialize(env as Envelope<Message>);
    await this.pub.publish(channel, bytes as string);
  }

  private replyChannelName(): string {
    return `${this.channelPrefix}.reply.${this.instanceId}`;
  }

  private async handleIncoming(raw: string): Promise<void> {
    if (!this.inbound) return;
    let env: Envelope<Message>;
    try {
      env = this.serializer.deserialize(raw, this.registry);
    } catch (err) {
      this.errorHandler(toError(err), { transport: this.name, phase: 'deserialize' });
      return;
    }
    let reply: Envelope | void;
    try {
      reply = await this.inbound(env);
    } catch (err) {
      this.errorHandler(toError(err), {
        transport: this.name,
        phase: 'dispatch',
        envelope: env,
        messageType: env.messageType,
      });
      return;
    }
    if (reply && env.replyTo) {
      try {
        const replyBytes = this.serializer.serialize(reply as Envelope<Message>);
        await this.pub.publish(env.replyTo, replyBytes as string);
      } catch (err) {
        this.errorHandler(toError(err), {
          transport: this.name,
          phase: 'publish-reply',
          envelope: env,
          messageType: env.messageType,
        });
      }
    }
  }

  private handleReply(raw: string): void {
    let env: Envelope<Message>;
    try {
      env = this.serializer.deserialize(raw, this.registry);
    } catch (err) {
      this.errorHandler(toError(err), { transport: this.name, phase: 'deserialize' });
      return;
    }
    const correlationId = env.correlationId;
    if (!correlationId) return;
    const pending = this.pending.get(correlationId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(correlationId);
    pending.resolve(env);
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
