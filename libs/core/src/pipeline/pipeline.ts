import type { IMessageMiddleware } from './message-middleware.interface';
import type { MessageContext } from './message-context';

export class Pipeline {
  constructor(private readonly middleware: readonly IMessageMiddleware[]) {}

  async execute(ctx: MessageContext, terminal: () => Promise<unknown>): Promise<unknown> {
    let i = 0;
    const dispatch = async (): Promise<unknown> => {
      if (i >= this.middleware.length) {
        return terminal();
      }
      const mw = this.middleware[i++];
      let called = false;
      const next = async (): Promise<unknown> => {
        if (called) {
          throw new Error('Middleware called next() twice; each middleware may call next at most once.');
        }
        called = true;
        return dispatch();
      };
      return mw.intercept(ctx, next);
    };
    return dispatch();
  }
}
