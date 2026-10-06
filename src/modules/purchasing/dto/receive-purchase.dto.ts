import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, IsUUID, Min, ValidateNested } from 'class-validator';

export class PurchaseItemDto {
  @IsUUID()
  variantId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  // Unlike sales, a purchase's unit price genuinely IS supplied by the
  // caller — it's what the business actually paid the supplier, which the
  // system has no other source of truth for. It's still bounded/validated
  // below (see AUDIT_REPORT.md P0-4).
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  unitPrice: number;
}

export class ReceivePurchaseDto {
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemDto)
  items: PurchaseItemDto[];
}
