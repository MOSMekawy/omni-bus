import type { Event } from '../messages';

export interface IEventHandler<TEvt extends Event> {
  handle(msg: TEvt): Promise<void>;
}
