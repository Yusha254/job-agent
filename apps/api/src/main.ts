import 'reflect-metadata';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';

config({ path: resolve(__dirname, '../../../.env') });

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.path === '/api/profile/import') {
      const size = request.headers['content-length'] ?? 'streamed';
      console.info(`[CV upload] request received: ${request.method}, ${size} bytes`);
      response.once('finish', () => console.info(`[CV upload] response finished: ${response.statusCode}`));
      response.once('close', () => {
        if (!response.writableEnded) console.error('[CV upload] response closed before completion');
      });
    }
    next();
  });
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' });
  app.setGlobalPrefix('api');
  await app.listen(Number(process.env.PORT ?? 4000));
}

void bootstrap();