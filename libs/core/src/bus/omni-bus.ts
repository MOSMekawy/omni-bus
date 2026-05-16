import {
  type Envelope,
  EnvelopeBuilder,
  type OutboundEnvelopeOptions,
  newMessageId,
} from '../envelope';
import { Fault, isFault, makeFault, rehydrateFault } from '../fault';
import { Command, type Event, type Message } from '../messages';
import { Pipeline, type IMessageMiddleware, type MessageContext } from '../pipeline';
import {
  type Constructor,
  type HandlerDescriptor,
  HandlerRegistry,
  handlerRegistry as defaultHandlerRegistry,
} from '../registry/handler-registry';
import { TypeRegistry } from '../registry/type-registry';
import {
  DefaultServiceResolver,
  type IServiceResolver,
  type ResolvableConstructor,
} from '../resolver';
import { type RouteBuilder, Router } from '../routing';
import type { ITransport, TransportErrorHandler } from '../transport';

export interface OmniBusConfig {
  readonly transports: Readonly<Record<string, ITransport>>;
  readonly defaults?: { readonly transport?: string };
  readonly messages?: ReadonlyArray<Constructor<Message>>;
  readonly routes?: ReadonlyArray<RouteBuilder<Message>>;
  readonly middleware?: ReadonlyArray<IMessageMiddleware>;
  readonly resolver?: IServiceResolver;
  readonly handlerRegistry?: HandlerRegistry;
  readonly typeRegistry?: TypeRegistry;
  /**
   * Invoked for inbound errors that have no other place to be reported:
   * event-handler failures, malformed envelopes, reply-publish failures.
   * Command-handler failures are surfaced to the caller via a fault envelope
   * and do NOT go through this hook.
   * Default: logs to `console.error`.
   */
  readonly onError?: TransportErrorHandler;
}

interface HandlerLike<TArg, TRes> {
  handle(arg: TArg): Promise<TRes>;
}

export class OmniBus {
  private constructor(
    private readonly transports: Readonly<Record<string, ITransport>>,
    private readonly router: Router,
    private readonly pipeline: Pipeline,
    private readonly resolver: IServiceResolver,
    private readonly handlers: HandlerRegistry,
    private readonly types: TypeRegistry,
    private readonly envBuilder: EnvelopeBuilder,
    private readonly errorHandler: TransportErrorHandler,
  ) {}

  static create(config: OmniBusConfig): OmniBus {
    const transports = config.transports;
    const transportNames = Object.keys(transports);
    if (transportNames.length === 0) {
      throw new Error('At least one transport must be configured.');
    }
    const defaultTransportName = config.defaults?.transport ?? transportNames[0]!;
    if (!transports[defaultTransportName]) {
      throw new Error(
        `Default transport "${defaultTransportName}" is not registered in the transports map.`,
      );
    }
    for (const rule of config.routes ?? []) {
      const built = rule.build();
      if (!transports[built.transport]) {
        throw new Error(
          `Route for "${built.messageCtor.name}" targets transport "${built.transport}", which is not registered.`,
        );
      }
    }

    const handlers = config.handlerRegistry ?? defaultHandlerRegistry;
    const types = config.typeRegistry ?? new TypeRegistry();
    // Always register the internal Fault class so RPC errors round-trip
    // through any user-supplied serializer.
    types.register(Fault);
    for (const desc of handlers.snapshot()) {
      types.register(desc.messageCtor as Constructor<Message>);
    }
    for (const ctor of config.messages ?? []) {
      types.register(ctor);
    }

    const router = new Router({
      defaultTransport: defaultTransportName,
      rules: config.routes ?? [],
    });

    // Capability checks at startup, not at first dispatch.
    for (const desc of handlers.snapshot()) {
      const route = router.resolveByType(desc.messageCtor as Constructor<Message>);
      const transport = transports[route.transport]!;
      if (desc.kind === 'event' && !transport.capabilities.supportsBroadcast) {
        throw new Error(
          `Event "${desc.messageCtor.name}" is routed to transport "${route.transport}" which does not ` +
            `support broadcast. Events would be delivered to only one subscriber across processes. ` +
            `Route to a broadcast-capable transport (e.g. redis, rabbitmq) or remove the event handler.`,
        );
      }
      if (desc.kind === 'command' && !transport.capabilities.supportsRequestReply) {
        throw new Error(
          `Command "${desc.messageCtor.name}" is routed to transport "${route.transport}" which does not ` +
            `support request/reply.`,
        );
      }
    }

    const pipeline = new Pipeline(config.middleware ?? []);
    const resolver = config.resolver ?? new DefaultServiceResolver();
    const envBuilder = new EnvelopeBuilder(types);
    const errorHandler = config.onError ?? defaultErrorHandler;

    return new OmniBus(
      transports,
      router,
      pipeline,
      resolver,
      handlers,
      types,
      envBuilder,
      errorHandler,
    );
  }

  async start(): Promise<void> {
    const wiring = this.computeWiring();
    for (const [name, transport] of Object.entries(this.transports)) {
      const options = wiring.get(name) ?? { replyListener: false, inbound: false };
      await transport.init?.({ typeRegistry: this.types, onError: this.errorHandler });
      // Re-register on every start(). `onMessage` MUST be idempotent per the
      // ITransport contract so this also works after stop()/start().
      transport.onMessage((env) => this.dispatchInbound(env, transport.name));
      await transport.start(options);
    }
  }

  /**
   * Derive per-transport wiring directives from the handler registry + routes.
   * - `inbound: true` for transports that have at least one registered handler routed to them.
   * - `replyListener: true` for transports that advertise request/reply capability
   *   (cheap insurance so `bus.send()` always works on them).
   */
  private computeWiring(): Map<string, { inbound: boolean; replyListener: boolean }> {
    const wiring = new Map<string, { inbound: boolean; replyListener: boolean }>();
    for (const [name, transport] of Object.entries(this.transports)) {
      wiring.set(name, {
        inbound: false,
        replyListener: transport.capabilities.supportsRequestReply,
      });
    }
    for (const descriptor of this.handlers.snapshot()) {
      const route = this.router.resolveByType(descriptor.messageCtor as Constructor<Message>);
      const entry = wiring.get(route.transport);
      if (entry) entry.inbound = true;
    }
    return wiring;
  }

  async stop(): Promise<void> {
    for (const transport of Object.values(this.transports)) {
      await transport.stop();
    }
  }

  async send<TRes>(cmd: Command<TRes>, options?: OutboundEnvelopeOptions): Promise<TRes> {
    const env = this.envBuilder.createOutbound(cmd, options);
    const route = this.router.resolve(cmd);
    const transport = this.transports[route.transport];
    if (!transport) {
      throw new Error(`Transport "${route.transport}" not registered.`);
    }
    if (!transport.capabilities.supportsRequestReply) {
      throw new Error(
        `Transport "${route.transport}" does not support request/reply but a Command was routed to it.`,
      );
    }
    const reply = await transport.send(env);
    if (isFault(reply)) {
      throw rehydrateFault(reply);
    }
    return reply.payload as TRes;
  }

  async publish(evt: Event, options?: OutboundEnvelopeOptions): Promise<void> {
    const env = this.envBuilder.createOutbound(evt, options);
    const route = this.router.resolve(evt);
    const transport = this.transports[route.transport];
    if (!transport) {
      throw new Error(`Transport "${route.transport}" not registered.`);
    }
    if (!transport.capabilities.supportsBroadcast) {
      throw new Error(
        `Transport "${route.transport}" does not support broadcast but an Event was published to it. ` +
          `Route to a broadcast-capable transport (e.g. redis, rabbitmq) or use a Command instead.`,
      );
    }
    await transport.publish(env);
  }

  private async dispatchInbound(env: Envelope, transportName: string): Promise<Envelope | void> {
    const ctor = this.types.getByName(env.messageType);
    if (!ctor) {
      const err = new Error(`Inbound message type "${env.messageType}" is not registered.`);
      // Commands need a reply for the caller; events get reported via onError.
      if (env.kind === 'command') return makeFault(err, env);
      throw err;
    }
    const message = env.payload as Message;
    const ctx: MessageContext = {
      envelope: env,
      message,
      messageType: env.messageType,
      kind: env.kind,
      transport: transportName,
    };

    if (env.kind === 'command') {
      try {
        return await this.dispatchCommand(env, ctor as Constructor<Command<unknown>>, message, ctx);
      } catch (err) {
        // Surface handler errors to the caller as a fault envelope so
        // `bus.send()` can throw a recognizable Error rather than time out.
        return makeFault(err, env);
      }
    }
    // Event errors propagate up to the transport's inbound callback. For
    // remote transports, that callback is wrapped in try/catch and reports
    // via onError. For in-memory, the throw bubbles up through publish() so
    // local publishers still get aggregated errors.
    return this.dispatchEvent(ctor as Constructor<Event>, message, ctx);
  }

  private async dispatchCommand(
    env: Envelope,
    ctor: Constructor<Command<unknown>>,
    message: Message,
    ctx: MessageContext,
  ): Promise<Envelope> {
    const handlerCtor = this.handlers.getCommandHandler(ctor);
    if (!handlerCtor) {
      throw new Error(`No command handler registered for "${ctor.name}".`);
    }
    const result = await this.pipeline.execute(ctx, async () => {
      const handler = this.resolver.resolve(
        handlerCtor as ResolvableConstructor<HandlerLike<Message, unknown>>,
      );
      return handler.handle(message);
    });
    return {
      messageId: newMessageId(),
      messageType: `${env.messageType}.reply`,
      kind: 'command',
      timestamp: new Date().toISOString(),
      headers: {},
      payload: result,
      correlationId: env.messageId,
    };
  }

  private async dispatchEvent(
    ctor: Constructor<Event>,
    message: Message,
    ctx: MessageContext,
  ): Promise<void> {
    const handlerCtors = this.handlers.getEventHandlers(ctor);
    if (handlerCtors.length === 0) return;
    // Pipeline runs ONCE around the whole event dispatch (Wolverine/MediatR style),
    // not once per handler. The terminal step fans out to all handlers in parallel.
    await this.pipeline.execute(ctx, async () => {
      const settled = await Promise.allSettled(
        handlerCtors.map((HCtor) => {
          const handler = this.resolver.resolve(
            HCtor as ResolvableConstructor<HandlerLike<Message, void>>,
          );
          return handler.handle(message);
        }),
      );
      const errors = settled
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => r.reason);
      if (errors.length > 0) {
        const detail = errors
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .join('; ');
        throw new Error(`Event handler errors: ${detail}`);
      }
    });
  }
}

const defaultErrorHandler: TransportErrorHandler = (err, ctx) => {
  const where = ctx.messageType ?? '<unknown>';
  // eslint-disable-next-line no-console
  console.error(`[omni-bus] ${ctx.transport}/${ctx.phase} (${where}): ${err.message}`);
};

// Silences unused import warning for HandlerDescriptor (re-exported via index).
export type { HandlerDescriptor };
