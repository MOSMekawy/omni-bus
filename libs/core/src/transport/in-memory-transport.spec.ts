import type { Envelope } from '../envelope';
import { InMemoryTransport } from './in-memory-transport';

function envOf(messageType: string, kind: 'command' | 'event' = 'command'): Envelope {
  return { messageId: 'id', messageType, kind, timestamp: 'ts', headers: {}, payload: { foo: 1 } };
}

describe('InMemoryTransport', () => {
  it('exposes the static identity "inMemory"', () => {
    const t = InMemoryTransport.create();
    expect(t.name).toBe('inMemory');
  });

  it('declares request/reply and broadcast capabilities', () => {
    const t = InMemoryTransport.create();
    expect(t.capabilities.supportsRequestReply).toBe(true);
    expect(t.capabilities.supportsBroadcast).toBe(true);
  });

  it('does not declare scheduling or durability', () => {
    const t = InMemoryTransport.create();
    expect(t.capabilities.supportsScheduling).toBe(false);
    expect(t.capabilities.supportsDurability).toBe(false);
  });

  it('start() and stop() are idempotent no-ops', async () => {
    const t = InMemoryTransport.create();
    await expect(t.start()).resolves.toBeUndefined();
    await expect(t.start()).resolves.toBeUndefined();
    await expect(t.stop()).resolves.toBeUndefined();
  });

  it('send() routes to the registered inbound handler and returns its reply', async () => {
    const t = InMemoryTransport.create();
    const env = envOf('CreateOrder');
    const replyEnv: Envelope = { ...envOf('OrderResult'), correlationId: env.messageId };
    t.onMessage(async (received) => {
      expect(received).toBe(env);
      return replyEnv;
    });
    const reply = await t.send(env);
    expect(reply).toBe(replyEnv);
  });

  it('publish() routes to the registered inbound handler and discards its return', async () => {
    const t = InMemoryTransport.create();
    let receivedEnv: Envelope | undefined;
    t.onMessage(async (env) => {
      receivedEnv = env;
      return undefined;
    });
    const env = envOf('OrderPlaced');
    await expect(t.publish(env)).resolves.toBeUndefined();
    expect(receivedEnv).toBe(env);
  });

  it('send() throws if no inbound handler is registered', async () => {
    const t = InMemoryTransport.create();
    await expect(t.send(envOf('X'))).rejects.toThrow(/no inbound handler/i);
  });

  it('send() throws if the inbound handler does not return a reply envelope', async () => {
    const t = InMemoryTransport.create();
    t.onMessage(async () => undefined);
    await expect(t.send(envOf('X'))).rejects.toThrow(/expected a reply envelope/i);
  });

  it('onMessage() is idempotent: a second call replaces the prior handler', async () => {
    const t = InMemoryTransport.create();
    let firstCalls = 0;
    let secondCalls = 0;
    t.onMessage(async () => {
      firstCalls += 1;
      return undefined;
    });
    t.onMessage(async () => {
      secondCalls += 1;
      return undefined;
    });
    await t.publish(envOf('X', 'event'));
    expect(firstCalls).toBe(0);
    expect(secondCalls).toBe(1);
  });
});
