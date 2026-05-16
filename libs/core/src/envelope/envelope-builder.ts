import { Command, Event, Message } from '../messages';
import type { TypeRegistry } from '../registry/type-registry';
import type { Envelope, MessageKind, OutboundEnvelopeOptions } from './envelope';
import { newMessageId } from './id-generator';

export class EnvelopeBuilder {
  constructor(private readonly registry: TypeRegistry) {}

  createOutbound<TMsg extends Message>(
    message: TMsg,
    options: OutboundEnvelopeOptions = {},
  ): Envelope<TMsg> {
    const messageType = this.registry.nameFor(message);
    if (!this.registry.getByName(messageType)) {
      throw new Error(
        `Message type "${messageType}" is not registered. ` +
          `Register the class via a handler decorator or the module's \`messages\` option.`,
      );
    }
    return {
      messageId: newMessageId(),
      messageType,
      kind: kindOf(message),
      timestamp: new Date().toISOString(),
      headers: options.headers ?? {},
      payload: message,
      ...(options.correlationId !== undefined && { correlationId: options.correlationId }),
      ...(options.causationId !== undefined && { causationId: options.causationId }),
      ...(options.replyTo !== undefined && { replyTo: options.replyTo }),
    };
  }
}

function kindOf(message: Message): MessageKind {
  if (message instanceof Command) return 'command';
  if (message instanceof Event) return 'event';
  throw new Error(
    `Message ${message.constructor.name} extends neither Command nor Event; cannot derive kind.`,
  );
}
