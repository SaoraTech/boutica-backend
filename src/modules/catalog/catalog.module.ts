import { Module } from '@nestjs/common';
import { CatalogController, VariantsController } from './catalog.controller';

@Module({ controllers: [CatalogController, VariantsController] })
export class CatalogModule {}
