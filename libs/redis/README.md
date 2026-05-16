# @omni-bus/redis

Redis pub/sub transport for [omni-bus](../../README.md) over [`ioredis`](https://github.com/redis/ioredis). Supports both events (fanout) and commands (request/reply with correlation IDs).

## Install

```bash
npm install @omni-bus/redis @omni-bus/core ioredis
```

`ioredis` is declared as a peer dependency.

## Quick start

```ts
import { OmniBus } from '@omni-bus/core';
import { Redis } from 'ioredis';
import { RedisTransport } from '@omni-bus/redis';
import { ClassTransformerSerializer } from '@omni-bus/class-transformer';

const transport = RedisTransport.create({
  client: new Redis({ host: 'localhost', port: 6379 }),
  serializer: new ClassTransformerSerializer(),
  // Optional:
  channelPrefix: 'my-app',     // default: 'omni-bus'
  rpcTimeoutMs: 30_000,        // default: 30s
  instanceId: 'service-a',     // default: uuid v7
});

const bus = OmniBus.create({
  transports: { redis: transport },
  defaults: { transport: 'redis' },
});

await bus.start();
```

The transport duplicates the supplied `ioredis` client at start-time (one connection for `publish`, one for `subscribe`) — Redis requires separate connections for pub/sub.

## Channel scheme

| Channel | Direction | Used for |
|---|---|---|
| `${prefix}.event.<messageType>` | publish ↔ pmessage | Event fan-out. |
| `${prefix}.command.<messageType>` | publish ↔ pmessage | Command delivery. |
| `${prefix}.reply.<instanceId>` | publish ↔ message | RPC replies, scoped to this bus instance. |

On `start()`, the transport `PSUBSCRIBE`s to `${prefix}.event.*` and `${prefix}.command.*`, and `SUBSCRIBE`s to its private reply channel. This means new message types don't need an explicit subscription — the pattern catches them.

## RPC correlation

`send(envelope)`:

1. Sets `envelope.replyTo = ${prefix}.reply.<instanceId>`.
2. Stores `{ resolve, reject, timer }` in a `Map<correlationId, ...>` keyed by `envelope.messageId`.
3. Publishes to the command channel.
4. Awaits the promise, with a timeout that defaults to 30s.

When a reply arrives on the reply channel, the transport matches on `envelope.correlationId` and resolves the pending promise. `stop()` rejects every pending entry with `"RedisTransport stopped while an RPC was pending."` to avoid orphan promises.

## Wiring modes

The transport's `start({ inbound, replyListener })` opens different infrastructure based on the bus's derived role for this transport:

| `inbound` | `replyListener` | What's opened |
|---|---|---|
| `false` | `false` | Publisher connection only. No subscriber connection at all. Pure fanout publisher. |
| `false` | `true` | Publisher connection + duplicated subscriber connection limited to `SUBSCRIBE ${prefix}.reply.<instanceId>`. Used by RPC-issuing clients. |
| `true` | `false` | Publisher + subscriber duplicated, with `PSUBSCRIBE` on `event.*` and `command.*` but no reply channel. Unusual — a pure consumer that never issues outbound RPC. |
| `true` | `true` | Full mode: PSUBSCRIBE + reply subscribe. The default. |

The bus derives these flags from the handler registry + routes; you usually don't pass them explicitly.

## Capabilities

```ts
{
  supportsRequestReply: true,
  supportsBroadcast: true,
  supportsScheduling: false,
  supportsDurability: false,
}
```

## Error handling

- **Command handler errors** are wrapped in a `Fault` envelope and sent back on the per-instance reply channel. Caller's `bus.send()` rehydrates and throws.
- **Event handler errors** and deserialization failures are reported via the bus's `onError` hook. Pub/sub has no broker-level redelivery, so they're effectively at-most-once.

## Caveats

- **Redis pub/sub is fire-and-forget.** If no subscriber is connected when a message is published, it's lost. There is no broker-side buffering.
- **Multiple command subscribers all process and reply.** Pub/sub fans out to every subscriber, so two processes both consuming the same command channel will both run their handler. The caller's correlator accepts the first reply and drops subsequent ones. If you need exactly-one-handler semantics, use [`@omni-bus/bullmq`](../bullmq/) or [`@omni-bus/rabbitmq`](../rabbitmq/) instead.
- **No durability.** Restart any subscriber and it misses everything in the gap.

## Tests

- **9 unit tests** using `ioredis-mock` (no broker required):

  ```bash
  npx jest libs/redis
  ```

- **3 integration tests** with a real Redis container (requires Docker):

  ```bash
  npm run test:integration
  ```
