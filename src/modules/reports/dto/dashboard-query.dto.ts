import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Min } from 'class-validator';

export class DashboardQueryDto {
  // Inclusive start of the reporting window. Defaults to the first day of
  // the current calendar month (see ReportsController) if omitted.
  @IsOptional()
  @IsDateString()
  from?: string;

  // Inclusive end of the reporting window. Defaults to "now" if omitted.
  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  lowStockThreshold: number = 5;
}
