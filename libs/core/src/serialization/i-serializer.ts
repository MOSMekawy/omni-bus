import type { Envelope } from '../envelope';
import type { Message } from '../messages';
import type { TypeRegistry } from '../registry/type-registry';

export interface ISerializer {
  readonly contentType: string;
  serialize(env: Envelope<Message>): Buffer | string;
  deserialize(bytes: Buffer | string, registry: TypeRegistry): Envelope<Message>;
}
