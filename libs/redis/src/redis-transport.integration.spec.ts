import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import {
  type Constructor,
  type Envelope,
  type ISerializer,
  type Message,
  TypeRegistry,
} from '@omni-bus/core';
import { RedisTransport } from './redis-transport';

const maybeDescribe = process.env.INTEGRATION ? describe : describe.skip;

class JsonSerializer implements ISerializer {
  readonly contentType = 'application/json';
  serialize(env: Envelope<Message>): string {
    return JSON.stringify(env);
  }
  deserialize(bytes: Buffer | string, registry: TypeRegistry): Envelope<Message> {
    const text = typeof bytes === 'string' ? bytes : bytes.toString('utf-8');
    const parsed = JSON.parse(text) as Envelope<Message> & { payload: unknown };
    const Ctor = registry.getByName(parsed.messageType) as Constructor<Message> | undefined;
    if (Ctor) {
      const hydrated = Object.assign(Object.create((Ctor as unknown as { prototype: object }).prototype), parsed.payload as object);
      return { ...parsed, payload: hydrated as Message };
    }
    return parsed as Envelope<Message>;
  }
}

function envelopeOf(
  messageType: string,
  kind: 'command' | 'event',
  payload: unknown,
  overrides: Partial<Envelope<Message>> = {},
): Envelope<Message> {
  return {
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    messageType,
    kind,
    timestamp: new Date().toISOString(),
    headers: {},
    payload: payload as Message,
    ...overrides,
  };
}

maybeDescribe('RedisTransport (integration, real Redis via testcontainers)', () => {
  let container: StartedTestContainer;
  let producer: RedisTransport;
  let consumer: RedisTransport;
  let producerClient: Redis;
  let consumerClient: Redis;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  }, 30_000);

  beforeEach(() => {
    const host = container.getHost();
    const port = container.getMappedPort(6379);
    producerClient = new Redis({ host, port, maxRetriesPerRequest: null });
    consumerClient = new Redis({ host, port, maxRetriesPerRequest: null });
    producer = RedisTransport.create({
      client: producerClient,
      serializer: new JsonSerializer(),
      instanceId: 'producer',
      rpcTimeoutMs: 5_000,
    });
    consumer = RedisTransport.create({
      client: consumerClient,
      serializer: new JsonSerializer(),
      instanceId: 'consumer',
      rpcTimeoutMs: 5_000,
    });
  });

  afterEach(async () => {
    await producer?.stop().catch(() => undefined);
    await consumer?.stop().catch(() => undefined);
    producerClient?.disconnect();
    consumerClient?.disconnect();
  });

  it('delivers an event from publisher to a subscribed consumer over real Redis pub/sub', async () => {
    const received: Envelope[] = [];
    consumer.onMessage(async (env) => {
      received.push(env);
      return undefined;
    });
    await consumer.start();
    await producer.start();

    // Wait for the consumer's subscription handshake to complete on the broker.
    await new Promise((r) => setTimeout(r, 100));

    await producer.publish(envelopeOf('OrderPlaced', 'event', { orderId: 'o-1' }));

    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(1);
    expect(received[0]!.messageType).toBe('OrderPlaced');
    expect((received[0]!.payload as { orderId: string }).orderId).toBe('o-1');
  });

  it('round-trips a command-reply RPC across two Redis-backed transports', async () => {
    consumer.onMessage(async (env) => ({
      ...envelopeOf('CreateOrder.reply', 'command', { ok: true, originalId: env.messageId }),
      correlationId: env.messageId,
    }));
    await consumer.start();
    await producer.start();
    await new Promise((r) => setTimeout(r, 100));

    const cmd = envelopeOf('CreateOrder', 'command', { id: 'o-1' });
    const reply = await producer.send(cmd);

    expect(reply.messageType).toBe('CreateOrder.reply');
    expect(reply.correlationId).toBe(cmd.messageId);
    expect((reply.payload as { ok: boolean }).ok).toBe(true);
  });

  it('times out a send when no consumer replies', async () => {
    // Consumer is never started — nothing will reply on the command channel.
    await producer.start();
    const cmd = envelopeOf('Unanswered', 'command', {});
    await expect(producer.send(cmd)).rejects.toThrow(/timed out/i);
  }, 10_000);
});
