import { Command, Event } from '../messages';
import { HandlerRegistry, handlerRegistry } from './handler-registry';

class TestCommand extends Command<string> {}
class TestEvent extends Event {}
class OtherCommand extends Command<number> {}

class CommandHandlerA {}
class CommandHandlerB {}
class EventHandlerA {}
class EventHandlerB {}

describe('HandlerRegistry', () => {
  let registry: HandlerRegistry;
  beforeEach(() => {
    registry = new HandlerRegistry();
  });

  describe('command handlers', () => {
    it('registers and retrieves a command handler by message ctor', () => {
      registry.registerCommandHandler(TestCommand, CommandHandlerA);
      expect(registry.getCommandHandler(TestCommand)).toBe(CommandHandlerA);
    });

    it('returns undefined when no handler is registered for a command', () => {
      expect(registry.getCommandHandler(TestCommand)).toBeUndefined();
    });

    it('is idempotent when the same (command, handler) pair is registered twice', () => {
      registry.registerCommandHandler(TestCommand, CommandHandlerA);
      expect(() => registry.registerCommandHandler(TestCommand, CommandHandlerA)).not.toThrow();
      expect(registry.getCommandHandler(TestCommand)).toBe(CommandHandlerA);
    });

    it('throws when a different handler is registered for an already-handled command', () => {
      registry.registerCommandHandler(TestCommand, CommandHandlerA);
      expect(() => registry.registerCommandHandler(TestCommand, CommandHandlerB)).toThrow(
        /already has a registered handler/i,
      );
    });

    it('keeps command handler registrations isolated per command type', () => {
      registry.registerCommandHandler(TestCommand, CommandHandlerA);
      registry.registerCommandHandler(OtherCommand, CommandHandlerB);
      expect(registry.getCommandHandler(TestCommand)).toBe(CommandHandlerA);
      expect(registry.getCommandHandler(OtherCommand)).toBe(CommandHandlerB);
    });
  });

  describe('event handlers', () => {
    it('returns an empty array when no event handlers are registered', () => {
      expect(registry.getEventHandlers(TestEvent)).toEqual([]);
    });

    it('accumulates multiple distinct handlers for the same event', () => {
      registry.registerEventHandler(TestEvent, EventHandlerA);
      registry.registerEventHandler(TestEvent, EventHandlerB);
      const handlers = registry.getEventHandlers(TestEvent);
      expect(handlers).toHaveLength(2);
      expect(handlers).toContain(EventHandlerA);
      expect(handlers).toContain(EventHandlerB);
    });

    it('deduplicates: registering the same handler twice for the same event is a no-op', () => {
      registry.registerEventHandler(TestEvent, EventHandlerA);
      registry.registerEventHandler(TestEvent, EventHandlerA);
      expect(registry.getEventHandlers(TestEvent)).toEqual([EventHandlerA]);
    });

    it('exposes event handlers as a readonly view', () => {
      registry.registerEventHandler(TestEvent, EventHandlerA);
      const handlers = registry.getEventHandlers(TestEvent);
      expect(() => (handlers as unknown as unknown[]).push(EventHandlerB)).toThrow();
    });
  });

  describe('snapshot and clear', () => {
    it('snapshots the registered handlers as descriptors', () => {
      registry.registerCommandHandler(TestCommand, CommandHandlerA);
      registry.registerEventHandler(TestEvent, EventHandlerA);
      registry.registerEventHandler(TestEvent, EventHandlerB);

      const snap = registry.snapshot();
      expect(snap).toEqual(
        expect.arrayContaining([
          { kind: 'command', messageCtor: TestCommand, handlerCtor: CommandHandlerA },
          { kind: 'event', messageCtor: TestEvent, handlerCtor: EventHandlerA },
          { kind: 'event', messageCtor: TestEvent, handlerCtor: EventHandlerB },
        ]),
      );
      expect(snap).toHaveLength(3);
    });

    it('clear() empties both command and event registrations', () => {
      registry.registerCommandHandler(TestCommand, CommandHandlerA);
      registry.registerEventHandler(TestEvent, EventHandlerA);
      registry.clear();
      expect(registry.getCommandHandler(TestCommand)).toBeUndefined();
      expect(registry.getEventHandlers(TestEvent)).toEqual([]);
      expect(registry.snapshot()).toEqual([]);
    });
  });

  describe('module-level singleton', () => {
    it('exports a default singleton HandlerRegistry instance', () => {
      expect(handlerRegistry).toBeInstanceOf(HandlerRegistry);
    });
  });
});
