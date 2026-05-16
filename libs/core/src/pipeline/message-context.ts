import type { Envelope } from '../envelope';
import type { Message } from '../messages';

export interface MessageContext {
  readonly envelope: Envelope;
  readonly message: Message;
  readonly messageType: string;
  readonly kind: 'command' | 'event';
  readonly transport: string;
}
