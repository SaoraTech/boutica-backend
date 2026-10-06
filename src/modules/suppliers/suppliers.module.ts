import { Module } from '@nestjs/common';
import { SuppliersController } from './suppliers.controller';

@Module({ controllers: [SuppliersController] })
export class SuppliersModule {}
