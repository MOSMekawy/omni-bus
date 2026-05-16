import {
  type DynamicModule,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OmniBus, type OmniBusConfig } from '@omni-bus/core';
import { NestServiceResolver } from './nest-service-resolver';

@Module({})
export class OmniBusModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(private readonly bus: OmniBus) {}

  static forRoot(config: OmniBusConfig): DynamicModule {
    return {
      module: OmniBusModule,
      providers: [
        {
          provide: OmniBus,
          useFactory: (moduleRef: ModuleRef) => {
            const resolver = config.resolver ?? new NestServiceResolver(moduleRef);
            return OmniBus.create({ ...config, resolver });
          },
          inject: [ModuleRef],
        },
      ],
      exports: [OmniBus],
    };
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.bus.stop();
  }
}
