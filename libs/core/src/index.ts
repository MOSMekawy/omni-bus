// @omni-bus/core public surface

export { Message, Command, Event } from './messages';

export type { ICommandHandler, IEventHandler } from './handlers';

export {
  CommandHandler,
  EventHandler,
  COMMAND_HANDLER_METADATA,
  EVENT_HANDLER_METADATA,
} from './decorators';

export {
  HandlerRegistry,
  handlerRegistry,
  type Constructor,
  type HandlerDescriptor,
} from './registry/handler-registry';
export { TypeRegistry } from './registry/type-registry';

export {
  type IServiceResolver,
  type ResolvableConstructor,
  DefaultServiceResolver,
} from './resolver';

export {
  type Envelope,
  type MessageKind,
  type OutboundEnvelopeOptions,
  EnvelopeBuilder,
  newMessageId,
} from './envelope';

export type { ISerializer } from './serialization';

export {
  Fault,
  FAULT_HEADER,
  isFault,
  makeFault,
  rehydrateFault,
} from './fault';

export {
  type ITransport,
  type InboundHandler,
  type TransportCapabilities,
  type TransportInitContext,
  type TransportStartOptions,
  type TransportErrorHandler,
  type TransportErrorContext,
  type TransportErrorPhase,
  InMemoryTransport,
} from './transport';

export {
  type IMessageMiddleware,
  type MessageContext,
  Pipeline,
} from './pipeline';

export {
  type BuiltRoute,
  type ResolvedRoute,
  type RouterOptions,
  RouteBuilder,
  Router,
  route,
} from './routing';

export { OmniBus, type OmniBusConfig } from './bus';
