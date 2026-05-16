import type { Command, Event, Message } from '../messages';

export type Constructor<T = unknown> = abstract new (...args: never[]) => T;

export type HandlerDescriptor =
  | { kind: 'command'; messageCtor: Constructor<Command<unknown>>; handlerCtor: Constructor }
  | { kind: 'event'; messageCtor: Constructor<Event>; handlerCtor: Constructor };

export class HandlerRegistry {
  private readonly commandHandlers = new Map<Constructor<Message>, Constructor>();
  private readonly eventHandlers = new Map<Constructor<Message>, Set<Constructor>>();

  registerCommandHandler(messageCtor: Constructor<Command<unknown>>, handlerCtor: Constructor): void {
    const existing = this.commandHandlers.get(messageCtor);
    if (existing && existing !== handlerCtor) {
      throw new Error(
        `Command ${messageCtor.name} already has a registered handler (${existing.name}); ` +
          `cannot register a second handler (${handlerCtor.name}). Commands are single-handler.`,
      );
    }
    this.commandHandlers.set(messageCtor, handlerCtor);
  }

  registerEventHandler(messageCtor: Constructor<Event>, handlerCtor: Constructor): void {
    let set = this.eventHandlers.get(messageCtor);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(messageCtor, set);
    }
    set.add(handlerCtor);
  }

  getCommandHandler(messageCtor: Constructor<Command<unknown>>): Constructor | undefined {
    return this.commandHandlers.get(messageCtor);
  }

  getEventHandlers(messageCtor: Constructor<Event>): readonly Constructor[] {
    const set = this.eventHandlers.get(messageCtor);
    return Object.freeze(set ? [...set] : []);
  }

  snapshot(): HandlerDescriptor[] {
    const out: HandlerDescriptor[] = [];
    for (const [messageCtor, handlerCtor] of this.commandHandlers) {
      out.push({
        kind: 'command',
        messageCtor: messageCtor as Constructor<Command<unknown>>,
        handlerCtor,
      });
    }
    for (const [messageCtor, handlers] of this.eventHandlers) {
      for (const handlerCtor of handlers) {
        out.push({
          kind: 'event',
          messageCtor: messageCtor as Constructor<Event>,
          handlerCtor,
        });
      }
    }
    return out;
  }

  clear(): void {
    this.commandHandlers.clear();
    this.eventHandlers.clear();
  }
}

export const handlerRegistry: HandlerRegistry = new HandlerRegistry();
