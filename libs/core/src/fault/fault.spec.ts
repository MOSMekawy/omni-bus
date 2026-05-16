import type { Envelope } from '../envelope';
import { FAULT_HEADER, Fault, isFault, makeFault, rehydrateFault } from './fault';

function envOf(messageType = 'CreateOrder'): Envelope {
  return {
    messageId: 'm-1',
    messageType,
    kind: 'command',
    timestamp: new Date().toISOString(),
    headers: {},
    payload: {},
  };
}

describe('Fault envelopes', () => {
  it('Fault.messageType is the constant "__omni.fault"', () => {
    expect(Fault.messageType).toBe('__omni.fault');
  });

  it('makeFault() builds an envelope with the fault header set and original messageId as correlationId', () => {
    const original = envOf('PlaceOrder');
    const err = new Error('something broke');
    err.name = 'DomainError';
    const fault = makeFault(err, original);

    expect(fault.headers[FAULT_HEADER]).toBe('1');
    expect(fault.messageType).toBe('__omni.fault');
    expect(fault.correlationId).toBe(original.messageId);
    expect(fault.kind).toBe('command');
  });

  it('isFault() recognizes the header form', () => {
    expect(isFault(makeFault(new Error('x'), envOf()))).toBe(true);
    expect(isFault(envOf())).toBe(false);
  });

  it('rehydrateFault() reconstructs an Error with name + message preserved', () => {
    const original = envOf('PlaceOrder');
    const err = new Error('payment refused');
    err.name = 'PaymentRefused';
    const fault = makeFault(err, original);

    const rehydrated = rehydrateFault(fault);
    expect(rehydrated.name).toBe('PaymentRefused');
    expect(rehydrated.message).toBe('payment refused');
  });

  it('rehydrateFault() handles missing payload defensively', () => {
    const env: Envelope = {
      ...envOf(),
      messageType: '__omni.fault',
      headers: { [FAULT_HEADER]: '1' },
      payload: undefined as unknown,
    };
    const err = rehydrateFault(env);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/remote handler error/i);
  });
});
