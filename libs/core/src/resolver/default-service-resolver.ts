import type { IServiceResolver, ResolvableConstructor } from './service-resolver.interface';

export class DefaultServiceResolver implements IServiceResolver {
  resolve<T>(ctor: ResolvableConstructor<T>): T {
    const Ctor = ctor as unknown as new () => T;
    return new Ctor();
  }
}
