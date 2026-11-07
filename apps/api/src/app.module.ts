import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { JsonStore } from './json-store';
import { ModelClient } from './model-client';

@Module({
  controllers: [JobsController],
  providers: [JobsService, JsonStore, ModelClient],
})
export class AppModule {}