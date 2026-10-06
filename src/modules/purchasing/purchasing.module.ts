import { Module } from '@nestjs/common';
import { PurchasingController } from './purchasing.controller';
import { ReceivePurchaseUseCase } from './application/receive-purchase.usecase';

@Module({
  controllers: [PurchasingController],
  providers: [ReceivePurchaseUseCase],
})
export class PurchasingModule {}
