import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import {
  type Constructor,
  type Envelope,
  type ISerializer,
  type Message,
  TypeRegistry,
} from '@omni-bus/core';
import { BullMQTransport } from './bullmq-transport';

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
      const hydrated = Object.assign(
        Object.create((Ctor as unknown as { prototype: object }).prototype),
        parsed.payload as object,
      );
      return { ...parsed, payload: hydrated as Message };
    }
    return parsed as Envelope<Message>;
  }
}

function envelopeOf(messageType: string, kind: 'command' | 'event', payload: unknown): Envelope<Message> {
  return {
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    messageType,
    kind,
    timestamp: new Date().toISOString(),
    headers: {},
    payload: payload as Message,
  };
}

maybeDescribe('BullMQTransport (integration, real Redis via testcontainers)', () => {
  let container: StartedTestContainer;
  let host: string;
  let port: number;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();
    host = container.getHost();
    port = container.getMappedPort(6379);
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  }, 30_000);

  function makeTransport(queueName: string): BullMQTransport {
    return BullMQTransport.create({
      connection: { host, port, maxRetriesPerRequest: null },
      serializer: new JsonSerializer(),
      queueName,
      rpcTimeoutMs: 5_000,
    });
  }

  it('round-trips an event through a real BullMQ queue + worker', async () => {
    const queueName = `omni-bus-events-${Date.now()}`;
    const producer = makeTransport(queueName);
    const worker = makeTransport(queueName);

    const received: Envelope[] = [];
    worker.onMessage(async (env) => {
      received.push(env);
      return undefined;
    });

    try {
      await worker.start();
      await producer.start();

      await producer.publish(envelopeOf('OrderPlaced', 'event', { orderId: 'o-1' }));

      // Worker polling takes a moment
      const deadline = Date.now() + 5_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(received).toHaveLength(1);
      expect(received[0]!.messageType).toBe('OrderPlaced');
      expect((received[0]!.payload as { orderId: string }).orderId).toBe('o-1');
    } finally {
      await worker.stop().catch(() => undefined);
      await producer.stop().catch(() => undefined);
    }
  }, 30_000);

  it('round-trips a command-reply RPC via job.waitUntilFinished', async () => {
    const queueName = `omni-bus-commands-${Date.now()}`;
    const producer = makeTransport(queueName);
    const worker = makeTransport(queueName);

    worker.onMessage(async (env) => ({
      ...envelopeOf('CreateOrder.reply', 'command', { ok: true, originalId: env.messageId }),
      correlationId: env.messageId,
    }));

    try {
      await worker.start();
      await producer.start();

      const cmd = envelopeOf('CreateOrder', 'command', { id: 'o-1' });
      const reply = await producer.send(cmd);

      expect(reply.messageType).toBe('CreateOrder.reply');
      expect((reply.payload as { ok: boolean }).ok).toBe(true);
    } finally {
      await worker.stop().catch(() => undefined);
      await producer.stop().catch(() => undefined);
    }
  }, 30_000);
});
