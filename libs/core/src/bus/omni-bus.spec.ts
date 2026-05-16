import { CommandHandler, EventHandler } from '../decorators';
import type { ICommandHandler, IEventHandler } from '../handlers';
import { Command, Event } from '../messages';
import type { IMessageMiddleware } from '../pipeline';
import { handlerRegistry } from '../registry/handler-registry';
import type { IServiceResolver, ResolvableConstructor } from '../resolver';
import type { Envelope } from '../envelope';
import { InMemoryTransport } from '../transport';
import type {
  ITransport,
  TransportCapabilities,
  TransportStartOptions,
} from '../transport';
import { route } from '../routing';
import { OmniBus } from './omni-bus';

describe('OmniBus end-to-end with InMemoryTransport', () => {
  beforeEach(() => {
    handlerRegistry.clear();
  });

  it('roundtrips a Command through send() and returns the typed response', async () => {
    class CreateOrder extends Command<string> {
      constructor(public readonly id: string) {
        super();
      }
    }
    @CommandHandler(CreateOrder)
    class CreateOrderHandler implements ICommandHandler<CreateOrder, string> {
      async handle(cmd: CreateOrder): Promise<string> {
        return `order-${cmd.id}`;
      }
    }
    void CreateOrderHandler;

    const bus = OmniBus.create({
      transports: { inMemory: InMemoryTransport.create() },
      defaults: { transport: 'inMemory' },
    });
    await bus.start();
    const result = await bus.send(new CreateOrder('123'));
    expect(result).toBe('order-123');
    await bus.stop();
  });

  it('fans out an Event to all registered handlers in parallel', async () => {
    class OrderPlaced extends Event {}
    const seen: string[] = [];

    @EventHandler(OrderPlaced)
    class A implements IEventHandler<OrderPlaced> {
      async handle(): Promise<void> {
        seen.push('A');
      }
    }
    @EventHandler(OrderPlaced)
    class B implements IEventHandler<OrderPlaced> {
      async handle(): Promise<void> {
        seen.push('B');
      }
    }
    void A;
    void B;

    const bus = OmniBus.create({
      transports: { inMemory: InMemoryTransport.create() },
      defaults: { transport: 'inMemory' },
    });
    await bus.start();
    await bus.publish(new OrderPlaced());
    expect(seen.sort()).toEqual(['A', 'B']);
    await bus.stop();
  });

  it('runs middleware around handler dispatch in config order', async () => {
    class Ping extends Command<string> {}
    @CommandHandler(Ping)
    class PingHandler implements ICommandHandler<Ping, string> {
      async handle(): Promise<string> {
        order.push('handler');
        return 'pong';
      }
    }
    void PingHandler;

    const order: string[] = [];
    const outer: IMessageMiddleware = {
      async intercept(ctx, next) {
        order.push(`outer:before:${ctx.messageType}`);
        const r = await next();
        order.push(`outer:after:${ctx.messageType}`);
        return r;
      },
    };
    const inner: IMessageMiddleware = {
      async intercept(_ctx, next) {
        order.push('inner:before');
        const r = await next();
        order.push('inner:after');
        return r;
      },
    };

    const bus = OmniBus.create({
      transports: { inMemory: InMemoryTransport.create() },
      defaults: { transport: 'inMemory' },
      middleware: [outer, inner],
    });
    await bus.start();
    const reply = await bus.send(new Ping());
    expect(reply).toBe('pong');
    expect(order).toEqual([
      'outer:before:Ping',
      'inner:before',
      'handler',
      'inner:after',
      'outer:after:Ping',
    ]);
    await bus.stop();
  });

  it('runs middleware exactly once around an event dispatch, not once per handler', async () => {
    class OrderPlaced extends Event {}
    @EventHandler(OrderPlaced)
    class A implements IEventHandler<OrderPlaced> {
      async handle(): Promise<void> {}
    }
    @EventHandler(OrderPlaced)
    class B implements IEventHandler<OrderPlaced> {
      async handle(): Promise<void> {}
    }
    void A;
    void B;

    let interceptCalls = 0;
    const counter: IMessageMiddleware = {
      async intercept(_ctx, next) {
        interceptCalls += 1;
        return next();
      },
    };

    const bus = OmniBus.create({
      transports: { inMemory: InMemoryTransport.create() },
      defaults: { transport: 'inMemory' },
      middleware: [counter],
    });
    await bus.start();
    await bus.publish(new OrderPlaced());
    expect(interceptCalls).toBe(1);
    await bus.stop();
  });

  it('throws when send() is called for a Command with no registered handler', async () => {
    class Orphan extends Command<void> {}
    const bus = OmniBus.create({
      transports: { inMemory: InMemoryTransport.create() },
      defaults: { transport: 'inMemory' },
      messages: [Orphan],
    });
    await bus.start();
    await expect(bus.send(new Orphan())).rejects.toThrow(/no.*command handler/i);
    await bus.stop();
  });

  it('publish() with zero registered handlers is a silent no-op', async () => {
    class Whisper extends Event {}
    const bus = OmniBus.create({
      transports: { inMemory: InMemoryTransport.create() },
      defaults: { transport: 'inMemory' },
      messages: [Whisper],
    });
    await bus.start();
    await expect(bus.publish(new Whisper())).resolves.toBeUndefined();
    await bus.stop();
  });

  it('uses a custom IServiceResolver to instantiate handlers (DI seam)', async () => {
    class Greet extends Command<string> {}
    @CommandHandler(Greet)
    class GreetHandler implements ICommandHandler<Greet, string> {
      constructor(public readonly prefix: string) {}
      async handle(): Promise<string> {
        return `${this.prefix}!`;
      }
    }

    const customResolver: IServiceResolver = {
      resolve<T>(ctor: ResolvableConstructor<T>): T {
        return new (ctor as unknown as new (a: string) => T)('hello');
      },
    };
    const resolveSpy = jest.spyOn(customResolver, 'resolve');

    const bus = OmniBus.create({
      transports: { inMemory: InMemoryTransport.create() },
      defaults: { transport: 'inMemory' },
      resolver: customResolver,
    });
    await bus.start();
    const result = await bus.send(new Greet());
    expect(result).toBe('hello!');
    expect(resolveSpy).toHaveBeenCalledWith(GreetHandler);
    await bus.stop();
  });

  it('aggregates errors from multiple parallel event handlers (local publish path)', async () => {
    class Boom extends Event {}
    @EventHandler(Boom)
    class FailingA implements IEventHandler<Boom> {
      async handle(): Promise<void> {
        throw new Error('A failed');
      }
    }
    @EventHandler(Boom)
    class FailingB implements IEventHandler<Boom> {
      async handle(): Promise<void> {
        throw new Error('B failed');
      }
    }
    void FailingA;
    void FailingB;

    const bus = OmniBus.create({
      transports: { inMemory: InMemoryTransport.create() },
      defaults: { transport: 'inMemory' },
    });
    await bus.start();
    await expect(bus.publish(new Boom())).rejects.toThrow(/A failed.*B failed|B failed.*A failed/s);
    await bus.stop();
  });

  it('registers messages: [...] types into the type registry for inbound-only use', async () => {
    class ProducedOnly extends Command<void> {
      static override readonly messageType = 'orders.ProducedOnly.v1';
    }
    const bus = OmniBus.create({
      transports: { inMemory: InMemoryTransport.create() },
      defaults: { transport: 'inMemory' },
      messages: [ProducedOnly],
    });
    await bus.start();
    await expect(bus.send(new ProducedOnly())).rejects.toThrow(/no command handler/i);
    await bus.stop();
  });

  it('refuses to start when defaults.transport names an unregistered transport', () => {
    expect(() =>
      OmniBus.create({
        transports: { inMemory: InMemoryTransport.create() },
        defaults: { transport: 'redis' },
      }),
    ).toThrow(/default transport.*redis.*not registered/i);
  });

  it('passes inbound=true to the transport when a handler is routed to it', async () => {
    class CreateOrder extends Command<string> {}

    @CommandHandler(CreateOrder)
    class CreateOrderHandler implements ICommandHandler<CreateOrder, string> {
      async handle(): Promise<string> {
        return 'ok';
      }
    }
    void CreateOrderHandler;

    const transport = InMemoryTransport.create();
    const startSpy = jest.spyOn(transport, 'start');

    const bus = OmniBus.create({
      transports: { inMemory: transport },
      defaults: { transport: 'inMemory' },
    });
    await bus.start();

    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ inbound: true, replyListener: true }),
    );
    await bus.stop();
  });

  it('passes inbound=false to the transport when no handler is routed to it', async () => {
    class ProducedOnly extends Event {}

    const transport = InMemoryTransport.create();
    const startSpy = jest.spyOn(transport, 'start');

    const bus = OmniBus.create({
      transports: { inMemory: transport },
      defaults: { transport: 'inMemory' },
      messages: [ProducedOnly],
    });
    await bus.start();

    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ inbound: false, replyListener: true }),
    );
    await bus.stop();
  });

  it('stop() then start() works — onMessage is re-registered idempotently', async () => {
    class Ping extends Command<string> {}
    @CommandHandler(Ping)
    class PingHandler implements ICommandHandler<Ping, string> {
      async handle(): Promise<string> {
        return 'pong';
      }
    }
    void PingHandler;

    const bus = OmniBus.create({
      transports: { inMemory: InMemoryTransport.create() },
      defaults: { transport: 'inMemory' },
    });
    await bus.start();
    expect(await bus.send(new Ping())).toBe('pong');
    await bus.stop();
    // Restart cycle must not throw.
    await bus.start();
    expect(await bus.send(new Ping())).toBe('pong');
    await bus.stop();
  });

  it('forwards OutboundEnvelopeOptions (correlationId, causationId, headers) through send()', async () => {
    class Trace extends Command<void> {}
    let captured: Envelope | undefined;
    @CommandHandler(Trace)
    class H implements ICommandHandler<Trace, void> {
      async handle(): Promise<void> {}
    }
    void H;

    const sniff: IMessageMiddleware = {
      async intercept(ctx, next) {
        captured = ctx.envelope;
        return next();
      },
    };

    const bus = OmniBus.create({
      transports: { inMemory: InMemoryTransport.create() },
      defaults: { transport: 'inMemory' },
      middleware: [sniff],
    });
    await bus.start();
    await bus.send(new Trace(), {
      correlationId: 'corr-1',
      causationId: 'cause-1',
      headers: { 'x-trace': 'abc' },
    });
    expect(captured?.correlationId).toBe('corr-1');
    expect(captured?.causationId).toBe('cause-1');
    expect(captured?.headers['x-trace']).toBe('abc');
    await bus.stop();
  });

  describe('capability enforcement', () => {
    const noBroadcast: ITransport = makeStubTransport('queue', {
      supportsRequestReply: true,
      supportsBroadcast: false,
      supportsScheduling: false,
      supportsDurability: false,
    });
    const noRpc: ITransport = makeStubTransport('fire', {
      supportsRequestReply: false,
      supportsBroadcast: true,
      supportsScheduling: false,
      supportsDurability: false,
    });

    it('refuses to start when an event handler is routed to a non-broadcast transport', () => {
      class MyEvent extends Event {}
      @EventHandler(MyEvent)
      class H implements IEventHandler<MyEvent> {
        async handle(): Promise<void> {}
      }
      void H;
      expect(() =>
        OmniBus.create({
          transports: { queue: noBroadcast },
          defaults: { transport: 'queue' },
        }),
      ).toThrow(/does not support broadcast/i);
    });

    it('refuses to start when a command handler is routed to a non-request/reply transport', () => {
      class MyCmd extends Command<void> {}
      @CommandHandler(MyCmd)
      class H implements ICommandHandler<MyCmd, void> {
        async handle(): Promise<void> {}
      }
      void H;
      expect(() =>
        OmniBus.create({
          transports: { fire: noRpc },
          defaults: { transport: 'fire' },
        }),
      ).toThrow(/does not support request\/reply/i);
    });

    it('publish() refuses to send to a non-broadcast transport', async () => {
      class LooseEvent extends Event {}
      const bus = OmniBus.create({
        transports: { queue: noBroadcast },
        defaults: { transport: 'queue' },
        messages: [LooseEvent],
      });
      await bus.start();
      await expect(bus.publish(new LooseEvent())).rejects.toThrow(/does not support broadcast/i);
      await bus.stop();
    });

    it('send() refuses to use a non-request/reply transport', async () => {
      class LooseCmd extends Command<void> {}
      const bus = OmniBus.create({
        transports: { fire: noRpc },
        defaults: { transport: 'fire' },
        messages: [LooseCmd],
      });
      await bus.start();
      await expect(bus.send(new LooseCmd())).rejects.toThrow(/does not support request\/reply/i);
      await bus.stop();
    });
  });

  describe('fault envelope path', () => {
    it('a command-handler error is surfaced to the caller as a thrown Error (not a timeout)', async () => {
      class Risky extends Command<void> {}
      @CommandHandler(Risky)
      class H implements ICommandHandler<Risky, void> {
        async handle(): Promise<void> {
          const e = new Error('domain rejected the request');
          e.name = 'DomainError';
          throw e;
        }
      }
      void H;

      const bus = OmniBus.create({
        transports: { inMemory: InMemoryTransport.create() },
        defaults: { transport: 'inMemory' },
      });
      await bus.start();
      await expect(bus.send(new Risky())).rejects.toMatchObject({
        name: 'DomainError',
        message: 'domain rejected the request',
      });
      await bus.stop();
    });
  });

});

function makeStubTransport(name: string, capabilities: TransportCapabilities): ITransport {
  const t: ITransport = {
    name,
    capabilities,
    async init(): Promise<void> {},
    async start(_options?: TransportStartOptions): Promise<void> {},
    async stop(): Promise<void> {},
    async send(): Promise<Envelope> {
      throw new Error('not used');
    },
    async publish(): Promise<void> {},
    onMessage(): void {},
  };
  return t;
}
