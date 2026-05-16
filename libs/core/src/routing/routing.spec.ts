import { Command, Event } from '../messages';
import { route } from './route-builder';
import { Router } from './router';

class CreateOrder extends Command<string> {}
class OrderPlaced extends Event {}
class InventoryDepleted extends Event {}

describe('route() builder', () => {
  it('captures the transport via fluent chaining', () => {
    const built = route(CreateOrder).to('redis').build();
    expect(built.messageCtor).toBe(CreateOrder);
    expect(built.transport).toBe('redis');
  });

  it('throws if .to() is omitted at build time', () => {
    const r = route(CreateOrder);
    expect(() => r.build()).toThrow(/transport/i);
  });
});

describe('Router', () => {
  it('falls back to the default transport when no rule matches', () => {
    const router = new Router({ defaultTransport: 'inMemory', rules: [] });
    expect(router.resolve(new CreateOrder())).toEqual({ transport: 'inMemory' });
  });

  it('uses an explicit rule when the message ctor matches exactly', () => {
    const router = new Router({
      defaultTransport: 'inMemory',
      rules: [route(OrderPlaced).to('redis')],
    });
    expect(router.resolve(new OrderPlaced())).toEqual({ transport: 'redis' });
  });

  it('uses a base-class rule when no exact-class rule exists', () => {
    const router = new Router({
      defaultTransport: 'inMemory',
      rules: [route(Event).to('redis')],
    });
    expect(router.resolve(new InventoryDepleted())).toEqual({ transport: 'redis' });
  });

  it('prefers an exact-class rule over a base-class rule', () => {
    const router = new Router({
      defaultTransport: 'inMemory',
      rules: [route(Event).to('redis'), route(OrderPlaced).to('bullmq')],
    });
    expect(router.resolve(new OrderPlaced())).toEqual({ transport: 'bullmq' });
  });
});

describe('Router.resolveByType', () => {
  it('resolves a ctor with an explicit exact-class rule', () => {
    const router = new Router({
      defaultTransport: 'inMemory',
      rules: [route(OrderPlaced).to('redis')],
    });
    expect(router.resolveByType(OrderPlaced)).toEqual({ transport: 'redis' });
  });

  it('falls back to the default transport when no rule matches', () => {
    const router = new Router({ defaultTransport: 'inMemory', rules: [] });
    expect(router.resolveByType(CreateOrder)).toEqual({ transport: 'inMemory' });
  });

  it('uses a base-class rule for a derived type without an exact rule', () => {
    const router = new Router({
      defaultTransport: 'inMemory',
      rules: [route(Event).to('redis')],
    });
    expect(router.resolveByType(InventoryDepleted)).toEqual({ transport: 'redis' });
  });
});
