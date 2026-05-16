import { type Envelope, newMessageId } from '../envelope';
import { Command } from '../messages';

export const FAULT_HEADER = 'x-omni-fault';

/**
 * Internal message class used to carry a remote handler error back to the
 * caller as the payload of a reply envelope. Registered automatically by
 * `OmniBus.create` so any user-supplied serializer can round-trip it
 * without extra configuration.
 */
export class Fault extends Command<unknown> {
  static override readonly messageType = '__omni.fault';
  constructor(
    public readonly name: string,
    public readonly message: string,
    public readonly stack?: string,
    public readonly originalType?: string,
  ) {
    super();
  }
}

export function isFault(env: Envelope): boolean {
  return env.headers?.[FAULT_HEADER] === '1' || env.messageType === Fault.messageType;
}

export function makeFault(err: unknown, original: Envelope): Envelope<Fault> {
  const e = err instanceof Error ? err : new Error(String(err));
  const fault = new Fault(e.name, e.message, e.stack, original.messageType);
  return {
    messageId: newMessageId(),
    messageType: Fault.messageType,
    kind: 'command',
    timestamp: new Date().toISOString(),
    headers: { [FAULT_HEADER]: '1' },
    payload: fault,
    correlationId: original.messageId,
  };
}

export function rehydrateFault(env: Envelope): Error {
  const p = env.payload as
    | { name?: string; message?: string; stack?: string; originalType?: string }
    | undefined;
  const err = new Error(p?.message ?? 'Remote handler error.');
  err.name = p?.name ?? 'Error';
  if (p?.stack) {
    err.stack = `${p.stack}\n    [received via omni-bus from remote handler${
      p.originalType ? ` for "${p.originalType}"` : ''
    }]`;
  }
  return err;
}
