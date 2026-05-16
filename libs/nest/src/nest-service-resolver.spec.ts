import type { ModuleRef } from '@nestjs/core';
import { NestServiceResolver } from './nest-service-resolver';

describe('NestServiceResolver', () => {
  it('delegates resolve() to ModuleRef.get with strict: false', () => {
    class FooHandler {}
    const instance = new FooHandler();
    const moduleRef = { get: jest.fn().mockReturnValue(instance) } as unknown as ModuleRef;
    const resolver = new NestServiceResolver(moduleRef);

    const resolved = resolver.resolve(FooHandler);

    expect(moduleRef.get).toHaveBeenCalledWith(FooHandler, { strict: false });
    expect(resolved).toBe(instance);
  });

  it('lets ModuleRef.get errors surface unchanged (no swallowing)', () => {
    const moduleRef = {
      get: jest.fn().mockImplementation(() => {
        throw new Error('UNKNOWN_DEPENDENCIES');
      }),
    } as unknown as ModuleRef;
    const resolver = new NestServiceResolver(moduleRef);
    class Bar {}
    expect(() => resolver.resolve(Bar)).toThrow('UNKNOWN_DEPENDENCIES');
  });
});
