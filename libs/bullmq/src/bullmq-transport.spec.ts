import type { Envelope, ISerializer, Message } from '@omni-bus/core';
import type { Job } from 'bullmq';
import { BullMQTransport } from './bullmq-transport';

// Mock the BullMQ module surface we depend on. We capture instances and
// invocations so the tests can drive the worker processor directly.
const queueAddMock = jest.fn();
const queueCloseMock = jest.fn().mockResolvedValue(undefined);
const workerCloseMock = jest.fn().mockResolvedValue(undefined);
const queueEventsCloseMock = jest.fn().mockResolvedValue(undefined);

let lastQueueOpts: unknown;
let lastWorkerProcessor: ((job: unknown) => Promise<unknown>) | undefined;
let lastWorkerOpts: unknown;
let lastQueueEventsOpts: unknown;

jest.mock('bullmq', () => {
  class MockQueue {
    constructor(public readonly name: string, opts: unknown) {
      lastQueueOpts = opts;
    }
    add(...args: unknown[]): Promise<unknown> {
      return queueAddMock(...args);
    }
    close(): Promise<void> {
      return queueCloseMock();
    }
  }
  class MockWorker {
    constructor(
      public readonly name: string,
      processor: (job: unknown) => Promise<unknown>,
      opts: unknown,
    ) {
      lastWorkerProcessor = processor;
      lastWorkerOpts = opts;
    }
    close(): Promise<void> {
      return workerCloseMock();
    }
  }
  class MockQueueEvents {
    constructor(public readonly name: string, opts: unknown) {
      lastQueueEventsOpts = opts;
    }
    close(): Promise<void> {
      return queueEventsCloseMock();
    }
  }
  return { Queue: MockQueue, Worker: MockWorker, QueueEvents: MockQueueEvents };
});

class StubSerializer implements ISerializer {
  readonly contentType = 'application/json';
  serialize(env: Envelope<Message>): string {
    return JSON.stringify(env);
  }
  deserialize(bytes: Buffer | string): Envelope<Message> {
    const text = typeof bytes === 'string' ? bytes : bytes.toString('utf-8');
    return JSON.parse(text) as Envelope<Message>;
  }
}

function envelopeOf(messageType: string, kind: 'command' | 'event', payload: unknown): Envelope<Message> {
  return {
    messageId: `id-${Math.random()}`,
    messageType,
    kind,
    timestamp: new Date().toISOString(),
    headers: {},
    payload: payload as Message,
  };
}

describe('BullMQTransport', () => {
  let transport: BullMQTransport;

  beforeEach(() => {
    jest.clearAllMocks();
    lastWorkerProcessor = undefined;
    lastQueueOpts = undefined;
    lastWorkerOpts = undefined;
    lastQueueEventsOpts = undefined;
    transport = BullMQTransport.create({
      connection: { host: 'localhost', port: 6379 },
      serializer: new StubSerializer(),
      queueName: 'jobs-test',
    });
  });

  afterEach(async () => {
    await transport.stop().catch(() => undefined);
  });

  it('exposes the static identity "bullmq"', () => {
    expect(transport.name).toBe('bullmq');
  });

  it('declares request/reply + scheduling + durability, no broadcast', () => {
    expect(transport.capabilities).toEqual({
      supportsRequestReply: true,
      supportsBroadcast: false,
      supportsScheduling: true,
      supportsDurability: true,
    });
  });

  it('start() instantiates a Queue, Worker, and QueueEvents and propagates the connection', async () => {
    await transport.start();
    expect(lastQueueOpts).toMatchObject({ connection: { host: 'localhost', port: 6379 } });
    expect(lastWorkerOpts).toMatchObject({ connection: { host: 'localhost', port: 6379 } });
    expect(lastQueueEventsOpts).toMatchObject({ connection: { host: 'localhost', port: 6379 } });
    expect(typeof lastWorkerProcessor).toBe('function');
  });

  it('stop() closes the Queue, Worker, and QueueEvents', async () => {
    await transport.start();
    await transport.stop();
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueEventsCloseMock).toHaveBeenCalledTimes(1);
  });

  it('publish() adds a job with name=messageType and serialized envelope as data', async () => {
    queueAddMock.mockResolvedValueOnce({ id: 'job-1' });
    await transport.start();
    const env = envelopeOf('OrderPlaced', 'event', { orderId: 'o-1' });

    await transport.publish(env);

    expect(queueAddMock).toHaveBeenCalledTimes(1);
    const [name, data] = queueAddMock.mock.calls[0]!;
    expect(name).toBe('OrderPlaced');
    expect(typeof data).toBe('object');
    expect(typeof (data as { bytes: string }).bytes).toBe('string');
    const parsed = JSON.parse((data as { bytes: string }).bytes);
    expect(parsed.messageType).toBe('OrderPlaced');
  });

  it('send() adds a job and resolves with the deserialized reply from waitUntilFinished', async () => {
    const reply = envelopeOf('CreateOrder.reply', 'command', { ok: true });
    queueAddMock.mockResolvedValueOnce({
      id: 'job-2',
      waitUntilFinished: jest.fn().mockResolvedValue({ bytes: JSON.stringify(reply) }),
    });
    await transport.start();
    const cmd = envelopeOf('CreateOrder', 'command', { id: 'o-1' });

    const result = await transport.send(cmd);

    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(result.messageType).toBe('CreateOrder.reply');
    expect((result.payload as { ok: boolean }).ok).toBe(true);
  });

  it('the worker processor deserializes the job, calls onMessage, and returns the serialized reply', async () => {
    const inboundEnv = envelopeOf('CreateOrder', 'command', { id: 'o-2' });
    const replyEnv = envelopeOf('CreateOrder.reply', 'command', { ok: true });

    transport.onMessage(async (env) => {
      expect(env.messageType).toBe('CreateOrder');
      return replyEnv;
    });
    await transport.start();
    expect(lastWorkerProcessor).toBeDefined();

    const fakeJob: Pick<Job, 'data' | 'name'> = {
      data: { bytes: JSON.stringify(inboundEnv) },
      name: 'CreateOrder',
    };
    const result = await lastWorkerProcessor!(fakeJob);
    const parsed = JSON.parse((result as { bytes: string }).bytes);
    expect(parsed.messageType).toBe('CreateOrder.reply');
  });

  it('the worker processor returns undefined when onMessage returns undefined (event case)', async () => {
    transport.onMessage(async () => undefined);
    await transport.start();
    const evt = envelopeOf('OrderPlaced', 'event', {});
    const result = await lastWorkerProcessor!({ data: { bytes: JSON.stringify(evt) }, name: 'OrderPlaced' });
    expect(result).toBeUndefined();
  });

  describe('error handler', () => {
    it('init().onError is invoked when the inbound handler throws on an event job', async () => {
      const errors: Error[] = [];
      transport.init?.({
        typeRegistry: new (await import('@omni-bus/core')).TypeRegistry(),
        onError: (err) => errors.push(err),
      });
      transport.onMessage(async () => {
        throw new Error('handler exploded');
      });
      await transport.start();
      const evt = envelopeOf('OrderPlaced', 'event', {});
      const result = await lastWorkerProcessor!({
        data: { bytes: JSON.stringify(evt) },
        name: 'OrderPlaced',
      });
      // Processor MUST return undefined (not throw) so BullMQ does not retry —
      // otherwise all event handlers replay on every retry.
      expect(result).toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe('handler exploded');
    });

    it('init().onError is invoked on deserialization failure; processor returns undefined (no retry)', async () => {
      const errors: Error[] = [];
      transport.init?.({
        typeRegistry: new (await import('@omni-bus/core')).TypeRegistry(),
        onError: (err) => errors.push(err),
      });
      transport.onMessage(async () => undefined);
      await transport.start();
      const result = await lastWorkerProcessor!({
        data: { bytes: 'not-valid-json' },
        name: 'X',
      });
      expect(result).toBeUndefined();
      expect(errors).toHaveLength(1);
    });
  });

  describe('conditional wiring via start() options', () => {
    it('start({ inbound: false, replyListener: false }) creates only the Queue (no Worker, no QueueEvents)', async () => {
      await transport.start({ inbound: false, replyListener: false });
      expect(lastWorkerProcessor).toBeUndefined();
      expect(lastQueueEventsOpts).toBeUndefined();
    });

    it('start({ inbound: false, replyListener: true }) creates Queue + QueueEvents, no Worker', async () => {
      await transport.start({ inbound: false, replyListener: true });
      expect(lastWorkerProcessor).toBeUndefined();
      expect(lastQueueEventsOpts).toBeDefined();
    });

    it('start({ inbound: true, replyListener: false }) creates Queue + Worker, no QueueEvents', async () => {
      await transport.start({ inbound: true, replyListener: false });
      expect(lastWorkerProcessor).toBeDefined();
      expect(lastQueueEventsOpts).toBeUndefined();
    });
  });
});
