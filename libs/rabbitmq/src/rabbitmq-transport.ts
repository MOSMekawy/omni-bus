import * as amqp from 'amqplib';
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
} from '@omni-bus/core';

export interface RabbitMQTransportOptions {
  readonly url: string;
  readonly serializer: ISerializer;
  readonly exchangeName?: string;
  readonly queueName?: string;
  readonly rpcTimeoutMs?: number;
  /**
   * Per-consumer prefetch. Defaults to 32 — caps unacked messages in flight
   * to avoid pinning unbounded memory on the broker.
   */
  readonly prefetch?: number;
}

interface PendingRpc {
  resolve: (env: Envelope<Message>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

type AmqpMsg = {
  content: Buffer;
  properties: { replyTo?: string; correlationId?: string };
};

interface AmqpChannel {
  assertExchange(name: string, type: string, opts: { durable: boolean }): Promise<unknown>;
  assertQueue(name: string, opts?: { exclusive?: boolean }): Promise<{ queue: string }>;
  bindQueue(queue: string, exchange: string, pattern: string): Promise<unknown>;
  consume(
    queue: string,
    cb: (msg: AmqpMsg | null) => void,
    opts?: { noAck?: boolean },
  ): Promise<{ consumerTag: string }>;
  prefetch(count: number): Promise<unknown>;
  ack(msg: AmqpMsg): void;
  nack(msg: AmqpMsg, allUpTo?: boolean, requeue?: boolean): void;
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: { replyTo?: string; correlationId?: string },
  ): boolean;
  close(): Promise<void>;
}

interface AmqpConnection {
  createChannel(): Promise<AmqpChannel>;
  close(): Promise<void>;
}

const CAPABILITIES: TransportCapabilities = {
  supportsRequestReply: true,
  supportsBroadcast: true,
  supportsScheduling: false,
  supportsDurability: true,
};

const DIRECT_REPLY_QUEUE = 'amq.rabbitmq.reply-to';

const noopErrorHandler: TransportErrorHandler = () => undefined;

export class RabbitMQTransport implements ITransport {
  readonly name = 'rabbitmq';
  readonly capabilities: TransportCapabilities = CAPABILITIES;

  private readonly url: string;
  private readonly serializer: ISerializer;
  private readonly exchangeName: string;
  private readonly explicitQueueName?: string;
  private readonly rpcTimeoutMs: number;
  private readonly prefetchCount: number;
  private connection?: AmqpConnection;
  private channel?: AmqpChannel;
  private inboundQueueName?: string;
  private inbound?: InboundHandler;
  private registry: TypeRegistry = new TypeRegistry();
  private errorHandler: TransportErrorHandler = noopErrorHandler;
  private started = false;
  private readonly pending = new Map<string, PendingRpc>();

  static create(opts: RabbitMQTransportOptions): RabbitMQTransport {
    return new RabbitMQTransport(opts);
  }

  private constructor(opts: RabbitMQTransportOptions) {
    this.url = opts.url;
    this.serializer = opts.serializer;
    this.exchangeName = opts.exchangeName ?? 'omni-bus.exchange';
    this.explicitQueueName = opts.queueName;
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 30_000;
    this.prefetchCount = opts.prefetch ?? 32;
  }

  init(ctx: TransportInitContext): void {
    this.registry = ctx.typeRegistry;
    this.errorHandler = ctx.onError;
  }

  onMessage(handler: InboundHandler): void {
    // Idempotent per the ITransport contract.
    this.inbound = handler;
  }

  async start(options: TransportStartOptions = {}): Promise<void> {
    if (this.started) return;
    this.started = true;
    const replyListener = options.replyListener ?? true;
    const inbound = options.inbound ?? true;

    // Connection + channel + exchange are always needed for outbound publish.
    this.connection = (await amqp.connect(this.url)) as unknown as AmqpConnection;
    this.channel = await this.connection.createChannel();
    const ch = this.channel;

    await ch.assertExchange(this.exchangeName, 'topic', { durable: true });

    // Inbound: assert + bind + consume the per-instance queue.
    if (inbound) {
      // Limit unacked-in-flight to bound memory on the broker side.
      try {
        await ch.prefetch(this.prefetchCount);
      } catch {
        // Some amqplib mocks don't implement prefetch; non-fatal.
      }
      const q = await ch.assertQueue(this.explicitQueueName ?? '', {
        exclusive: !this.explicitQueueName,
      });
      this.inboundQueueName = q.queue;
      await ch.bindQueue(this.inboundQueueName, this.exchangeName, 'event.*');
      await ch.bindQueue(this.inboundQueueName, this.exchangeName, 'command.*');
      await ch.consume(this.inboundQueueName, (msg) => {
        if (msg) void this.handleInbound(msg);
      });
    }

    // Reply listener: consume the direct reply-to pseudo-queue for RPC replies.
    if (replyListener) {
      await ch.consume(
        DIRECT_REPLY_QUEUE,
        (msg) => {
          if (msg) this.handleReply(msg);
        },
        { noAck: true },
      );
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('RabbitMQTransport stopped while an RPC was pending.'));
    }
    this.pending.clear();
    try {
      await this.channel?.close();
    } catch {
      // ignore — channel may already be torn down
    }
    try {
      await this.connection?.close();
    } catch {
      // ignore
    }
    this.channel = undefined;
    this.connection = undefined;
  }

  async send(env: Envelope): Promise<Envelope> {
    if (!this.channel) throw new Error('RabbitMQTransport.send called before start().');
    const ch = this.channel;
    const bytes = this.serializer.serialize(env as Envelope<Message>);
    const content = Buffer.from(bytes as string, 'utf-8');
    const routingKey = `command.${env.messageType}`;
    return new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(env.messageId);
        reject(
          new Error(
            `RabbitMQTransport RPC for "${env.messageType}" timed out after ${this.rpcTimeoutMs}ms.`,
          ),
        );
      }, this.rpcTimeoutMs);
      this.pending.set(env.messageId, {
        resolve: resolve as (e: Envelope<Message>) => void,
        reject,
        timer,
      });
      try {
        ch.publish(this.exchangeName, routingKey, content, {
          replyTo: DIRECT_REPLY_QUEUE,
          correlationId: env.messageId,
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(env.messageId);
        reject(err as Error);
      }
    });
  }

  async publish(env: Envelope): Promise<void> {
    if (!this.channel) throw new Error('RabbitMQTransport.publish called before start().');
    const ch = this.channel;
    const bytes = this.serializer.serialize(env as Envelope<Message>);
    ch.publish(this.exchangeName, `event.${env.messageType}`, Buffer.from(bytes as string, 'utf-8'));
  }

  private async handleInbound(msg: AmqpMsg): Promise<void> {
    if (!this.inbound || !this.channel) return;
    const ch = this.channel;
    let env: Envelope<Message>;
    try {
      env = this.serializer.deserialize(msg.content, this.registry);
    } catch (err) {
      // Malformed message — ack so the broker doesn't redeliver it forever.
      this.errorHandler(toError(err), { transport: this.name, phase: 'deserialize' });
      try {
        ch.nack(msg, false, false);
      } catch {
        // ignore — channel may have been closed
      }
      return;
    }

    let reply: Envelope | void;
    try {
      reply = await this.inbound(env);
    } catch (err) {
      // Event handler error. Ack the message and report — at-most-once semantics
      // for this transport. (Commands return fault envelopes, never throw.)
      this.errorHandler(toError(err), {
        transport: this.name,
        phase: 'dispatch',
        envelope: env,
        messageType: env.messageType,
      });
      try {
        ch.ack(msg);
      } catch {
        // ignore
      }
      return;
    }

    if (reply && msg.properties.replyTo) {
      try {
        const bytes = this.serializer.serialize(reply as Envelope<Message>);
        ch.publish('', msg.properties.replyTo, Buffer.from(bytes as string, 'utf-8'), {
          correlationId: msg.properties.correlationId ?? env.messageId,
        });
      } catch (err) {
        this.errorHandler(toError(err), {
          transport: this.name,
          phase: 'publish-reply',
          envelope: env,
          messageType: env.messageType,
        });
      }
    }

    try {
      ch.ack(msg);
    } catch {
      // ignore
    }
  }

  private handleReply(msg: AmqpMsg): void {
    let env: Envelope<Message>;
    try {
      env = this.serializer.deserialize(msg.content, this.registry);
    } catch (err) {
      this.errorHandler(toError(err), { transport: this.name, phase: 'deserialize' });
      return;
    }
    const correlationId = msg.properties.correlationId ?? env.correlationId;
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
