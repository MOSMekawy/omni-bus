import type { Envelope } from '../envelope';
import type { InboundHandler, ITransport } from './i-transport';
import type { TransportCapabilities } from './transport-capabilities';

const CAPABILITIES: TransportCapabilities = {
  supportsRequestReply: true,
  supportsBroadcast: true,
  supportsScheduling: false,
  supportsDurability: false,
};

export class InMemoryTransport implements ITransport {
  readonly name = 'inMemory';
  readonly capabilities: TransportCapabilities = CAPABILITIES;
  private inbound?: InboundHandler;

  static create(): InMemoryTransport {
    return new InMemoryTransport();
  }

  /**
   * InMemoryTransport has no broker, so the wiring options are ignored.
   * Producer and consumer are always the same process; both sides of the
   * dispatch happen through the single inbound handler registered via
   * `onMessage`. Trying to "publisher-only" an in-memory bus would have
   * no meaning — the bus catches that at `OmniBus.computeWiring`.
   */
  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  onMessage(handler: InboundHandler): void {
    // Idempotent: the bus re-registers on every start(), including after
    // stop(). Overwriting is correct — only one bus owns this transport.
    this.inbound = handler;
  }

  async send(env: Envelope): Promise<Envelope> {
    if (!this.inbound) {
      throw new Error('InMemoryTransport has no inbound handler; the bus is not started.');
    }
    const reply = await this.inbound(env);
    if (!reply) {
      throw new Error(
        `InMemoryTransport.send for "${env.messageType}" expected a reply envelope from the handler but got nothing.`,
      );
    }
    return reply;
  }

  async publish(env: Envelope): Promise<void> {
    if (!this.inbound) {
      throw new Error('InMemoryTransport has no inbound handler; the bus is not started.');
    }
    await this.inbound(env);
  }
}
