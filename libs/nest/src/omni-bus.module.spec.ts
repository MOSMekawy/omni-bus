import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  Command,
  CommandHandler,
  Event,
  EventHandler,
  type ICommandHandler,
  type IEventHandler,
  InMemoryTransport,
  OmniBus,
  handlerRegistry,
} from '@omni-bus/core';
import { OmniBusModule } from './omni-bus.module';

describe('OmniBusModule (Nest e2e)', () => {
  beforeEach(() => {
    handlerRegistry.clear();
  });

  it('discovers handlers and resolves their constructor dependencies via Nest DI', async () => {
    @Injectable()
    class OrderRepository {
      save(id: string): string {
        return `saved:${id}`;
      }
    }

    class CreateOrder extends Command<string> {
      constructor(public readonly id: string) {
        super();
      }
    }

    @Injectable()
    @CommandHandler(CreateOrder)
    class CreateOrderHandler implements ICommandHandler<CreateOrder, string> {
      constructor(private readonly repo: OrderRepository) {}
      async handle(cmd: CreateOrder): Promise<string> {
        return this.repo.save(cmd.id);
      }
    }

    const moduleFixture = await Test.createTestingModule({
      imports: [
        OmniBusModule.forRoot({
          transports: { inMemory: InMemoryTransport.create() },
          defaults: { transport: 'inMemory' },
        }),
      ],
      providers: [OrderRepository, CreateOrderHandler],
    }).compile();

    const app = moduleFixture;
    app.enableShutdownHooks();
    await app.init();

    const bus = app.get(OmniBus);
    const result = await bus.send(new CreateOrder('o-1'));
    expect(result).toBe('saved:o-1');

    await app.close();
  });

  it('starts the bus on application bootstrap and stops it on shutdown', async () => {
    class Ping extends Command<string> {}

    @Injectable()
    @CommandHandler(Ping)
    class PingHandler implements ICommandHandler<Ping, string> {
      async handle(): Promise<string> {
        return 'pong';
      }
    }

    const transport = InMemoryTransport.create();
    const startSpy = jest.spyOn(transport, 'start');
    const stopSpy = jest.spyOn(transport, 'stop');

    const moduleFixture = await Test.createTestingModule({
      imports: [
        OmniBusModule.forRoot({
          transports: { inMemory: transport },
          defaults: { transport: 'inMemory' },
        }),
      ],
      providers: [PingHandler],
    }).compile();

    const app = moduleFixture;
    app.enableShutdownHooks();
    await app.init();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).not.toHaveBeenCalled();

    const bus = app.get(OmniBus);
    await expect(bus.send(new Ping())).resolves.toBe('pong');

    await app.close();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('fans out events to multiple Nest-resolved handlers', async () => {
    class OrderPlaced extends Event {
      constructor(public readonly id: string) {
        super();
      }
    }

    @Injectable()
    class AuditLog {
      readonly entries: string[] = [];
    }

    @Injectable()
    @EventHandler(OrderPlaced)
    class AuditHandler implements IEventHandler<OrderPlaced> {
      constructor(private readonly log: AuditLog) {}
      async handle(evt: OrderPlaced): Promise<void> {
        this.log.entries.push(`audit:${evt.id}`);
      }
    }

    @Injectable()
    @EventHandler(OrderPlaced)
    class NotifyHandler implements IEventHandler<OrderPlaced> {
      constructor(private readonly log: AuditLog) {}
      async handle(evt: OrderPlaced): Promise<void> {
        this.log.entries.push(`notify:${evt.id}`);
      }
    }

    const moduleFixture = await Test.createTestingModule({
      imports: [
        OmniBusModule.forRoot({
          transports: { inMemory: InMemoryTransport.create() },
          defaults: { transport: 'inMemory' },
        }),
      ],
      providers: [AuditLog, AuditHandler, NotifyHandler],
    }).compile();

    const app = moduleFixture;
    app.enableShutdownHooks();
    await app.init();

    const bus = app.get(OmniBus);
    const log = app.get(AuditLog);
    await bus.publish(new OrderPlaced('o-42'));
    expect(log.entries.sort()).toEqual(['audit:o-42', 'notify:o-42']);

    await app.close();
  });

  it('shares the same OmniBus singleton across Nest injections', async () => {
    class Noop extends Command<void> {}

    @Injectable()
    @CommandHandler(Noop)
    class NoopHandler implements ICommandHandler<Noop, void> {
      async handle(): Promise<void> {}
    }

    @Injectable()
    class Consumer {
      constructor(public readonly bus: OmniBus) {}
    }

    const moduleFixture = await Test.createTestingModule({
      imports: [
        OmniBusModule.forRoot({
          transports: { inMemory: InMemoryTransport.create() },
          defaults: { transport: 'inMemory' },
        }),
      ],
      providers: [NoopHandler, Consumer],
    }).compile();

    const app = moduleFixture;
    app.enableShutdownHooks();
    await app.init();

    const fromRoot = app.get(OmniBus);
    const consumer = app.get(Consumer);
    expect(consumer.bus).toBe(fromRoot);

    await app.close();
  });
});
