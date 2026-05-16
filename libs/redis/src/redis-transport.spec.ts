import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { Envelope, ISerializer, Message } from '@omni-bus/core';
import { TypeRegistry } from '@omni-bus/core';
import { RedisTransport } from './redis-transport';

type MockRedis = InstanceType<typeof RedisMock>;

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

function makeTransport(
  client: MockRedis,
  opts: { rpcTimeoutMs?: number; channelPrefix?: string } = {},
): RedisTransport {
  return RedisTransport.create({
    client: client as unknown as Redis,
    serializer: new StubSerializer(),
    ...opts,
  });
}

describe('RedisTransport', () => {
  let client: MockRedis;
  let transport: RedisTransport;

  beforeEach(() => {
    client = new RedisMock();
    transport = makeTransport(client);
  });

  afterEach(async () => {
    await transport.stop().catch(() => undefined);
    client.disconnect();
  });

  it('exposes the static identity "redis"', () => {
    expect(transport.name).toBe('redis');
  });

  it('declares request/reply, broadcast, no scheduling, no durability', () => {
    expect(transport.capabilities).toEqual({
      supportsRequestReply: true,
      supportsBroadcast: true,
      supportsScheduling: false,
      supportsDurability: false,
    });
  });

  it('init() accepts the bus context without throwing', async () => {
    const registry = new TypeRegistry();
    await expect(
      Promise.resolve(transport.init?.({ typeRegistry: registry, onError: () => undefined })),
    ).resolves.toBeUndefined();
  });

  it('publish() delivers the serialized envelope to a separate subscriber on the events channel', async () => {
    await transport.start();
    const observer = client.duplicate();
    const messageType = 'OrderPlaced';
    const received = new Promise<string>((resolve) => {
      observer.on('message', (_ch: string, msg: string) => resolve(msg));
      observer.subscribe(`omni-bus.event.${messageType}`);
    });
    await new Promise((r) => setTimeout(r, 20));

    const env = envelopeOf(messageType, 'event', { orderId: 'o-1' });
    await transport.publish(env);

    const raw = await received;
    const parsed = JSON.parse(raw) as Envelope;
    expect(parsed.messageType).toBe(messageType);
    expect(parsed.kind).toBe('event');
    expect((parsed.payload as { orderId: string }).orderId).toBe('o-1');
    observer.disconnect();
  });

  it('onMessage() is invoked when an event arrives on the events channel', async () => {
    const received: Envelope[] = [];
    transport.onMessage(async (env) => {
      received.push(env);
      return undefined;
    });
    await transport.start();

    const peerClient = client.duplicate();
    const env = envelopeOf('OrderPlaced', 'event', { orderId: 'o-2' });
    await peerClient.publish('omni-bus.event.OrderPlaced', new StubSerializer().serialize(env) as string);
    peerClient.disconnect();

    await new Promise((r) => setTimeout(r, 40));
    expect(received).toHaveLength(1);
    expect(received[0]!.messageType).toBe('OrderPlaced');
  });

  it('send() round-trips an RPC: publishes a command and resolves when a reply arrives', async () => {
    const peer = makeTransport(client.duplicate() as unknown as MockRedis);
    peer.onMessage(async (env) => {
      // Echo a reply envelope with the same correlationId.
      return {
        ...envelopeOf(`${env.messageType}.reply`, 'command', { ok: true }),
        correlationId: env.messageId,
      };
    });
    await peer.start();

    await transport.start();
    const cmd = envelopeOf('CreateOrder', 'command', { id: 'o-1' });
    const reply = await transport.send(cmd);

    expect(reply.correlationId).toBe(cmd.messageId);
    expect((reply.payload as { ok: boolean }).ok).toBe(true);

    await peer.stop();
  });

  it('send() rejects with a timeout error if no reply arrives in rpcTimeoutMs', async () => {
    transport = makeTransport(client, { rpcTimeoutMs: 50 });
    await transport.start();
    const cmd = envelopeOf('Unanswered', 'command', {});
    await expect(transport.send(cmd)).rejects.toThrow(/timed out/i);
  });

  it('stop() rejects any pending RPCs with a shutdown error', async () => {
    transport = makeTransport(client, { rpcTimeoutMs: 60000 });
    await transport.start();
    const cmd = envelopeOf('NeverHandled', 'command', {});
    const pending = transport.send(cmd);
    await new Promise((r) => setTimeout(r, 20));
    await transport.stop();
    await expect(pending).rejects.toThrow(/shut(ting)? down|stopped/i);
  });

  it('uses a custom channelPrefix when supplied', async () => {
    transport = makeTransport(client, { channelPrefix: 'my-app' });
    await transport.start();
    const observer = client.duplicate();
    const received = new Promise<string>((resolve) => {
      observer.on('message', (_ch: string, msg: string) => resolve(msg));
      observer.subscribe('my-app.event.X');
    });
    await new Promise((r) => setTimeout(r, 20));

    await transport.publish(envelopeOf('X', 'event', null));
    const raw = await received;
    expect(JSON.parse(raw).messageType).toBe('X');
    observer.disconnect();
  });

  describe('error handler', () => {
    it('init().onError is invoked when the inbound handler throws', async () => {
      const errors: Error[] = [];
      transport.init?.({
        typeRegistry: new TypeRegistry(),
        onError: (err) => errors.push(err),
      });
      transport.onMessage(async () => {
        throw new Error('inbound dispatch failed');
      });
      await transport.start();

      const peer = client.duplicate();
      const env = envelopeOf('OrderPlaced', 'event', {});
      await peer.publish('omni-bus.event.OrderPlaced', new StubSerializer().serialize(env) as string);
      peer.disconnect();
      await new Promise((r) => setTimeout(r, 40));

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe('inbound dispatch failed');
    });

    it('init().onError is invoked on deserialization failure', async () => {
      const errors: Error[] = [];
      transport.init?.({
        typeRegistry: new TypeRegistry(),
        onError: (err) => errors.push(err),
      });
      transport.onMessage(async () => undefined);
      await transport.start();

      const peer = client.duplicate();
      await peer.publish('omni-bus.event.X', 'not-json');
      peer.disconnect();
      await new Promise((r) => setTimeout(r, 40));

      expect(errors).toHaveLength(1);
    });
  });

  describe('conditional wiring via start() options', () => {
    it('does not open the subscriber connection when both inbound and replyListener are false', async () => {
      const duplicateSpy = jest.spyOn(client, 'duplicate');
      await transport.start({ inbound: false, replyListener: false });
      expect(duplicateSpy).not.toHaveBeenCalled();
    });

    it('opens only the reply listener when inbound is false but replyListener is true', async () => {
      await transport.start({ inbound: false, replyListener: true });
      // publish() still works (uses the pub connection), but the broad PSUBSCRIBE
      // for incoming events/commands is not active.
      const observer = client.duplicate();
      const received = new Promise<string | null>((resolve) => {
        observer.on('message', (_ch: string, msg: string) => resolve(msg));
        observer.subscribe('omni-bus.event.NoConsumer');
      });
      await new Promise((r) => setTimeout(r, 20));
      await transport.publish(envelopeOf('NoConsumer', 'event', { id: 1 }));
      const raw = await Promise.race([
        received,
        new Promise<null>((r) => setTimeout(() => r(null), 100)),
      ]);
      expect(raw).not.toBeNull(); // publish still works
      observer.disconnect();
    });
  });
});
