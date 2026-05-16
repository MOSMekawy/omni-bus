# @omni-bus/bullmq

[BullMQ](https://docs.bullmq.io/) transport for [omni-bus](../../README.md). Backed by Redis under the hood; provides durable, ordered job processing with native job-return-value RPC.

## Install

```bash
npm install @omni-bus/bullmq @omni-bus/core bullmq
```

`bullmq` is declared as a peer dependency.

## Quick start

```ts
import { OmniBus } from '@omni-bus/core';
import { BullMQTransport } from '@omni-bus/bullmq';
import { ClassTransformerSerializer } from '@omni-bus/class-transformer';

const transport = BullMQTransport.create({
  connection: { host: 'localhost', port: 6379, maxRetriesPerRequest: null },
  serializer: new ClassTransformerSerializer(),
  // Optional:
  queueName: 'orders',           // default: 'omni-bus-jobs'
  rpcTimeoutMs: 30_000,          // default: 30s
  defaultJobOptions: { attempts: 3 },
  concurrency: 10,               // default: 1 — worker concurrency
});

const bus = OmniBus.create({
  transports: { bullmq: transport },
  defaults: { transport: 'bullmq' },
});

await bus.start();
```

`maxRetriesPerRequest: null` is required by BullMQ for the connection used by `Worker`.

## How it works

A single BullMQ `Queue` holds all jobs. `job.name` is the `messageType`; `job.data` carries `{ bytes: serializedEnvelope }`. A single `Worker` consumes from that queue and dispatches into the bus's inbound handler.

- **`publish(envelope)`** → `queue.add(messageType, { bytes })`. Fire and forget.
- **`send(envelope)`** → `queue.add(...)` + `await job.waitUntilFinished(queueEvents, rpcTimeoutMs)`. The worker's processor returns a serialized reply envelope, which `waitUntilFinished` resolves with.
- **Inbound** → the worker's processor calls the bus's inbound handler, serializes the returned reply (if any), and returns it as the job result.

## Wiring modes

The transport's `start({ inbound, replyListener })` decides which BullMQ primitives are instantiated:

| `inbound` | `replyListener` | What's created |
|---|---|---|
| `false` | `false` | `Queue` only. Fire-and-forget publisher (`publish()` works; `send()` would hang since there's no `QueueEvents` to await replies). |
| `false` | `true` | `Queue` + `QueueEvents`. Publisher with RPC: `send()` can `await job.waitUntilFinished(queueEvents)`. |
| `true` | `false` | `Queue` + `Worker`. Consumer that processes jobs but never issues RPC from this process. |
| `true` | `true` | `Queue` + `Worker` + `QueueEvents`. The default. |

The bus derives these flags from the handler registry + routes; you usually don't pass them explicitly.

## Capabilities

```ts
{
  supportsRequestReply: true,
  supportsBroadcast: false,      // queue is single-consumer; no fan-out
  supportsScheduling: true,
  supportsDurability: true,
}
```

`supportsBroadcast: false` matters: if you route an `Event` to BullMQ, only **one** worker process will receive it. The bus validates this at startup. Local handlers (within the same process) still fan out — this only affects cross-process fan-out.

## Error handling

- **Command handler errors** become `Fault` envelopes carried as the job's return value. The caller's `bus.send()` resolves the job, then rehydrates and throws — `name`, `message`, and `stack` are preserved across the wire. BullMQ does **not** retry on handler exceptions; users wanting handler-level retry should wrap their handler explicitly or configure `defaultJobOptions.attempts` for transient broker failures separately.
- **Event handler errors** are reported via the bus's `onError` hook and the job is marked successful. Otherwise BullMQ would retry the whole job, **replaying every event handler that already succeeded** (#10 in the design review). Make event handlers idempotent if you want at-least-once semantics across worker crashes.
- **Malformed payloads** are reported via `onError` and the job is completed (returning `undefined`) — bad bytes will never succeed on retry.

## Caveats

- **Queue semantic, not fan-out.** Events sent across BullMQ are single-consumer per process. `OmniBus.publish()` enforces this at startup: it throws if you route an `Event` here because the transport's `supportsBroadcast: false` is honored by the bus. Use [`@omni-bus/redis`](../redis/) or [`@omni-bus/rabbitmq`](../rabbitmq/) for broadcast.
- **Requires real Redis.** `ioredis-mock` doesn't support the Lua scripts BullMQ relies on. Unit tests in this package use `jest.mock('bullmq')`; the integration tests need a live Redis container.
- **Worker concurrency defaults to 1.** Set `concurrency` on the transport options for higher throughput.

## Tests

- **8 unit tests** using `jest.mock('bullmq')`:

  ```bash
  npx jest libs/bullmq
  ```

- **2 integration tests** with a real Redis container (requires Docker):

  ```bash
  npm run test:integration
  ```
