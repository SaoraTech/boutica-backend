import { PartialType } from '@nestjs/swagger';
import { AddVariantDto } from './add-variant.dto';

// NEW (v2.1) — every field on AddVariantDto (sku, name, attributes,
// purchasePrice, sellingPrice) becomes optional; the same validators
// still apply to whichever fields are actually sent. Same pattern already
// used by UpdateProductDto for the parent resource.
export class UpdateVariantDto extends PartialType(AddVariantDto) {}
