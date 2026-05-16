import type { Message } from '../messages';
import type { Constructor } from '../registry/handler-registry';
import type { BuiltRoute, RouteBuilder } from './route-builder';

export interface ResolvedRoute {
  readonly transport: string;
}

export interface RouterOptions {
  readonly defaultTransport: string;
  readonly rules?: ReadonlyArray<RouteBuilder<Message>>;
}

export class Router {
  private readonly built: ReadonlyArray<BuiltRoute>;

  constructor(private readonly opts: RouterOptions) {
    this.built = (opts.rules ?? []).map((r) => r.build());
  }

  resolve(message: Message): ResolvedRoute {
    const exact = this.built.find((r) => message.constructor === r.messageCtor);
    const match = exact ?? this.built.find((r) => message instanceof r.messageCtor);
    return this.toResolved(match);
  }

  /**
   * Like `resolve`, but takes a constructor — no instance required.
   * Used by the bus at start-time to determine which transports need
   * inbound wiring based on the handler registry.
   */
  resolveByType(ctor: Constructor<Message>): ResolvedRoute {
    const exact = this.built.find((r) => ctor === r.messageCtor);
    const match =
      exact ??
      this.built.find((r) => ctor === r.messageCtor || ctor.prototype instanceof r.messageCtor);
    return this.toResolved(match);
  }

  private toResolved(match: BuiltRoute | undefined): ResolvedRoute {
    if (match) return { transport: match.transport };
    return { transport: this.opts.defaultTransport };
  }
}
