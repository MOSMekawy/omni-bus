import type { Command } from '../messages';

export interface ICommandHandler<TCmd extends Command<TRes>, TRes = void> {
  handle(msg: TCmd): Promise<TRes>;
}
