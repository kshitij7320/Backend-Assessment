import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { runMigrations } from './db/migrate';
import { DatabaseService } from './db/database.service';
import { seedDeterministicData } from './db/seed';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });

  const dbService = app.get(DatabaseService);
  if (process.env.AUTO_MIGRATE !== 'false') {
    await runMigrations({ pool: dbService.getPool() });
  }
  if (process.env.AUTO_SEED === 'true') {
    await seedDeterministicData(dbService.getPool());
  }

  const config = new DocumentBuilder()
    .setTitle('Shodh a Code — Contest Platform API')
    .setDescription(
      'Multi-tenant coding contest platform backend with versioned problems, isolated Docker judge, fenced lease workers, and deterministic standings.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '0.0.0.0');
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'shodh-api',
      event: 'server_started',
      port,
      execution_mode: process.env.JUDGE_EXECUTION_MODE || 'docker',
    }),
  );
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
