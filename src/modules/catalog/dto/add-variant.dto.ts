import { Type } from 'class-transformer';
import { IsNumber, IsObject, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class AddVariantDto {
  @IsString()
  @MinLength(1)
  sku: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  purchasePrice: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  sellingPrice: number;
}
