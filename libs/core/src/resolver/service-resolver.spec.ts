import { DefaultServiceResolver } from './default-service-resolver';

describe('DefaultServiceResolver', () => {
  it('resolves an instance of a parameterless class', () => {
    class Foo {
      readonly tag = 'foo';
    }
    const resolver = new DefaultServiceResolver();
    const instance = resolver.resolve(Foo);
    expect(instance).toBeInstanceOf(Foo);
    expect(instance.tag).toBe('foo');
  });

  it('returns a fresh instance on each resolve call (no caching)', () => {
    class Foo {}
    const resolver = new DefaultServiceResolver();
    const a = resolver.resolve(Foo);
    const b = resolver.resolve(Foo);
    expect(a).not.toBe(b);
    expect(a).toBeInstanceOf(Foo);
    expect(b).toBeInstanceOf(Foo);
  });

  it('preserves typed return shape via the ctor generic', () => {
    class Bar {
      ping(): string {
        return 'pong';
      }
    }
    const resolver = new DefaultServiceResolver();
    const bar = resolver.resolve(Bar);
    expect(bar.ping()).toBe('pong');
  });
});
