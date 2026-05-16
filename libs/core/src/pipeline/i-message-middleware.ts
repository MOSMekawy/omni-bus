import type { MessageContext } from './message-context';

export interface IMessageMiddleware {
  intercept(ctx: MessageContext, next: () => Promise<unknown>): Promise<unknown>;
}
