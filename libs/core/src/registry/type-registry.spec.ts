import { Command, Event, Message } from '../messages';
import { TypeRegistry } from './type-registry';

class CreateOrder extends Command<string> {}
class OrderPlaced extends Event {}
class WithExplicitName extends Command<void> {
  static override readonly messageType = 'orders.WithExplicitName.v1';
}

describe('TypeRegistry', () => {
  let registry: TypeRegistry;
  beforeEach(() => {
    registry = new TypeRegistry();
  });

  describe('nameFor', () => {
    it('defaults to the class name when no static messageType is declared', () => {
      expect(registry.nameFor(CreateOrder)).toBe('CreateOrder');
      expect(registry.nameFor(OrderPlaced)).toBe('OrderPlaced');
    });

    it('uses the static messageType override when declared', () => {
      expect(registry.nameFor(WithExplicitName)).toBe('orders.WithExplicitName.v1');
    });

    it('produces the same name for a constructor and an instance of it', () => {
      const instance = new CreateOrder();
      expect(registry.nameFor(instance as Message)).toBe(registry.nameFor(CreateOrder));
    });
  });

  describe('register / getByName', () => {
    it('round-trips a registered ctor by its default name', () => {
      registry.register(CreateOrder);
      expect(registry.getByName('CreateOrder')).toBe(CreateOrder);
    });

    it('round-trips a registered ctor by its explicit messageType', () => {
      registry.register(WithExplicitName);
      expect(registry.getByName('orders.WithExplicitName.v1')).toBe(WithExplicitName);
    });

    it('returns undefined for an unregistered name', () => {
      expect(registry.getByName('Nope')).toBeUndefined();
    });

    it('is idempotent when the same ctor is registered twice', () => {
      registry.register(CreateOrder);
      expect(() => registry.register(CreateOrder)).not.toThrow();
      expect(registry.getByName('CreateOrder')).toBe(CreateOrder);
    });

    it('rejects a class whose name was minified to < 2 chars without a messageType override', () => {
      // Simulate what terser produces: a single-letter class name and no static override.
      // Use a fresh anonymous-shaped ctor with ctor.name forced to 'e'.
      class X extends Command<void> {}
      Object.defineProperty(X, 'name', { value: 'e' });
      expect(() => registry.register(X)).toThrow(/minified|messageType/i);
    });

    it('accepts a short-named class when an explicit messageType is provided', () => {
      class Y extends Command<void> {
        static override readonly messageType = 'orders.Y.v1';
      }
      Object.defineProperty(Y, 'name', { value: 'e' });
      expect(() => registry.register(Y)).not.toThrow();
    });

    it('throws when two different ctors collide on the same effective name', () => {
      class Foo extends Command<void> {
        static override readonly messageType = 'shared.name';
      }
      class Bar extends Command<void> {
        static override readonly messageType = 'shared.name';
      }
      registry.register(Foo);
      expect(() => registry.register(Bar)).toThrow(/already registered/i);
    });
  });

  describe('clear', () => {
    it('empties the registry', () => {
      registry.register(CreateOrder);
      registry.clear();
      expect(registry.getByName('CreateOrder')).toBeUndefined();
    });
  });
});
