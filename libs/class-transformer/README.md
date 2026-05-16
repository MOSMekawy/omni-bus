# @omni-bus/class-transformer

Reference `ISerializer` implementation for [omni-bus](../../README.md), backed by [`class-transformer`](https://github.com/typestack/class-transformer) and JSON. Round-trips class instances through the wire while preserving:

- Class identity (the payload comes back as `instanceof MyMessage`, not a POJO)
- Date instances (via `@Type(() => Date)`)
- Nested class instances (via `@Type(() => NestedClass)`)

## Install

```bash
npm install @omni-bus/class-transformer @omni-bus/core class-transformer reflect-metadata
```

## Quick start

### Decorate non-trivial fields on your messages

```ts
import { Command } from '@omni-bus/core';
import { Type } from 'class-transformer';

export class CreateOrder extends Command<string> {
  @Type(() => Date)
  readonly placedAt!: Date;

  constructor(public readonly customerId: string, placedAt: Date) {
    super();
    this.placedAt = placedAt;
  }
}
```

`@Type` must decorate a class property declaration, not a constructor-parameter property. If a field is a primitive or plain object, no decoration is needed.

### Register the serializer on the bus

```ts
import { OmniBus } from '@omni-bus/core';
import { RedisTransport } from '@omni-bus/redis';
import { ClassTransformerSerializer } from '@omni-bus/class-transformer';

const serializer = new ClassTransformerSerializer();

const bus = OmniBus.create({
  transports: {
    redis: RedisTransport.create({
      client: new Redis(),
      serializer,
    }),
  },
  serializers: { json: serializer },
  defaults: { transport: 'redis', serializer: 'json' },
});
```

## Wire format

`serialize` produces a UTF-8 JSON string of the envelope. The payload is converted with `instanceToPlain` so decorators like `@Type`, `@Expose`, `@Exclude` etc. are honored.

```json
{
  "messageId": "01935...",
  "messageType": "CreateOrder",
  "kind": "command",
  "timestamp": "2026-05-13T10:00:00.000Z",
  "headers": {},
  "payload": { "customerId": "cust-1", "placedAt": "2026-05-13T10:00:00.000Z" }
}
```

`deserialize(bytes, registry)` parses the JSON, looks up the constructor by `messageType` in the supplied `TypeRegistry`, and rehydrates the payload with `plainToInstance(Ctor, payload)`. Throws if the message type is not registered.

## Tests

```bash
npx jest libs/class-transformer
```
