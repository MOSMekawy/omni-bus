import { Command, Event, Message } from '../messages';
import { TypeRegistry } from '../registry/type-registry';
import { EnvelopeBuilder } from './envelope-builder';
import { newMessageId } from './id-generator';

class CreateOrder extends Command<string> {
  constructor(public readonly customerId: string) {
    super();
  }
}
class OrderPlaced extends Event {}

describe('newMessageId', () => {
  it('returns a non-empty string', () => {
    expect(typeof newMessageId()).toBe('string');
    expect(newMessageId().length).toBeGreaterThan(0);
  });

  it('returns a different value on each call', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(newMessageId());
    expect(ids.size).toBe(1000);
  });

  it('returns values that match the uuid v7 textual format', () => {
    expect(newMessageId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('EnvelopeBuilder', () => {
  let registry: TypeRegistry;
  let builder: EnvelopeBuilder;

  beforeEach(() => {
    registry = new TypeRegistry();
    registry.register(CreateOrder);
    builder = new EnvelopeBuilder(registry);
  });

  it('wraps a message into an envelope with required metadata', () => {
    const msg = new CreateOrder('cust-1');
    const env = builder.createOutbound(msg);

    expect(env.payload).toBe(msg);
    expect(env.messageType).toBe('CreateOrder');
    expect(env.messageId).toMatch(/[0-9a-f]/);
    expect(env.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(env.headers).toEqual({});
  });

  it('assigns a fresh messageId per call', () => {
    const msg = new CreateOrder('cust-1');
    const a = builder.createOutbound(msg);
    const b = builder.createOutbound(msg);
    expect(a.messageId).not.toBe(b.messageId);
  });

  it('propagates optional correlationId, causationId, replyTo, and headers', () => {
    const env = builder.createOutbound(new CreateOrder('cust-1'), {
      correlationId: 'corr-1',
      causationId: 'cause-1',
      replyTo: 'reply.channel',
      headers: { tenant: 'acme' },
    });
    expect(env.correlationId).toBe('corr-1');
    expect(env.causationId).toBe('cause-1');
    expect(env.replyTo).toBe('reply.channel');
    expect(env.headers).toEqual({ tenant: 'acme' });
  });

  it('uses the registry to resolve the message type name', () => {
    class CustomNamed extends Command<void> {
      static override readonly messageType = 'custom.named.v1';
    }
    registry.register(CustomNamed);
    const env = builder.createOutbound(new CustomNamed());
    expect(env.messageType).toBe('custom.named.v1');
  });

  it('throws when wrapping a message whose type is not registered', () => {
    class Unregistered extends Command<void> {}
    expect(() => builder.createOutbound(new Unregistered())).toThrow(/not registered/i);
  });

  it('sets kind="command" for messages extending Command', () => {
    const env = builder.createOutbound(new CreateOrder('cust-1'));
    expect(env.kind).toBe('command');
  });

  it('sets kind="event" for messages extending Event', () => {
    registry.register(OrderPlaced);
    const env = builder.createOutbound(new OrderPlaced());
    expect(env.kind).toBe('event');
  });

  it('throws for a message that extends neither Command nor Event', () => {
    class Weird extends Message {}
    registry.register(Weird);
    expect(() => builder.createOutbound(new Weird())).toThrow(/neither Command nor Event/);
  });
});
