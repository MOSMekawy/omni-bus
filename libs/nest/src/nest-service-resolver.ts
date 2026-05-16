import type { IServiceResolver, ResolvableConstructor } from '@omni-bus/core';
import type { ModuleRef } from '@nestjs/core';

export class NestServiceResolver implements IServiceResolver {
  constructor(private readonly moduleRef: ModuleRef) {}

  resolve<T>(ctor: ResolvableConstructor<T>): T {
    return this.moduleRef.get<T>(ctor as unknown as new (...args: unknown[]) => T, {
      strict: false,
    });
  }
}
