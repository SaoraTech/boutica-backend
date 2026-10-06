import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { CreateSaleUseCase } from './application/create-sale.usecase';

@Module({
  controllers: [SalesController],
  providers: [CreateSaleUseCase],
})
export class SalesModule {}
