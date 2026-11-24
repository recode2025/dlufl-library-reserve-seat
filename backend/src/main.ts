import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { appConfig } from './config/app.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 信任反向代理头，确保 CAS 回调协议与 Host 判断准确（对齐 hydrooj-oauth-dlufl）
  const httpAdapter = app.getHttpAdapter();
  const expressInstance = httpAdapter.getInstance();
  expressInstance.set('trust proxy', 1);

  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: [appConfig.frontendUrl, appConfig.publicBaseUrl].filter(Boolean),
    credentials: true,
  });

  await app.listen(appConfig.port);
  console.log(
    `[DLUFL Library Backend] listening on http://localhost:${appConfig.port}/api (mockMode=${appConfig.mockMode})`,
  );
}

bootstrap();
