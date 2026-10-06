import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination.dto';

// NEW (v2.1) — backs GET /api/v1/sales. `customerId` doubles as this
// business's answer to "a customer's purchase history" (client-integration
// audit P1 §9) — filtering the same list endpoint rather than adding a
// second, near-duplicate one under /customers/:id.
export class ListSalesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;
}
