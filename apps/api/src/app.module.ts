import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobPipelineService } from './job-pipeline.service';
import { ProfileService } from './profile.service';
import { SettingsService } from './settings.service';
import { DatabaseStore } from './database.store';
import { ModelClient } from './model-client';
import { DocumentReader } from './document-reader';

@Module({
  controllers: [JobsController],
  providers: [JobPipelineService, ProfileService, SettingsService, DatabaseStore, ModelClient, DocumentReader],
})
export class AppModule {}