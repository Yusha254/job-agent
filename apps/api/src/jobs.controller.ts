import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JobPipelineService } from './job-pipeline.service';
import { ProfileService } from './profile.service';
import { SettingsService } from './settings.service';
import type { UploadedDocument } from './document-reader';

const documentUpload = () => FileInterceptor('file', {
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => {
    const supported = /\.(pdf|docx|txt|md|rtf|png|jpe?g|webp)$/i.test(file.originalname);
    callback(supported ? null : new BadRequestException('Unsupported file type.'), supported);
  },
});

@Controller()
export class JobsController {
  constructor(
    private readonly jobs: JobPipelineService,
    private readonly profiles: ProfileService,
    private readonly settings: SettingsService,
  ) {}

  @Get('dashboard') dashboard() { return this.jobs.dashboard(); }
  @Get('settings') getSettings() { return this.settings.get(); }
  @Patch('settings') updateSettings(@Body() body: Record<string, any>) { return this.settings.update(body); }
  @Post('jobs')
  @UseInterceptors(documentUpload())
  addJob(@Body() body: { posting?: string; sourceUrl?: string; applyUrl?: string }, @UploadedFile() file?: UploadedDocument) {
    return this.jobs.addJob(body, file);
  }
  @Post('jobs/:id/extract') extract(@Param('id') id: string) { return this.jobs.extract(id); }
  @Post('jobs/:id/score') score(@Param('id') id: string) { return this.jobs.score(id); }
  @Post('jobs/:id/draft') draft(@Param('id') id: string) { return this.jobs.draft(id); }
  @Post('jobs/:id/approve') approve(@Param('id') id: string) { return this.jobs.transition(id, 'approve'); }
  @Post('jobs/:id/sent') sent(@Param('id') id: string) { return this.jobs.transition(id, 'sent'); }
  @Post('jobs/:id/skip') skip(@Param('id') id: string) { return this.jobs.transition(id, 'skip'); }
  @Post('pipeline/questions') questions() { return this.jobs.batchQuestions(); }
  @Post('pipeline/answers') answers(@Body() body: { answers?: Array<{ id: string; answer: string }> }) { return this.jobs.submitAnswers(body); }
  @Post('profile/approve')
  async approveProfile(@Body() body: { ids?: string[] }) {
    const profile = await this.profiles.approve(body.ids ?? []);
    const jobs = await this.jobs.rescoreWaitingJobs();
    return { profile, jobs };
  }
  @Post('profile') addProfile(@Body() body: { text?: string; section?: string }) { return this.profiles.addFact(body); }
  @Post('profile/import')
  @UseInterceptors(documentUpload())
  importProfile(@UploadedFile() file?: UploadedDocument) { return this.profiles.importCV(file); }
  @Post('profile/github') importGithub(@Body() body: { url?: string }) { return this.profiles.importGithub(body.url ?? ''); }
  @Patch('profile/proposals/:id/keep') keepProposal(@Param('id') id: string) { return this.profiles.keepProposal(id); }
  @Delete('profile/proposals/:id') rejectProposal(@Param('id') id: string) { return this.profiles.reject(id); }
  @Delete('profile/:id') deleteProfileFact(@Param('id') id: string) { return this.profiles.deleteFact(id); }
  @Patch('profile/:id') updateProfile(@Param('id') id: string, @Body() body: { status?: 'confirmed' | 'proposed' }) {
    return this.profiles.updateStatus(id, body.status === 'confirmed' ? 'confirmed' : 'proposed');
  }
}