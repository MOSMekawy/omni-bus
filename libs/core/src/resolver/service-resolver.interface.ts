export type ResolvableConstructor<T> = new (...args: never[]) => T;

export interface IServiceResolver {
  resolve<T>(ctor: ResolvableConstructor<T>): T;
}
