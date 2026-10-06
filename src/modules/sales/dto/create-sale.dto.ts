import { Type } from 'class-transformer';
import { ArrayMinSize, ArrayUnique, IsArray, IsInt, IsNumber, IsOptional, IsUUID, Min, ValidateNested } from 'class-validator';

export class SaleItemDto {
  @IsUUID()
  variantId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  // Intentionally no `unitPrice` here. The mission brief is explicit that a
  // client-supplied price must never be trusted as the source of truth —
  // the use-case always prices from the catalog (variants.sellingPrice).
  // See AUDIT_REPORT.md P0-4. If manual price overrides become a real
  // product requirement, that needs its own authorized "price override"
  // flow, not a body field anyone can set.
}

export class CreateSaleDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discount?: number;

  // ROUND 2 FIX: two line items referencing the same variant used to be
  // silently mis-accounted (see create-sale.usecase.ts — each line's stock
  // check ran against a stale snapshot, and the final write kept only the
  // LAST line's decrement, undercounting real depletion). There's no
  // legitimate reason to split one variant across two lines on a sale
  // (price always comes from the catalog, never per-line), so rejecting
  // the duplicate outright at the boundary is simpler and safer than
  // trying to merge them later — the client should send one line with the
  // combined quantity instead.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique((item: SaleItemDto) => item.variantId, {
    message: 'Duplicate variantId in items — combine into a single line with the total quantity',
  })
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[];
}
