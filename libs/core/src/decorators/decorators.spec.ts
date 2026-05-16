import 'reflect-metadata';
import { Command, Event } from '../messages';
import { handlerRegistry } from '../registry/handler-registry';
import { CommandHandler, EventHandler } from '.';
import { COMMAND_HANDLER_METADATA, EVENT_HANDLER_METADATA } from './metadata-keys';

class TestCommand extends Command<string> {}
class TestEvent extends Event {}

describe('@CommandHandler decorator', () => {
  beforeEach(() => {
    handlerRegistry.clear();
  });

  it('self-registers the decorated class as the command handler', () => {
    @CommandHandler(TestCommand)
    class CreateOrderHandler {
      async handle(_cmd: TestCommand): Promise<string> {
        return 'ok';
      }
    }
    expect(handlerRegistry.getCommandHandler(TestCommand)).toBe(CreateOrderHandler);
  });

  it('stamps the message constructor as reflect-metadata on the handler class', () => {
    @CommandHandler(TestCommand)
    class CreateOrderHandler {}
    expect(Reflect.getMetadata(COMMAND_HANDLER_METADATA, CreateOrderHandler)).toBe(TestCommand);
  });

  it('returns the class unchanged (no replacement, no proxy)', () => {
    class Plain {}
    const decorated = CommandHandler(TestCommand)(Plain) ?? Plain;
    expect(decorated).toBe(Plain);
  });
});

describe('@EventHandler decorator', () => {
  beforeEach(() => {
    handlerRegistry.clear();
  });

  it('self-registers the decorated class as an event handler', () => {
    @EventHandler(TestEvent)
    class NotifyShippingHandler {
      async handle(_evt: TestEvent): Promise<void> {}
    }
    expect(handlerRegistry.getEventHandlers(TestEvent)).toContain(NotifyShippingHandler);
  });

  it('accumulates multiple event handlers for the same event', () => {
    @EventHandler(TestEvent)
    class HandlerA {}
    @EventHandler(TestEvent)
    class HandlerB {}
    const registered = handlerRegistry.getEventHandlers(TestEvent);
    expect(registered).toHaveLength(2);
    expect(registered).toContain(HandlerA);
    expect(registered).toContain(HandlerB);
  });

  it('stamps the event constructor as reflect-metadata on the handler class', () => {
    @EventHandler(TestEvent)
    class NotifyShippingHandler {}
    expect(Reflect.getMetadata(EVENT_HANDLER_METADATA, NotifyShippingHandler)).toBe(TestEvent);
  });
});
