import 'reflect-metadata';
import { Type } from 'class-transformer';
import { Command, Event, EnvelopeBuilder, TypeRegistry } from '@omni-bus/core';
import { ClassTransformerSerializer } from './class-transformer-serializer';

class CreateOrder extends Command<string> {
  @Type(() => Date)
  readonly placedAt!: Date;

  constructor(public readonly customerId: string, placedAt: Date) {
    super();
    this.placedAt = placedAt;
  }
}

class OrderPlaced extends Event {
  constructor(public readonly orderId: string) {
    super();
  }
}

describe('ClassTransformerSerializer', () => {
  let registry: TypeRegistry;
  let serializer: ClassTransformerSerializer;
  let builder: EnvelopeBuilder;

  beforeEach(() => {
    registry = new TypeRegistry();
    registry.register(CreateOrder);
    registry.register(OrderPlaced);
    serializer = new ClassTransformerSerializer();
    builder = new EnvelopeBuilder(registry);
  });

  it('advertises an application/json contentType', () => {
    expect(serializer.contentType).toBe('application/json');
  });

  it('serialize() produces a UTF-8 JSON string with messageType and kind preserved', () => {
    const env = builder.createOutbound(new OrderPlaced('o-1'));
    const bytes = serializer.serialize(env);
    expect(typeof bytes).toBe('string');
    const parsed = JSON.parse(bytes as string);
    expect(parsed.messageType).toBe('OrderPlaced');
    expect(parsed.kind).toBe('event');
    expect(parsed.payload).toEqual({ orderId: 'o-1' });
  });

  it('round-trips a Command and rehydrates the payload as a class instance', () => {
    const original = builder.createOutbound(
      new CreateOrder('cust-1', new Date('2026-05-13T10:00:00Z')),
    );
    const bytes = serializer.serialize(original);
    const back = serializer.deserialize(bytes, registry);

    expect(back.messageId).toBe(original.messageId);
    expect(back.messageType).toBe('CreateOrder');
    expect(back.kind).toBe('command');
    expect(back.payload).toBeInstanceOf(CreateOrder);
    expect((back.payload as CreateOrder).customerId).toBe('cust-1');
    expect((back.payload as CreateOrder).placedAt).toBeInstanceOf(Date);
    expect((back.payload as CreateOrder).placedAt.toISOString()).toBe(
      '2026-05-13T10:00:00.000Z',
    );
  });

  it('round-trips envelope metadata (correlationId, causationId, replyTo, headers)', () => {
    const original = builder.createOutbound(new OrderPlaced('o-1'), {
      correlationId: 'corr-1',
      causationId: 'cause-1',
      replyTo: 'amq.rabbitmq.reply-to',
      headers: { tenant: 'acme' },
    });
    const bytes = serializer.serialize(original);
    const back = serializer.deserialize(bytes, registry);

    expect(back.correlationId).toBe('corr-1');
    expect(back.causationId).toBe('cause-1');
    expect(back.replyTo).toBe('amq.rabbitmq.reply-to');
    expect(back.headers).toEqual({ tenant: 'acme' });
  });

  it('accepts a Buffer on deserialize as well as a string', () => {
    const env = builder.createOutbound(new OrderPlaced('o-1'));
    const bytes = serializer.serialize(env);
    const buf = Buffer.from(bytes as string, 'utf-8');
    const back = serializer.deserialize(buf, registry);
    expect((back.payload as OrderPlaced).orderId).toBe('o-1');
  });

  it('throws on deserialize when the messageType is not in the registry', () => {
    const env = builder.createOutbound(new OrderPlaced('o-1'));
    const bytes = serializer.serialize(env);
    const emptyRegistry = new TypeRegistry();
    expect(() => serializer.deserialize(bytes, emptyRegistry)).toThrow(
      /OrderPlaced.*not.*registered/i,
    );
  });
});
