# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-05-16

First public release. Addresses the findings from the initial design review.

### Added

- **Fault envelope path for RPC errors.** A new internal `Fault` message class is auto-registered with the type registry. When a remote command handler throws, the framework wraps the error in a `Fault` envelope and surfaces it to the caller via `bus.send()` as a thrown `Error` with `name`, `message`, and `stack` preserved.
- **`OmniBusConfig.onError`** central error hook for inbound failures (event-handler errors, deserialization errors, reply-publish failures). Defaults to `console.error`. Transports plumb errors through this hook via the new `TransportInitContext.onError`.
- **Capability checks at startup.** `OmniBus.create()` walks the handler registry + routes and refuses to start when a `Command` is routed to a non-RPC transport or an `Event` to a non-broadcast transport. The same checks fire on `bus.send()` and `bus.publish()` to cover handler-less routes.
- **`bus.send(cmd, options?)` and `bus.publish(evt, options?)`** now accept `OutboundEnvelopeOptions` so callers can pass `correlationId`, `causationId`, and `headers`.
- **`BullMQTransport.concurrency`** option (default `1`) for worker concurrency.
- **`RabbitMQTransport.prefetch`** option (default `32`) bounding unacked-in-flight per consumer.
- **Bundler-hostile class-name guard.** `TypeRegistry.register` now throws when a class has `ctor.name.length < 2` and no `static messageType` override, so production minified builds fail loudly instead of silently misrouting.

### Changed

- **RabbitMQ inbound delivery now ACKs.** Successful dispatch and event-handler errors `ack` the message; malformed payloads `nack(false, false)` so the broker drops them. Previously messages were never acked, which would have throttled the consumer to a halt under load.
- **Event-pipeline runs once per event, not per handler.** Middleware (logging, tracing, retry, etc.) now wraps the parallel fan-out instead of running N times. Matches Wolverine / MediatR semantics.
- **`ITransport.onMessage` is now idempotent.** The bus re-registers on every `start()`, including after `stop()`. `await bus.stop(); await bus.start();` is now a supported pattern.
- **Event-handler errors over durable transports no longer trigger job retry.** `BullMQTransport.processJob` catches event-handler exceptions and reports via `onError`, returning normally so BullMQ does not replay all handlers on retry. Commands still return fault envelopes.
- **`TransportInitContext`** now carries both `typeRegistry` and `onError` — implementers of `ITransport.init` must accept the extended shape.

### Removed

- **`OmniBusConfig.serializers`** map and **`defaults.serializer`** — were validated but never read.
- **`RouteBuilder.withSerializer(name)`** and **`RouteBuilder.withReplyTo(transport)`** — same: dead surface. Builders now only take `.to(transport)`. Per-message serializer selection and cross-transport reply routing will return when actually wired through.
- **`BuiltRoute.serializer`** and **`BuiltRoute.replyTo`** fields, and matching `ResolvedRoute` fields.

### Fixed

- Inbound handler errors from Redis/RabbitMQ no longer become unhandled promise rejections that crash the process under Node ≥ 15 default rejection mode. They route to `onError` instead.
- RabbitMQ deserialization errors no longer silently swallow messages — they `nack(requeue=false)` and report via `onError`.
- Redis and RabbitMQ deserialization errors are now reported via `onError` instead of being swallowed by an empty `catch {}`.

## [0.1.0] - 2026-05-15

Initial implementation. Six workspace packages, in-memory + Redis + BullMQ + RabbitMQ transports, NestJS adapter, class-transformer reference serializer, full handler-decorator + pipeline + routing surface, 122 unit tests.

[Unreleased]: https://github.com/MOSMekawy/omni-bus/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/MOSMekawy/omni-bus/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/MOSMekawy/omni-bus/releases/tag/v0.1.0
