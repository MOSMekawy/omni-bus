export type MessageKind = 'command' | 'event';

export interface Envelope<TPayload = unknown> {
  readonly messageId: string;
  readonly messageType: string;
  readonly kind: MessageKind;
  readonly timestamp: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: TPayload;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly replyTo?: string;
}

export interface OutboundEnvelopeOptions {
  correlationId?: string;
  causationId?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}
