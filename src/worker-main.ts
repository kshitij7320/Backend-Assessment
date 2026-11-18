import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { WorkerService } from './judge/worker.service';

async function bootstrapWorker() {
  process.env.SERVICE_NAME = 'shodh-worker';
  process.env.WORKER_ENABLED = 'true';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const worker = app.get(WorkerService);
  worker.startPolling();

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'shodh-worker',
      event: 'standalone_worker_started',
      worker_id: process.env.WORKER_ID || 'standalone-worker',
      execution_mode: process.env.JUDGE_EXECUTION_MODE || 'docker',
    }),
  );

  const shutdown = async () => {
    worker.stopPolling();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrapWorker().catch((err) => {
  console.error(err);
  process.exit(1);
});
