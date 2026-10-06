import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsEnum, IsInt, IsOptional, IsString, IsUUID, Min, MaxLength, ValidateNested } from 'class-validator';

export class ReturnItemDto {
  @IsUUID()
  saleItemId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsEnum(['RESTOCK', 'DAMAGED'])
  condition?: 'RESTOCK' | 'DAMAGED';
}

export class CreateReturnDto {
  @IsUUID()
  saleId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items: ReturnItemDto[];
}
