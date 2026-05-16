import type { Message } from '../messages';
import type { Constructor } from './handler-registry';

type MessageCtor = Constructor<Message> & { readonly messageType?: string };

export class TypeRegistry {
  private readonly byName = new Map<string, MessageCtor>();

  nameFor(target: Message | Constructor<Message>): string {
    const ctor = (typeof target === 'function' ? target : target.constructor) as MessageCtor;
    return ctor.messageType ?? ctor.name;
  }

  register(ctor: Constructor<Message>): void {
    const hasExplicit = (ctor as MessageCtor).messageType !== undefined;
    if (!hasExplicit && ctor.name.length < 2) {
      throw new Error(
        `Message class "${ctor.name || '<anonymous>'}" has no usable name and no explicit ` +
          `\`static readonly messageType\` override. This usually means the build was minified. ` +
          `Add a static messageType to make the class identifiable on the wire.`,
      );
    }
    const name = this.nameFor(ctor);
    const existing = this.byName.get(name);
    if (existing && existing !== ctor) {
      throw new Error(
        `Message type "${name}" is already registered to ${existing.name}; cannot register ${ctor.name}. ` +
          `Use static readonly messageType to disambiguate.`,
      );
    }
    this.byName.set(name, ctor as MessageCtor);
  }

  getByName(name: string): Constructor<Message> | undefined {
    return this.byName.get(name);
  }

  clear(): void {
    this.byName.clear();
  }
}
