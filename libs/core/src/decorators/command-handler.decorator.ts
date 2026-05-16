import 'reflect-metadata';
import type { Command } from '../messages';
import { type Constructor, handlerRegistry } from '../registry/handler-registry';
import { COMMAND_HANDLER_METADATA } from './metadata-keys';

export function CommandHandler<TCmd extends Command<unknown>>(
  messageCtor: Constructor<TCmd>,
): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(COMMAND_HANDLER_METADATA, messageCtor, target);
    handlerRegistry.registerCommandHandler(
      messageCtor as Constructor<Command<unknown>>,
      target as unknown as Constructor,
    );
  };
}
