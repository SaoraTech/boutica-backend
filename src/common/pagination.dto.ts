import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Every list endpoint used to return the entire table with no limit
 * (AUDIT_REPORT.md P2 "pagination"). This is the shared query DTO for
 * bounded, page-based listing.
 */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  get offset(): number {
    return (this.page - 1) * this.pageSize;
  }

  get limit(): number {
    return this.pageSize;
  }
}

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
}
