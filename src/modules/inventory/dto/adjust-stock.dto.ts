import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class AdjustStockDto {
  @IsInt()
  @Min(0)
  quantity: number;

  @IsOptional()
  @IsString()
  note?: string;
}
