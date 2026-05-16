import type { IServiceResolver, ResolvableConstructor } from './i-service-resolver';

export class DefaultServiceResolver implements IServiceResolver {
  resolve<T>(ctor: ResolvableConstructor<T>): T {
    const Ctor = ctor as unknown as new () => T;
    return new Ctor();
  }
}
