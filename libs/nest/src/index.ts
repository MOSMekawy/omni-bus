// @omni-bus/adapter-nest public surface
export { NestServiceResolver } from './nest-service-resolver';
export { OmniBusModule } from './omni-bus.module';

// Re-export the core decorators so Nest users only need one import path.
export { CommandHandler, EventHandler } from '@omni-bus/core';
