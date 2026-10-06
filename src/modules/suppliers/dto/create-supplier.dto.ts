import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// Mirrors CreateCustomerDto exactly — same shape, same reasoning.
export class CreateSupplierDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}
