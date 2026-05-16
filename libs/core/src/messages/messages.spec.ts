import { Command, Event, Message } from '.';

describe('Message hierarchy', () => {
  it('exposes Message as a class', () => {
    expect(typeof Message).toBe('function');
  });

  it('Command extends Message at runtime', () => {
    class CreateOrder extends Command<string> {}
    const cmd = new CreateOrder();
    expect(cmd).toBeInstanceOf(Command);
    expect(cmd).toBeInstanceOf(Message);
  });

  it('Event extends Message at runtime', () => {
    class OrderPlaced extends Event {}
    const evt = new OrderPlaced();
    expect(evt).toBeInstanceOf(Event);
    expect(evt).toBeInstanceOf(Message);
  });

  it('Command and Event share Message as a common ancestor', () => {
    class CreateOrder extends Command<string> {}
    class OrderPlaced extends Event {}
    expect(new CreateOrder()).toBeInstanceOf(Message);
    expect(new OrderPlaced()).toBeInstanceOf(Message);
    expect(new CreateOrder()).not.toBeInstanceOf(Event);
    expect(new OrderPlaced()).not.toBeInstanceOf(Command);
  });

  it('exposes a static messageType override when a subclass declares it', () => {
    class CreateOrder extends Command<string> {
      static override readonly messageType = 'orders.CreateOrder.v1';
    }
    expect(CreateOrder.messageType).toBe('orders.CreateOrder.v1');
  });

  it('leaves static messageType undefined when not declared', () => {
    class CreateOrder extends Command<string> {}
    expect(CreateOrder.messageType).toBeUndefined();
  });
});
