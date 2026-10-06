import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination.dto';

/**
 * NEW (v2.1) — backs both GET /api/v1/variants and
 * GET /api/v1/products/:id/variants. `search` matches against the
 * variant's name or SKU (case-insensitive, partial) — the minimum needed
 * for a POS-style "find this item" flow, without building a full search
 * engine for what is, for any single business, a small catalog.
 */
export class VariantQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
