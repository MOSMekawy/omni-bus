import type { Envelope, ISerializer, Message } from '@omni-bus/core';
import { RabbitMQTransport } from './rabbitmq-transport';

interface CaptureBuckets {
  consumeCalls: Array<{ queue: string; callback: (msg: AmqpMsg | null) => void; opts?: unknown }>;
  publishCalls: Array<{
    exchange: string;
    routingKey: string;
    content: Buffer;
    options?: { replyTo?: string; correlationId?: string };
  }>;
}

interface AmqpMsg {
  content: Buffer;
  properties: { replyTo?: string; correlationId?: string };
}

const buckets: CaptureBuckets = { consumeCalls: [], publishCalls: [] };

const channelStub = {
  assertExchange: jest.fn().mockResolvedValue({}),
  assertQueue: jest.fn().mockImplementation((name: string) =>
    Promise.resolve({ queue: name || 'amq.gen-x' }),
  ),
  bindQueue: jest.fn().mockResolvedValue({}),
  publish: jest
    .fn()
    .mockImplementation(
      (exchange: string, routingKey: string, content: Buffer, options?: unknown) => {
        buckets.publishCalls.push({ exchange, routingKey, content, options: options as never });
        return true;
      },
    ),
  consume: jest.fn().mockImplementation((queue: string, callback: (msg: AmqpMsg | null) => void, opts?: unknown) => {
    buckets.consumeCalls.push({ queue, callback, opts });
    return Promise.resolve({ consumerTag: 'tag-1' });
  }),
  ack: jest.fn(),
  nack: jest.fn(),
  prefetch: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
};

const connectionStub = {
  createChannel: jest.fn().mockResolvedValue(channelStub),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.mock('amqplib', () => ({
  connect: jest.fn().mockImplementation(() => Promise.resolve(connectionStub)),
}));

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

describe('RabbitMQTransport', () => {
  let transport: RabbitMQTransport;

  beforeEach(() => {
    jest.clearAllMocks();
    buckets.consumeCalls = [];
    buckets.publishCalls = [];
    transport = RabbitMQTransport.create({
      url: 'amqp://localhost',
      serializer: new StubSerializer(),
      exchangeName: 'omni.exchange',
    });
  });

  afterEach(async () => {
    await transport.stop().catch(() => undefined);
  });

  it('exposes the static identity "rabbitmq"', () => {
    expect(transport.name).toBe('rabbitmq');
  });

  it('declares request/reply + broadcast + durability, no scheduling', () => {
    expect(transport.capabilities).toEqual({
      supportsRequestReply: true,
      supportsBroadcast: true,
      supportsScheduling: false,
      supportsDurability: true,
    });
  });

  it('start() connects, opens a channel, and asserts the topic exchange', async () => {
    await transport.start();
    expect(connectionStub.createChannel).toHaveBeenCalled();
    expect(channelStub.assertExchange).toHaveBeenCalledWith(
      'omni.exchange',
      'topic',
      expect.objectContaining({ durable: true }),
    );
  });

  it('start() consumes from the per-instance queue and the reply pseudo-queue', async () => {
    await transport.start();
    const queues = buckets.consumeCalls.map((c) => c.queue);
    expect(queues).toEqual(expect.arrayContaining([expect.any(String), 'amq.rabbitmq.reply-to']));
  });

  it('publish() sends to the exchange with routing key "event.<type>" and serialized envelope', async () => {
    await transport.start();
    const env = envelopeOf('OrderPlaced', 'event', { orderId: 'o-1' });
    await transport.publish(env);

    const call = buckets.publishCalls.find((c) => c.routingKey === 'event.OrderPlaced');
    expect(call).toBeDefined();
    expect(call!.exchange).toBe('omni.exchange');
    const parsed = JSON.parse(call!.content.toString('utf-8'));
    expect(parsed.messageType).toBe('OrderPlaced');
    expect(parsed.kind).toBe('event');
  });

  it('send() publishes with routing key "command.<type>", replyTo, and correlationId', async () => {
    await transport.start();
    const cmd = envelopeOf('CreateOrder', 'command', { id: 'o-1' });
    // Swallow eventual rejection: afterEach's stop() will reject this pending
    // RPC, which would otherwise become a late unhandled rejection that Jest
    // attributes to the next test.
    transport.send(cmd).catch(() => undefined);

    await new Promise((r) => setImmediate(r));
    const call = buckets.publishCalls.find((c) => c.routingKey === 'command.CreateOrder');
    expect(call).toBeDefined();
    expect(call!.options?.replyTo).toBe('amq.rabbitmq.reply-to');
    expect(call!.options?.correlationId).toBe(cmd.messageId);
  });

  it('send() resolves with the reply envelope when one arrives matching the correlationId', async () => {
    await transport.start();
    const cmd = envelopeOf('CreateOrder', 'command', { id: 'o-1' });
    const pending = transport.send(cmd);
    await new Promise((r) => setImmediate(r));

    const replyConsume = buckets.consumeCalls.find((c) => c.queue === 'amq.rabbitmq.reply-to');
    expect(replyConsume).toBeDefined();

    const replyEnv: Envelope<Message> = {
      ...envelopeOf('CreateOrder.reply', 'command', { ok: true }),
      correlationId: cmd.messageId,
    };
    replyConsume!.callback({
      content: Buffer.from(JSON.stringify(replyEnv), 'utf-8'),
      properties: { correlationId: cmd.messageId },
    });

    const result = await pending;
    expect(result.messageType).toBe('CreateOrder.reply');
    expect((result.payload as { ok: boolean }).ok).toBe(true);
  });

  it('send() rejects with a timeout error when no reply arrives in rpcTimeoutMs', async () => {
    transport = RabbitMQTransport.create({
      url: 'amqp://localhost',
      serializer: new StubSerializer(),
      exchangeName: 'omni.exchange',
      rpcTimeoutMs: 30,
    });
    await transport.start();
    await expect(transport.send(envelopeOf('NoReply', 'command', {}))).rejects.toThrow(/timed out/i);
  });

  it('onMessage() is invoked when an inbound delivery arrives on the bound queue', async () => {
    const seen: Envelope[] = [];
    transport.onMessage(async (env) => {
      seen.push(env);
      return undefined;
    });
    await transport.start();

    const queueConsume = buckets.consumeCalls.find((c) => c.queue !== 'amq.rabbitmq.reply-to');
    expect(queueConsume).toBeDefined();

    const env = envelopeOf('OrderPlaced', 'event', { orderId: 'o-3' });
    queueConsume!.callback({
      content: Buffer.from(JSON.stringify(env), 'utf-8'),
      properties: {},
    });
    await new Promise((r) => setImmediate(r));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.messageType).toBe('OrderPlaced');
  });

  it('inbound delivery with replyTo + correlationId triggers a reply publish back', async () => {
    transport.onMessage(async (env) => ({
      ...envelopeOf(`${env.messageType}.reply`, 'command', { ok: true }),
      correlationId: env.messageId,
    }));
    await transport.start();

    const queueConsume = buckets.consumeCalls.find((c) => c.queue !== 'amq.rabbitmq.reply-to');
    const incoming = envelopeOf('CreateOrder', 'command', { id: 'x' });
    queueConsume!.callback({
      content: Buffer.from(JSON.stringify(incoming), 'utf-8'),
      properties: { replyTo: 'amq.rabbitmq.reply-to', correlationId: incoming.messageId },
    });
    await new Promise((r) => setImmediate(r));

    const replyPublish = buckets.publishCalls.find((c) => c.options?.correlationId === incoming.messageId);
    expect(replyPublish).toBeDefined();
    expect(replyPublish!.options?.correlationId).toBe(incoming.messageId);
  });

  it('stop() closes the channel and connection', async () => {
    await transport.start();
    await transport.stop();
    expect(channelStub.close).toHaveBeenCalled();
    expect(connectionStub.close).toHaveBeenCalled();
  });

  describe('ack/nack semantics', () => {
    it('ack() is called after a successful inbound dispatch', async () => {
      transport.onMessage(async () => undefined);
      await transport.start();
      const queueConsume = buckets.consumeCalls.find((c) => c.queue !== 'amq.rabbitmq.reply-to');
      const msg = {
        content: Buffer.from(
          JSON.stringify(envelopeOf('OrderPlaced', 'event', {})),
          'utf-8',
        ),
        properties: {},
      };
      queueConsume!.callback(msg);
      await new Promise((r) => setImmediate(r));
      expect(channelStub.ack).toHaveBeenCalledWith(msg);
    });

    it('nack(requeue=false) is called when deserialization fails', async () => {
      transport.onMessage(async () => undefined);
      await transport.start();
      const queueConsume = buckets.consumeCalls.find((c) => c.queue !== 'amq.rabbitmq.reply-to');
      const msg = { content: Buffer.from('not-json'), properties: {} };
      queueConsume!.callback(msg);
      await new Promise((r) => setImmediate(r));
      expect(channelStub.nack).toHaveBeenCalledWith(msg, false, false);
      expect(channelStub.ack).not.toHaveBeenCalled();
    });

    it('ack() is still called when the inbound handler throws (event semantics — at-most-once)', async () => {
      transport.onMessage(async () => {
        throw new Error('handler exploded');
      });
      await transport.start();
      const queueConsume = buckets.consumeCalls.find((c) => c.queue !== 'amq.rabbitmq.reply-to');
      const msg = {
        content: Buffer.from(
          JSON.stringify(envelopeOf('OrderPlaced', 'event', {})),
          'utf-8',
        ),
        properties: {},
      };
      queueConsume!.callback(msg);
      await new Promise((r) => setImmediate(r));
      expect(channelStub.ack).toHaveBeenCalledWith(msg);
    });
  });

  describe('error handler', () => {
    it('init().onError is invoked when the inbound handler throws', async () => {
      const errors: Array<{ msg: string }> = [];
      transport.init?.({
        typeRegistry: new (await import('@omni-bus/core')).TypeRegistry(),
        onError: (err) => errors.push({ msg: err.message }),
      });
      transport.onMessage(async () => {
        throw new Error('boom');
      });
      await transport.start();
      const queueConsume = buckets.consumeCalls.find((c) => c.queue !== 'amq.rabbitmq.reply-to');
      queueConsume!.callback({
        content: Buffer.from(JSON.stringify(envelopeOf('Evt', 'event', {})), 'utf-8'),
        properties: {},
      });
      await new Promise((r) => setImmediate(r));
      expect(errors).toHaveLength(1);
      expect(errors[0]!.msg).toBe('boom');
    });

    it('init().onError is invoked on deserialization failure', async () => {
      const errors: Error[] = [];
      transport.init?.({
        typeRegistry: new (await import('@omni-bus/core')).TypeRegistry(),
        onError: (err) => errors.push(err),
      });
      transport.onMessage(async () => undefined);
      await transport.start();
      const queueConsume = buckets.consumeCalls.find((c) => c.queue !== 'amq.rabbitmq.reply-to');
      queueConsume!.callback({ content: Buffer.from('not-json'), properties: {} });
      await new Promise((r) => setImmediate(r));
      expect(errors).toHaveLength(1);
    });
  });

  describe('conditional wiring via start() options', () => {
    it('start({ inbound: false, replyListener: false }) asserts the exchange but consumes nothing', async () => {
      await transport.start({ inbound: false, replyListener: false });
      expect(channelStub.assertExchange).toHaveBeenCalled();
      expect(buckets.consumeCalls).toHaveLength(0);
    });

    it('start({ inbound: false, replyListener: true }) consumes only from the reply pseudo-queue', async () => {
      await transport.start({ inbound: false, replyListener: true });
      expect(buckets.consumeCalls).toHaveLength(1);
      expect(buckets.consumeCalls[0]!.queue).toBe('amq.rabbitmq.reply-to');
    });

    it('start({ inbound: true, replyListener: false }) consumes from the bound queue but not the reply', async () => {
      await transport.start({ inbound: true, replyListener: false });
      expect(buckets.consumeCalls).toHaveLength(1);
      expect(buckets.consumeCalls[0]!.queue).not.toBe('amq.rabbitmq.reply-to');
    });
  });
});
