import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../dist/app.module';

async function main() {
  process.env.LOG_SILENT = 'true';
  process.env.WORKER_ENABLED = 'false';

  const app = await NestFactory.create(AppModule, { logger: false });
  const config = new DocumentBuilder()
    .setTitle('Shodh a Code — Contest Platform API')
    .setDescription(
      'Multi-tenant coding contest platform backend with versioned problems, isolated Docker judge, fenced lease workers, and deterministic standings.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const docsDir = path.resolve(process.cwd(), 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const outPath = path.join(docsDir, 'openapi.json');
  fs.writeFileSync(outPath, JSON.stringify(document, null, 2));
  console.log(JSON.stringify({ event: 'openapi_exported', path: outPath }));
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
