# @omni-bus/core

Framework-agnostic core for [omni-bus](../../README.md). Provides message bases, handler decorators, the dispatch pipeline, routing, an in-memory transport, and the `OmniBus.create` factory. Zero runtime dependencies on any DI framework or message broker.

## Install

```bash
npm install @omni-bus/core reflect-metadata
```

`reflect-metadata` must be imported once at your application's entry point:

```ts
import 'reflect-metadata';
```

## Concepts

| Concept | Type | Semantics |
|---|---|---|
| `Message` | `abstract class` | Base for every dispatched type. |
| `Command<TRes>` | `extends Message` | Exactly one handler; returns a typed response. |
| `Event` | `extends Message` | Zero-or-many handlers; fan-out in parallel; no response. |
| `Envelope<T>` | `interface` | Wire-level wrapper with `messageId`, `messageType`, `kind`, `correlationId`, `replyTo`, `headers`, `payload`. |
| `Pipeline` | `class` | Onion-style middleware chain wrapping handler dispatch. |
| `Router` | `class` | Resolves a message instance to its transport. |
| `ISerializer` | `interface` | User-supplied envelope ↔ bytes conversion. Framework ships no implementation. |
| `IServiceResolver` | `interface` | DI seam: `resolve(ctor): T`. Default impl does `new Ctor()`. |
| `ITransport` | `interface` | `start/stop/send/publish/onMessage` + optional `init(ctx)` for serializing transports. |

## Quick start

### Define messages

```ts
import { Command, Event } from '@omni-bus/core';

export class CreateOrder extends Command<string> {
  static override readonly messageType = 'orders.CreateOrder.v1'; // optional override
  constructor(public readonly customerId: string) { super(); }
}

export class OrderPlaced extends Event {
  constructor(public readonly orderId: string) { super(); }
}
```

### Define handlers

```ts
import { CommandHandler, EventHandler, ICommandHandler, IEventHandler } from '@omni-bus/core';

@CommandHandler(CreateOrder)
export class CreateOrderHandler implements ICommandHandler<CreateOrder, string> {
  async handle(cmd: CreateOrder): Promise<string> {
    return `order-${cmd.customerId}`;
  }
}

@EventHandler(OrderPlaced)
export class NotifyShippingHandler implements IEventHandler<OrderPlaced> {
  async handle(evt: OrderPlaced): Promise<void> { /* ... */ }
}
```

The decorators stamp metadata via `Reflect.defineMetadata` **and** self-register the `(messageCtor, handlerCtor)` pair into the singleton `handlerRegistry`. The bus reads from this registry at `start()`. **Users never call `bus.register(...)`.**

### Wire the bus

```ts
import 'reflect-metadata';
import './handlers';   // side-effect import ensures decorators execute
import { OmniBus, InMemoryTransport, DefaultServiceResolver } from '@omni-bus/core';

const bus = OmniBus.create({
  transports: { inMemory: InMemoryTransport.create() },
  defaults: { transport: 'inMemory' },
  resolver: new DefaultServiceResolver(),   // parameterless handlers
  // Optional:
  // routes: [ route(OrderPlaced).to('redis') ],
  // middleware: [ loggingMiddleware ],
  // messages: [SomeInboundOnlyReplyType],
  // onError: (err, ctx) => logger.error({ err, ctx }),
});

await bus.start();

const orderId = await bus.send(new CreateOrder('cust-1'));
await bus.publish(new OrderPlaced(orderId));
```

## Middleware

```ts
import { IMessageMiddleware } from '@omni-bus/core';

const logging: IMessageMiddleware = {
  async intercept(ctx, next) {
    console.log('->', ctx.messageType);
    const result = await next();
    console.log('<-', ctx.messageType);
    return result;
  },
};
```

Middleware is composed onion-style: the outer-most middleware wraps the inner ones; `next()` is the recursive descent into the next layer (or the handler when none remain). Each middleware may call `next()` at most once.

**Events:** the pipeline runs **once** per event dispatch (wrapping the parallel fan-out to all handlers), not once per handler. This matches Wolverine/MediatR semantics and means a logging middleware emits exactly one span per published event, not N.

## Error handling

The framework distinguishes between *caller-recoverable* and *fire-and-forget* failures.

| What happened | Where it surfaces |
|---|---|
| A `Command` handler throws | Caller's `bus.send()` rejects with the rehydrated `Error` (name + message + stack preserved). The error crosses the wire as a `Fault` envelope. |
| An `Event` handler throws (local `bus.publish()`) | `bus.publish()` rejects with an aggregated `Event handler errors: ...` message. |
| An `Event` handler throws (remote inbound) | Routed to the `onError` hook. The transport ACKs the message — no retry. |
| Deserialization fails on the wire | Routed to `onError`. RabbitMQ NACKs without requeue. |
| Sending an RPC reply fails | Routed to `onError`. |

```ts
OmniBus.create({
  // ...
  onError: (err, ctx) => {
    // ctx: { transport, phase: 'deserialize'|'dispatch'|'publish-reply'|'connection', envelope?, messageType? }
    logger.error({ err, ...ctx }, 'omni-bus inbound failure');
  },
});
```

Default: `console.error` with a one-line summary.

## Capability checks (startup)

At `OmniBus.create` time, every registered handler's route is checked against the target transport's declared capabilities:

- `Command` handlers must be routed to a transport with `supportsRequestReply: true`.
- `Event` handlers must be routed to a transport with `supportsBroadcast: true`.

A mismatch throws with a clear message at startup rather than silently misbehaving at first dispatch. The same checks fire on `bus.send()` and `bus.publish()` to guard ad-hoc routes for messages without handlers in this process.

## Routing

```ts
import { route } from '@omni-bus/core';

OmniBus.create({
  transports: { inMemory: ..., redis: ... },
  defaults: { transport: 'inMemory' },
  routes: [
    route(OrderPlaced).to('redis'),
    route(GetUser).to('bullmq'),
  ],
});
```

Resolution order: exact-class match → base-class match → default transport.

## Service resolver (DI seam)

`DefaultServiceResolver` does `new Ctor()` — handlers must be parameterless. For real DI, plug in an adapter (e.g. [`@omni-bus/nest`](../nest/)) or implement `IServiceResolver` directly:

```ts
import { IServiceResolver, ResolvableConstructor } from '@omni-bus/core';
import { container } from 'tsyringe';

class TsyringeResolver implements IServiceResolver {
  resolve<T>(ctor: ResolvableConstructor<T>): T {
    return container.resolve(ctor as unknown as new (...a: never[]) => T);
  }
}
```

## Serialization

The framework defines `Envelope` and `ISerializer` but ships **no** concrete serializer — choosing a representation (JSON, CBOR, MessagePack, protobuf) and a hydration strategy (Object.assign, class-transformer, fromJSON) is the user's call. See [`@omni-bus/class-transformer`](../class-transformer/) for a worked reference implementation.

`InMemoryTransport` bypasses serialization entirely; the payload moves as a live instance. Remote transports invoke the configured `ISerializer` at the wire boundary.

## Publisher vs consumer is configuration, not a separate API

There is one `OmniBus` interface. The runtime role of a given process — pure publisher, RPC client, full worker, or all three — is **derived at `start()` time** from the handler registry and the configured routes. No `OmniBus.publisher()` / `OmniBus.consumer()` factories; this mirrors how [WolverineFX](https://wolverinefx.net/) handles it (`ListenTo*` vs `PublishMessage` are declarative; the bus does the rest).

For each configured transport, `OmniBus.start()` computes:

| Wiring directive | When set |
|---|---|
| `inbound: true` | At least one decorated handler is registered for a message type whose route resolves to this transport. |
| `replyListener: true` | The transport advertises `supportsRequestReply` (cheap insurance so `bus.send()` always works). |

The bus then calls `transport.start({ inbound, replyListener })`. Transports interpret the flags however makes sense for them — see the transport packages for the exact wiring mapping. A pure-publisher process (no handlers imported anywhere) skips all inbound subscriptions; an RPC-issuing publisher still gets a reply listener; a worker process gets the full inbound machinery.

```ts
interface TransportStartOptions {
  replyListener?: boolean;  // default true (back-compat for standalone use)
  inbound?: boolean;        // default true
}
```

Standalone usage (without the bus) keeps both flags defaulted to `true`, so existing transport code paths are unaffected.

## Tree-shaking note

Decorators self-register at class-load time. If a handler file is never imported, its decorator never runs and the handler is invisible to the bus. In Nest, listing the handler in `providers: []` imports the file. In a framework-agnostic app, a barrel file (`import './handlers'`) is the standard discipline.

If you publish a downstream package that re-exports handlers, make sure its `package.json` does **not** set `"sideEffects": false`. Decorator registrations are side effects; a tree-shaker that trusts a false `sideEffects` flag will strip the handler exports and the bus will dispatch into the void.

## Bundling and `messageType`

The wire format identifies messages by name. By default, the name is `ctor.name` — which becomes `"e"` or `"t1"` after minification. **Two services in different repos with different bundle configs will never agree on `"e"`**, so any class whose handlers run in a different process from where the class was published should declare an explicit type:

```ts
export class CreateOrder extends Command<string> {
  static override readonly messageType = 'orders.CreateOrder.v1';
  // ...
}
```

The registry rejects unnamed minified classes at registration time (`ctor.name.length < 2` with no explicit `messageType`) so production builds fail loudly rather than silently misrouting.

## Lifecycle

Transports implement `onMessage` as **idempotent** — the bus calls it once on every `start()`, including after `stop()`. This means `await bus.stop(); await bus.start();` is a supported pattern (hot-reload, integration test cycles, drain-and-resume).

## Tests

155 unit tests across the workspace. Run from the repo root:

```bash
npx jest libs/core
```
