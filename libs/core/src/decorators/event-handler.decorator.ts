import 'reflect-metadata';
import type { Event } from '../messages';
import { type Constructor, handlerRegistry } from '../registry/handler-registry';
import { EVENT_HANDLER_METADATA } from './metadata-keys';

export function EventHandler<TEvt extends Event>(messageCtor: Constructor<TEvt>): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(EVENT_HANDLER_METADATA, messageCtor, target);
    handlerRegistry.registerEventHandler(
      messageCtor as Constructor<Event>,
      target as unknown as Constructor,
    );
  };
}
