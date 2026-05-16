# @omni-bus/nest

NestJS integration for [omni-bus](../../README.md). Provides:

- `OmniBusModule.forRoot(config)` — a dynamic Nest module that constructs an `OmniBus` and exposes it as a provider.
- `NestServiceResolver` — an `IServiceResolver` that delegates to Nest's `ModuleRef`, so handlers with constructor-injected dependencies get resolved through the Nest container.

This package adds no architectural privilege to Nest. The core's discovery path (decorator self-registration into the framework-owned `HandlerRegistry`) is identical with or without this module — the adapter only contributes a DI seam.

## Install

```bash
npm install @omni-bus/nest @omni-bus/core @nestjs/common @nestjs/core reflect-metadata
```

## Quick start

```ts
import 'reflect-metadata';
import { Module, Injectable } from '@nestjs/common';
import { OmniBusModule } from '@omni-bus/nest';
import { Command, CommandHandler, ICommandHandler, InMemoryTransport, OmniBus } from '@omni-bus/core';

class CreateOrder extends Command<string> {
  constructor(public readonly customerId: string) { super(); }
}

@Injectable()
class OrderRepository {
  save(id: string): string { return `saved:${id}`; }
}

@Injectable()
@CommandHandler(CreateOrder)
export class CreateOrderHandler implements ICommandHandler<CreateOrder, string> {
  constructor(private readonly repo: OrderRepository) {}
  async handle(cmd: CreateOrder): Promise<string> {
    return this.repo.save(cmd.customerId);
  }
}

@Module({
  imports: [
    OmniBusModule.forRoot({
      transports: { inMemory: InMemoryTransport.create() },
      defaults: { transport: 'inMemory' },
    }),
  ],
  providers: [OrderRepository, CreateOrderHandler],
})
export class AppModule {}
```

In your `main.ts`:

```ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();   // required for OnApplicationShutdown to fire on app.close()
await app.listen(3000);

const bus = app.get(OmniBus);
const result = await bus.send(new CreateOrder('cust-1'));
```

## What the module does

`OmniBusModule.forRoot(config)` returns a dynamic module that:

1. Builds an `OmniBus` using `NestServiceResolver` (wrapping `ModuleRef.get(ctor, { strict: false })`) — unless you supply your own `resolver` in the config, in which case it's honored.
2. Exposes `OmniBus` as a provider so any Nest service can inject it.
3. Calls `bus.start()` on `OnApplicationBootstrap`.
4. Calls `bus.stop()` on `OnApplicationShutdown` (requires `app.enableShutdownHooks()`).

The config object is the same `OmniBusConfig` from `@omni-bus/core`. Handlers are discovered through the same decorator side-effect mechanism — listing them in `providers: []` is required so Nest can resolve their constructor dependencies, not for discovery.

## Decorator re-export

For convenience, the adapter re-exports the core decorators so Nest users only need one import line:

```ts
import { CommandHandler, EventHandler } from '@omni-bus/nest';
```

These are the same identifiers as the ones in `@omni-bus/core`.

## Tests

6 e2e tests using `@nestjs/testing`:

```bash
npx jest libs/nest
```
