import { Module } from '@nestjs/common';
import { ReturnsController } from './returns.controller';
import { CreateReturnUseCase } from './application/create-return.usecase';

@Module({
  controllers: [ReturnsController],
  providers: [CreateReturnUseCase],
})
export class ReturnsModule {}
