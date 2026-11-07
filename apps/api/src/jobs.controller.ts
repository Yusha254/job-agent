import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { JobsService } from './jobs.service';

@Controller()
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get('dashboard') dashboard() { return this.jobs.dashboard(); }
  @Post('jobs') addJob(@Body() body: { posting?: string; sourceUrl?: string; applyUrl?: string }) { return this.jobs.addJob(body); }
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
  @Patch('profile/:id') updateProfile(@Param('id') id: string, @Body() body: { status?: 'confirmed' | 'proposed' }) {
    return this.jobs.updateProfileLine(id, body.status === 'confirmed' ? 'confirmed' : 'proposed');
  }
}