import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { JsonStore } from './json-store';
import { ModelClient } from './model-client';
import { DocumentReader } from './document-reader';

@Module({
  controllers: [JobsController],
  providers: [JobsService, JsonStore, ModelClient, DocumentReader],
})
export class AppModule {}