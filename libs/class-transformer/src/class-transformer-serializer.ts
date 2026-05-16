import 'reflect-metadata';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import type { Envelope, ISerializer, Message, TypeRegistry } from '@omni-bus/core';

interface WireEnvelope {
  messageId: string;
  messageType: string;
  kind: 'command' | 'event';
  timestamp: string;
  headers?: Record<string, string>;
  payload: unknown;
  correlationId?: string;
  causationId?: string;
  replyTo?: string;
}

export class ClassTransformerSerializer implements ISerializer {
  readonly contentType = 'application/json';

  serialize(env: Envelope<Message>): string {
    const wire: WireEnvelope = {
      messageId: env.messageId,
      messageType: env.messageType,
      kind: env.kind,
      timestamp: env.timestamp,
      headers: env.headers,
      payload: instanceToPlain(env.payload),
      ...(env.correlationId !== undefined && { correlationId: env.correlationId }),
      ...(env.causationId !== undefined && { causationId: env.causationId }),
      ...(env.replyTo !== undefined && { replyTo: env.replyTo }),
    };
    return JSON.stringify(wire);
  }

  deserialize(bytes: Buffer | string, registry: TypeRegistry): Envelope<Message> {
    const text = typeof bytes === 'string' ? bytes : bytes.toString('utf-8');
    const parsed = JSON.parse(text) as WireEnvelope;

    const ctor = registry.getByName(parsed.messageType);
    if (!ctor) {
      throw new Error(`Message type "${parsed.messageType}" is not registered.`);
    }
    const payload = plainToInstance(
      ctor as unknown as new (...args: unknown[]) => Message,
      parsed.payload,
    ) as Message;

    return {
      messageId: parsed.messageId,
      messageType: parsed.messageType,
      kind: parsed.kind,
      timestamp: parsed.timestamp,
      headers: parsed.headers ?? {},
      payload,
      ...(parsed.correlationId !== undefined && { correlationId: parsed.correlationId }),
      ...(parsed.causationId !== undefined && { causationId: parsed.causationId }),
      ...(parsed.replyTo !== undefined && { replyTo: parsed.replyTo }),
    };
  }
}
