import type { Envelope } from '../envelope';
import type { TypeRegistry } from '../registry/type-registry';
import type { TransportCapabilities } from './transport-capabilities';

export type InboundHandler = (env: Envelope) => Promise<Envelope | void>;

/**
 * Where in the transport lifecycle an error occurred. Lets the user-supplied
 * `onError` hook decide how to react.
 */
export type TransportErrorPhase =
  | 'deserialize' // an inbound message could not be decoded
  | 'dispatch' // the bus's inbound dispatch threw (event handler error, unknown type, etc.)
  | 'publish-reply' // sending an RPC reply back to the caller failed
  | 'connection'; // broker connection / channel error

export interface TransportErrorContext {
  readonly transport: string;
  readonly phase: TransportErrorPhase;
  readonly envelope?: Envelope;
  readonly messageType?: string;
}

export type TransportErrorHandler = (err: Error, ctx: TransportErrorContext) => void;

export interface TransportInitContext {
  readonly typeRegistry: TypeRegistry;
  /**
   * Invoked by the transport for inbound errors that have no other place to
   * be reported (event-handler failures, malformed envelopes, reply-publish
   * failures, etc.). Command-handler failures are surfaced to the caller via
   * a fault envelope and do NOT go through this hook.
   */
  readonly onError: TransportErrorHandler;
}

/**
 * Per-transport wiring directives computed by the bus from the handler
 * registry + routes. Defaults to "everything on" so standalone use
 * (without the bus) keeps working.
 */
export interface TransportStartOptions {
  /**
   * Open the per-instance reply listener so this transport can receive
   * RPC replies for `send()` calls originating here. Default: true.
   */
  readonly replyListener?: boolean;
  /**
   * Open the broad inbound subscription / worker so this transport can
   * deliver messages to registered handlers. Default: true.
   */
  readonly inbound?: boolean;
}

export interface ITransport {
  readonly name: string;
  readonly capabilities: TransportCapabilities;
  /**
   * Called by the bus before `start()` so the transport can capture the
   * type registry (needed to deserialize inbound envelopes) and the central
   * error hook. Transports that don't serialize or don't need error reporting
   * may omit this method.
   */
  init?(ctx: TransportInitContext): void | Promise<void>;
  start(options?: TransportStartOptions): Promise<void>;
  stop(): Promise<void>;
  send(env: Envelope): Promise<Envelope>;
  publish(env: Envelope): Promise<void>;
  /**
   * Register the bus's inbound dispatcher. Implementations MUST be idempotent
   * — the bus re-registers on every `start()`, including after `stop()`.
   */
  onMessage(handler: InboundHandler): void;
}
