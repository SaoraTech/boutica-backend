import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';

async function bootstrap() {
  // v2.0: Nest's built-in body parser is disabled — Better Auth needs the
  // raw, un-parsed request stream for its own routes (it does its own
  // parsing internally). `express.json()` is added back explicitly below,
  // registered AFTER AuthModule's handler is already wired by
  // NestFactory.create(), so Better Auth still sees requests first/raw and
  // every other route still gets `req.body` populated exactly as before —
  // see the current Better Auth NestJS integration docs, which document
  // this exact ordering requirement.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const logger = new Logger('Bootstrap');
  // ROUND 2 FIX: env vars used to be read raw off process.env here, with a
  // manual fail-closed check duplicated just for CORS_ORIGIN. Everything
  // this file needs is now validated once, centrally, in
  // src/config/env.schema.ts — ConfigService just serves the already-typed,
  // already-validated result.
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // FIX (P1-4): the original code called `setGlobalPrefix('api')` on top of
  // controllers that already declare their full path as `api/v1/...`
  // (e.g. `@Controller('api/v1/products')`). setGlobalPrefix prepends its
  // prefix unconditionally, so the actual routes were `/api/api/v1/...`,
  // not the `/api/v1/...` the README documents. Every controller already
  // states its own explicit versioned path, so no global prefix is applied
  // here — `health` deliberately stays unprefixed, matching common
  // infra/health-check conventions, and Better Auth's routes keep their own
  // `/api/auth/*` convention (see src/auth/auth.ts).
  app.use(helmet());
  app.use(express.json());

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      // Reject with a 400 that lists every offending field instead of only
      // the first one — more useful for API consumers debugging a payload.
      stopAtFirstError: false,
    }),
  );

  // FIX (P1-3, now enforced centrally): the previous default (`?? true`)
  // reflected ANY origin when CORS_ORIGIN wasn't set, which is an unsafe
  // default for a production deployment. envSchema's .refine() already
  // guarantees CORS_ORIGIN is set once NODE_ENV=production — the app would
  // not have reached this line otherwise — so this is just parsing, not
  // re-enforcing the policy.
  const corsOrigin = config.get('CORS_ORIGIN', { infer: true })?.split(',').map((o) => o.trim());
  app.enableCors({ origin: corsOrigin ?? ['http://localhost:5173'], credentials: true });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Boutica API')
    .setDescription('Boutica commerce management API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  logger.log(`Boutica backend listening on port ${port}`);
}
bootstrap();
