# omni-bus

A TypeScript message bus inspired by [WolverineFX](https://wolverinefx.net/) and [MediatR](https://github.com/jbogard/MediatR). Decorate a handler; the framework discovers it, routes its message, runs the pipeline, and dispatches across in-memory or remote transports.

## Packages

| Package | Description |
|---|---|
| [`@omni-bus/core`](libs/core/) | Framework-agnostic core: messages, decorators, registries, pipeline, router, in-memory transport, `OmniBus.create`. |
| [`@omni-bus/nest`](libs/nest/) | NestJS integration: `OmniBusModule.forRoot` + `NestServiceResolver`. |
| [`@omni-bus/class-transformer`](libs/class-transformer/) | Reference `ISerializer` implementation backed by `class-transformer` for round-tripping class instances (Dates, nested classes, etc.). |
| [`@omni-bus/redis`](libs/redis/) | Redis pub/sub transport with correlation-ID RPC. |
| [`@omni-bus/bullmq`](libs/bullmq/) | BullMQ transport: durable queue + native job-return-value RPC. |
| [`@omni-bus/rabbitmq`](libs/rabbitmq/) | RabbitMQ transport: topic fanout + AMQP direct reply-to RPC. |

## At a glance

```ts
import { Command, CommandHandler, ICommandHandler, OmniBus, InMemoryTransport } from '@omni-bus/core';

class CreateOrder extends Command<string> {
  constructor(public readonly customerId: string) { super(); }
}

@CommandHandler(CreateOrder)
class CreateOrderHandler implements ICommandHandler<CreateOrder, string> {
  async handle(cmd: CreateOrder) { return `order-${cmd.customerId}`; }
}

const bus = OmniBus.create({
  transports: { inMemory: InMemoryTransport.create() },
  defaults: { transport: 'inMemory' },
});

await bus.start();
const orderId = await bus.send(new CreateOrder('cust-1')); // "order-cust-1"
```

Same code, with Nest DI:

```ts
import { OmniBusModule } from '@omni-bus/nest';

@Module({
  imports: [OmniBusModule.forRoot({
    transports: { inMemory: InMemoryTransport.create() },
    defaults: { transport: 'inMemory' },
  })],
  providers: [CreateOrderHandler],
})
class AppModule {}
```

## Design tenets

- **Decorators on handlers, never on messages.** `@CommandHandler(CreateOrder)` self-registers into a framework-owned registry. Users never call `bus.register(...)`.
- **Two semantic kinds.** `Command<TRes>` has exactly one handler and returns a typed response; `Event` fans out to zero-or-many handlers in parallel.
- **Framework-agnostic.** Core has zero Nest, zero Redis. Nest is one of N possible DI adapters — a future tsyringe adapter would be the same shape (~10 lines).
- **Pluggable everything.** Transports, serializers, DI containers, and pipeline middleware are all interfaces with optional reference implementations.
- **Convention + override routing.** Everything defaults to in-memory; explicit `route(X).to('redis').withReplyTo('redis')` rules override.
- **One `OmniBus`, role derived from declarations.** No publisher / consumer split — `OmniBus.start()` inspects the handler registry and routes to decide which transports need inbound subscriptions and which only need a reply listener. A process that imports no handler files becomes a pure publisher automatically; one that imports handlers becomes a worker. Matches the WolverineFX model.

## Workspace

This repo is an npm monorepo. After cloning:

```bash
npm install
npm run build           # tsc -b across all six packages
npm test                # unit tests (122 passing, integration tests skipped)
npm run test:integration  # spins up real Redis + RabbitMQ via testcontainers (needs Docker)
```

## Error handling

- **Command failures cross the wire as fault envelopes.** When a remote handler throws, the framework wraps the error in an internal `Fault` envelope and surfaces it to the caller as a thrown `Error` (name + message + stack preserved). No more "RPC timed out" when the real cause was `EntityNotFoundError`.
- **Event failures and malformed messages reach `OmniBusConfig.onError`** instead of becoming unhandled promise rejections. Default hook is `console.error`; pass your own for structured logging:
  ```ts
  OmniBus.create({
    transports: { ... },
    onError: (err, ctx) => logger.error({ err, ctx }, 'inbound failure'),
  });
  ```
- **Capability checks at startup.** Routing a `Command` to a non-RPC transport, or an `Event` to a non-broadcast transport (e.g. BullMQ), throws at `OmniBus.create` — not silently after the first dispatch.

## Releasing

All six packages are versioned together. To cut a release:

1. Bump every `libs/*/package.json` `version` field and the matching `peerDependencies.@omni-bus/core` constraint to the new version (or use `npm version --workspaces <new-version>`).
2. Update `CHANGELOG.md`.
3. Commit. Tag with `vX.Y.Z` and push.
4. The `Release` GitHub Action verifies that each lib's version matches the tag, then runs `npm publish --workspaces --provenance --access public`. Requires the `NPM_TOKEN` repo secret to be set to a [granular access token](https://docs.npmjs.com/about-access-tokens) with publish scope for `@omni-bus/*`.

Manual fallback (from a clean checkout, npm logged in):

```bash
npm ci
npm run build
npm test
npm publish --workspaces --access public
```

## Status

v0.1.1 — all six packages green at 155 unit tests. Real-broker integration tests live in `*.integration.spec.ts` files behind the `INTEGRATION=1` env flag.

**Out of scope for v1:** cascading messages, sagas, inbox/outbox, scheduled messages, sticky multi-handler routing across transports, built-in middleware, per-message-type retry policy.
