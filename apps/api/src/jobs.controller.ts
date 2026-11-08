import { BadRequestException, Body, Controller, Get, Param, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JobsService } from './jobs.service';
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
  constructor(private readonly jobs: JobsService) {}

  @Get('dashboard') dashboard() { return this.jobs.dashboard(); }
  @Get('settings') settings() { return this.jobs.getSettings(); }
  @Patch('settings') updateSettings(@Body() body: Record<string, any>) { return this.jobs.updateSettings(body); }
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
  @Post('profile/approve') approveProfile(@Body() body: { ids?: string[] }) { return this.jobs.approveProfile(body.ids ?? []); }
  @Post('profile') addProfile(@Body() body: { text?: string; section?: string }) { return this.jobs.addProfileLine(body); }
  @Post('profile/import')
  @UseInterceptors(documentUpload())
  importProfile(@UploadedFile() file?: UploadedDocument) { return this.jobs.importProfile(file); }
  @Post('profile/github') importGithub(@Body() body: { url?: string }) { return this.jobs.importGithub(body.url ?? ''); }
  @Patch('profile/:id') updateProfile(@Param('id') id: string, @Body() body: { status?: 'confirmed' | 'proposed' }) {
    return this.jobs.updateProfileLine(id, body.status === 'confirmed' ? 'confirmed' : 'proposed');
  }
}