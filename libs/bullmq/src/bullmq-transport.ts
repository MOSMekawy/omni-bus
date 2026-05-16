import { Queue, QueueEvents, Worker } from 'bullmq';
import type { ConnectionOptions, Job, JobsOptions } from 'bullmq';
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

export interface BullMQTransportOptions {
  readonly connection: ConnectionOptions;
  readonly serializer: ISerializer;
  readonly queueName?: string;
  readonly rpcTimeoutMs?: number;
  readonly defaultJobOptions?: JobsOptions;
  /**
   * Worker concurrency. Defaults to 1 — set higher to process multiple jobs
   * in parallel within a single worker process.
   */
  readonly concurrency?: number;
}

interface JobPayload {
  bytes: string;
}

const CAPABILITIES: TransportCapabilities = {
  supportsRequestReply: true,
  supportsBroadcast: false,
  supportsScheduling: true,
  supportsDurability: true,
};

const noopErrorHandler: TransportErrorHandler = () => undefined;

export class BullMQTransport implements ITransport {
  readonly name = 'bullmq';
  readonly capabilities: TransportCapabilities = CAPABILITIES;

  private readonly connection: ConnectionOptions;
  private readonly serializer: ISerializer;
  private readonly queueName: string;
  private readonly rpcTimeoutMs: number;
  private readonly defaultJobOptions?: JobsOptions;
  private readonly concurrency: number;
  private queue?: Queue;
  private worker?: Worker;
  private queueEvents?: QueueEvents;
  private inbound?: InboundHandler;
  private registry: TypeRegistry = new TypeRegistry();
  private errorHandler: TransportErrorHandler = noopErrorHandler;
  private started = false;

  static create(opts: BullMQTransportOptions): BullMQTransport {
    return new BullMQTransport(opts);
  }

  private constructor(opts: BullMQTransportOptions) {
    this.connection = opts.connection;
    this.serializer = opts.serializer;
    this.queueName = opts.queueName ?? 'omni-bus-jobs';
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 30_000;
    this.defaultJobOptions = opts.defaultJobOptions;
    this.concurrency = opts.concurrency ?? 1;
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

    // Queue is always needed for outbound publish/send.
    this.queue = new Queue(this.queueName, { connection: this.connection });
    // QueueEvents is needed to await job.waitUntilFinished (RPC replies).
    if (replyListener) {
      this.queueEvents = new QueueEvents(this.queueName, { connection: this.connection });
    }
    // Worker is needed only for processes that handle inbound jobs.
    if (inbound) {
      this.worker = new Worker(
        this.queueName,
        async (job: Job<JobPayload>) => this.processJob(job),
        { connection: this.connection, concurrency: this.concurrency },
      );
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await Promise.allSettled([
      this.worker?.close(),
      this.queueEvents?.close(),
      this.queue?.close(),
    ]);
    this.worker = undefined;
    this.queueEvents = undefined;
    this.queue = undefined;
  }

  async send(env: Envelope): Promise<Envelope> {
    if (!this.queue || !this.queueEvents) {
      throw new Error('BullMQTransport.send called before start().');
    }
    const bytes = this.serializer.serialize(env as Envelope<Message>);
    const job = await this.queue.add(
      env.messageType,
      { bytes: bytes as string },
      this.defaultJobOptions,
    );
    const result = (await job.waitUntilFinished(this.queueEvents, this.rpcTimeoutMs)) as
      | JobPayload
      | undefined;
    if (!result) {
      throw new Error(`BullMQTransport RPC for "${env.messageType}" returned no reply.`);
    }
    return this.serializer.deserialize(result.bytes, this.registry);
  }

  async publish(env: Envelope): Promise<void> {
    if (!this.queue) {
      throw new Error('BullMQTransport.publish called before start().');
    }
    const bytes = this.serializer.serialize(env as Envelope<Message>);
    await this.queue.add(env.messageType, { bytes: bytes as string }, this.defaultJobOptions);
  }

  private async processJob(
    job: Pick<Job<JobPayload>, 'data' | 'name'>,
  ): Promise<JobPayload | undefined> {
    if (!this.inbound) return undefined;
    let env: Envelope<Message>;
    try {
      env = this.serializer.deserialize(job.data.bytes, this.registry);
    } catch (err) {
      // Malformed payloads will never succeed on retry. Report and complete
      // the job so BullMQ moves on rather than retrying forever.
      this.errorHandler(toError(err), { transport: this.name, phase: 'deserialize' });
      return undefined;
    }
    try {
      const reply = await this.inbound(env);
      if (!reply) return undefined;
      return { bytes: this.serializer.serialize(reply as Envelope<Message>) as string };
    } catch (err) {
      // Event handler errors land here (commands return fault envelopes).
      // Completing successfully avoids replaying ALL handlers on retry —
      // see the BullMQ README for the durability/idempotence tradeoff.
      this.errorHandler(toError(err), {
        transport: this.name,
        phase: 'dispatch',
        envelope: env,
        messageType: env.messageType,
      });
      return undefined;
    }
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
