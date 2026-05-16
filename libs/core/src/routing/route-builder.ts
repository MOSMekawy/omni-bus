import type { Message } from '../messages';
import type { Constructor } from '../registry/handler-registry';

export interface BuiltRoute {
  readonly messageCtor: Constructor<Message>;
  readonly transport: string;
}

export class RouteBuilder<TMsg extends Message> {
  private _transport?: string;

  constructor(readonly messageCtor: Constructor<TMsg>) {}

  to(transport: string): this {
    this._transport = transport;
    return this;
  }

  build(): BuiltRoute {
    if (!this._transport) {
      throw new Error(
        `Route for ${this.messageCtor.name} is missing a transport; call .to('<transport>') on the builder.`,
      );
    }
    return {
      messageCtor: this.messageCtor as Constructor<Message>,
      transport: this._transport,
    };
  }
}

export function route<T extends Message>(messageCtor: Constructor<T>): RouteBuilder<T> {
  return new RouteBuilder(messageCtor);
}
