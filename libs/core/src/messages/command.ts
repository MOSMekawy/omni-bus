import { Message } from './message';

export abstract class Command<TResponse = void> extends Message {
  readonly __response?: TResponse;
}
