import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import {
  type Constructor,
  type Envelope,
  type ISerializer,
  type Message,
  TypeRegistry,
} from '@omni-bus/core';
import { RabbitMQTransport } from './rabbitmq-transport';

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

maybeDescribe('RabbitMQTransport (integration, real RabbitMQ via testcontainers)', () => {
  let container: StartedTestContainer;
  let url: string;

  beforeAll(async () => {
    container = await new GenericContainer('rabbitmq:3.13-management-alpine')
      .withExposedPorts(5672, 15672)
      .withWaitStrategy(Wait.forLogMessage(/Server startup complete|started TCP listener/i))
      .withStartupTimeout(120_000)
      .start();
    const host = container.getHost();
    const port = container.getMappedPort(5672);
    url = `amqp://${host}:${port}`;
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  }, 30_000);

  function makeTransport(exchangeName: string): RabbitMQTransport {
    return RabbitMQTransport.create({
      url,
      serializer: new JsonSerializer(),
      exchangeName,
      rpcTimeoutMs: 5_000,
    });
  }

  it('delivers an event from producer to a subscribed consumer over a real RabbitMQ topic exchange', async () => {
    const exchangeName = `omni-bus-events-${Date.now()}`;
    const producer = makeTransport(exchangeName);
    const consumer = makeTransport(exchangeName);

    const received: Envelope[] = [];
    consumer.onMessage(async (env) => {
      received.push(env);
      return undefined;
    });

    try {
      await consumer.start();
      await producer.start();
      // Give the broker a moment to set up bindings.
      await new Promise((r) => setTimeout(r, 200));

      await producer.publish(envelopeOf('OrderPlaced', 'event', { orderId: 'o-1' }));

      const deadline = Date.now() + 5_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(received).toHaveLength(1);
      expect(received[0]!.messageType).toBe('OrderPlaced');
      expect((received[0]!.payload as { orderId: string }).orderId).toBe('o-1');
    } finally {
      await consumer.stop().catch(() => undefined);
      await producer.stop().catch(() => undefined);
    }
  }, 30_000);

  it('round-trips a command via AMQP direct reply-to RPC', async () => {
    const exchangeName = `omni-bus-commands-${Date.now()}`;
    const producer = makeTransport(exchangeName);
    const consumer = makeTransport(exchangeName);

    consumer.onMessage(async (env) => ({
      ...envelopeOf('CreateOrder.reply', 'command', { ok: true, originalId: env.messageId }),
      correlationId: env.messageId,
    }));

    try {
      await consumer.start();
      await producer.start();
      await new Promise((r) => setTimeout(r, 200));

      const cmd = envelopeOf('CreateOrder', 'command', { id: 'o-1' });
      const reply = await producer.send(cmd);

      expect(reply.messageType).toBe('CreateOrder.reply');
      expect((reply.payload as { ok: boolean }).ok).toBe(true);
    } finally {
      await consumer.stop().catch(() => undefined);
      await producer.stop().catch(() => undefined);
    }
  }, 30_000);
});
