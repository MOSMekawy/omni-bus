import type { Envelope } from '../envelope';
import { Command } from '../messages';
import type { IMessageMiddleware } from './i-message-middleware';
import type { MessageContext } from './message-context';
import { Pipeline } from './pipeline';

class TestCmd extends Command<string> {}

function makeCtx(): MessageContext {
  const message = new TestCmd();
  const envelope: Envelope = {
    messageId: 'msg-1',
    messageType: 'TestCmd',
    kind: 'command',
    timestamp: '2026-01-01T00:00:00.000Z',
    headers: {},
    payload: message,
  };
  return { envelope, message, messageType: 'TestCmd', kind: 'command', transport: 'inMemory' };
}

describe('Pipeline', () => {
  it('invokes the terminal handler when no middleware is configured', async () => {
    const pipeline = new Pipeline([]);
    const result = await pipeline.execute(makeCtx(), async () => 'terminal');
    expect(result).toBe('terminal');
  });

  it('invokes a single middleware around the terminal handler', async () => {
    const order: string[] = [];
    const mw: IMessageMiddleware = {
      async intercept(_ctx, next) {
        order.push('before');
        const result = await next();
        order.push('after');
        return result;
      },
    };
    const pipeline = new Pipeline([mw]);
    const result = await pipeline.execute(makeCtx(), async () => {
      order.push('terminal');
      return 'r';
    });
    expect(order).toEqual(['before', 'terminal', 'after']);
    expect(result).toBe('r');
  });

  it('preserves config order: outer-most middleware wraps the inner ones', async () => {
    const order: string[] = [];
    const make = (label: string): IMessageMiddleware => ({
      async intercept(_ctx, next) {
        order.push(`${label}:before`);
        const result = await next();
        order.push(`${label}:after`);
        return result;
      },
    });
    const pipeline = new Pipeline([make('A'), make('B'), make('C')]);
    await pipeline.execute(makeCtx(), async () => {
      order.push('terminal');
    });
    expect(order).toEqual([
      'A:before',
      'B:before',
      'C:before',
      'terminal',
      'C:after',
      'B:after',
      'A:after',
    ]);
  });

  it('allows middleware to short-circuit by not calling next()', async () => {
    let terminalCalled = false;
    const mw: IMessageMiddleware = {
      async intercept() {
        return 'short-circuit';
      },
    };
    const pipeline = new Pipeline([mw]);
    const result = await pipeline.execute(makeCtx(), async () => {
      terminalCalled = true;
      return 'terminal';
    });
    expect(result).toBe('short-circuit');
    expect(terminalCalled).toBe(false);
  });

  it('allows middleware to transform the return value', async () => {
    const mw: IMessageMiddleware = {
      async intercept(_ctx, next) {
        const inner = (await next()) as number;
        return inner * 2;
      },
    };
    const pipeline = new Pipeline([mw]);
    const result = await pipeline.execute(makeCtx(), async () => 21);
    expect(result).toBe(42);
  });

  it('propagates errors from the terminal handler to outer middleware', async () => {
    const seen: unknown[] = [];
    const mw: IMessageMiddleware = {
      async intercept(_ctx, next) {
        try {
          return await next();
        } catch (e) {
          seen.push(e);
          throw e;
        }
      },
    };
    const pipeline = new Pipeline([mw]);
    await expect(
      pipeline.execute(makeCtx(), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seen).toHaveLength(1);
  });

  it('throws if a middleware calls next() twice', async () => {
    const mw: IMessageMiddleware = {
      async intercept(_ctx, next) {
        await next();
        await next();
        return undefined;
      },
    };
    const pipeline = new Pipeline([mw]);
    await expect(pipeline.execute(makeCtx(), async () => undefined)).rejects.toThrow(/next.*twice/i);
  });
});
