import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, count, eq, getTableColumns, ilike, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { businesses, products, stock, variants } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { Money, SKU } from '../../common/domain';
import { Product, Variant } from './domain/product';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { AddVariantDto } from './dto/add-variant.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { ProductQueryDto } from './dto/product-query.dto';
import { VariantQueryDto } from './dto/variant-query.dto';

@ApiTags('catalog')
@Controller('api/v1/products')
export class CatalogController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async list(@CurrentTenant() tenant: Tenant, @Query() query: ProductQueryDto) {
    const filters = [eq(products.businessId, tenant.businessId)];
    if (query.category) filters.push(eq(products.category, query.category));

    const [data, countResult] = await Promise.all([
      this.db.db.select().from(products).where(and(...filters)).limit(query.limit).offset(query.offset),
      this.db.db.select({ value: count() }).from(products).where(and(...filters)),
    ]);
    const total = countResult[0]?.value ?? 0;
    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  @Get(':id')
  async get(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const [product] = await this.db.db
      .select()
      .from(products)
      .where(and(eq(products.id, id), eq(products.businessId, tenant.businessId)));
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  @Post()
  async create(@CurrentTenant() tenant: Tenant, @Body() body: CreateProductDto) {
    // Validate through the domain object even though we persist primitives
    // directly (see AUDIT_REPORT.md P2-1) — this is what actually exercises
    // Product's invariants instead of leaving the class dead code.
    Product.create('unassigned', body.name);

    const [product] = await this.db.db
      .insert(products)
      .values({ businessId: tenant.businessId, ...body })
      .returning();
    return product;
  }

  @Patch(':id')
  async update(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateProductDto) {
    if (body.name !== undefined) {
      const [existing] = await this.db.db
        .select()
        .from(products)
        .where(and(eq(products.id, id), eq(products.businessId, tenant.businessId)));
      if (!existing) throw new NotFoundException('Product not found');
      const domainProduct = Product.create(existing.id, existing.name);
      domainProduct.rename(body.name); // throws DomainError if invalid
    }

    const [product] = await this.db.db
      .update(products)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(products.id, id), eq(products.businessId, tenant.businessId)))
      .returning();
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  // NEW (v2.1, client-integration audit P0 §4): a product-detail screen
  // needs to list its own variants — this was previously impossible
  // without already knowing every variantId. Joins stock so a client
  // doesn't need a second round-trip per variant just to show quantity.
  @Get(':id/variants')
  async listVariants(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) productId: string, @Query() query: VariantQueryDto) {
    const [product] = await this.db.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, productId), eq(products.businessId, tenant.businessId)));
    if (!product) throw new NotFoundException('Product not found');

    const filters = [eq(variants.productId, productId), eq(variants.businessId, tenant.businessId)];
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(or(ilike(variants.name, term), ilike(variants.sku, term))!);
    }

    const [data, countResult] = await Promise.all([
      this.db.db
        .select({ ...getTableColumns(variants), quantity: sql<number>`coalesce(${stock.quantity}, 0)`.mapWith(Number) })
        .from(variants)
        .leftJoin(stock, eq(stock.variantId, variants.id))
        .where(and(...filters))
        .limit(query.limit)
        .offset(query.offset),
      this.db.db.select({ value: count() }).from(variants).where(and(...filters)),
    ]);
    const total = countResult[0]?.value ?? 0;
    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  @Post(':id/variants')
  async addVariant(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) productId: string, @Body() body: AddVariantDto) {
    const [product] = await this.db.db
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.businessId, tenant.businessId)));
    if (!product) throw new NotFoundException('Product not found');

    // ROUND 2 FIX: Money.fromDecimal() used to be called here with no
    // currency argument, silently defaulting to 'XOF' regardless of the
    // business's actual configured currency — the one field this codebase
    // treats as the source of truth for money elsewhere (sales, purchasing,
    // returns all fetch it before constructing Money). It was harmless
    // today only because nothing here compares this Money against another
    // instance, but it's a latent inconsistency worth closing rather than
    // leaving as a trap for the next feature that does compare currencies.
    const currency = await this.getCurrency(tenant.businessId);

    // Run the domain invariant (selling price >= purchase price, non-empty
    // name/SKU) before touching the database.
    new Variant(
      'unassigned',
      SKU.of(body.sku),
      body.name,
      Money.fromDecimal(body.purchasePrice, currency),
      Money.fromDecimal(body.sellingPrice, currency),
      body.attributes,
    );

    const [variant] = await this.db.db
      .insert(variants)
      .values({
        businessId: tenant.businessId,
        productId,
        sku: body.sku.trim(),
        name: body.name.trim(),
        attributes: body.attributes ?? {},
        purchasePrice: Money.fromDecimal(body.purchasePrice, currency).toDecimalString(),
        sellingPrice: Money.fromDecimal(body.sellingPrice, currency).toDecimalString(),
      })
      .returning();
    return variant;
  }

  private async getCurrency(businessId: string): Promise<string> {
    const [business] = await this.db.db.select({ currency: businesses.currency }).from(businesses).where(eq(businesses.id, businessId));
    return business?.currency ?? 'XOF';
  }

  // NEW (v2.1, client-integration audit P1 §10): variants had no way to
  // be corrected after creation (a typo in the SKU, a price change).
  // Validates the MERGED state (existing row + whichever fields were
  // sent) through the same domain invariant addVariant() already uses —
  // a partial update must never leave a variant in a state the domain
  // wouldn't have allowed at creation (selling price >= purchase price).
  // SKU uniqueness is enforced by the existing `variants_business_sku_unique`
  // constraint (schema.ts); a conflict surfaces as a 409 through the
  // already-global DomainExceptionFilter, no extra handling needed here.
  @Patch(':id/variants/:variantId')
  async updateVariant(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() body: UpdateVariantDto,
  ) {
    const [existing] = await this.db.db
      .select()
      .from(variants)
      .where(and(eq(variants.id, variantId), eq(variants.productId, productId), eq(variants.businessId, tenant.businessId)));
    if (!existing) throw new NotFoundException('Variant not found');

    const currency = await this.getCurrency(tenant.businessId);

    new Variant(
      existing.id,
      SKU.of(body.sku ?? existing.sku),
      body.name ?? existing.name,
      Money.fromDecimal(body.purchasePrice ?? existing.purchasePrice, currency),
      Money.fromDecimal(body.sellingPrice ?? existing.sellingPrice, currency),
      body.attributes ?? (existing.attributes as Record<string, string>),
    );

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.sku !== undefined) updates.sku = body.sku.trim();
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.attributes !== undefined) updates.attributes = body.attributes;
    if (body.purchasePrice !== undefined) updates.purchasePrice = Money.fromDecimal(body.purchasePrice, currency).toDecimalString();
    if (body.sellingPrice !== undefined) updates.sellingPrice = Money.fromDecimal(body.sellingPrice, currency).toDecimalString();

    const [variant] = await this.db.db
      .update(variants)
      .set(updates)
      .where(and(eq(variants.id, variantId), eq(variants.businessId, tenant.businessId)))
      .returning();
    return variant;
  }
}

/**
 * NEW (v2.1, client-integration audit P0 §4): a business-wide, searchable
 * variant browse — the endpoint a POS "find this item to add to the sale"
 * flow actually needs, since it doesn't know which product a variant
 * belongs to ahead of time. Deliberately a *separate* controller
 * (`/api/v1/variants`, not nested under `/products`) rather than a second
 * method on CatalogController, because Nest route paths are relative to
 * their controller's own prefix — `api/v1/products` can't also serve
 * `api/v1/variants` from the same class.
 */
@ApiTags('catalog')
@Controller('api/v1/variants')
export class VariantsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async list(@CurrentTenant() tenant: Tenant, @Query() query: VariantQueryDto) {
    const filters = [eq(variants.businessId, tenant.businessId)];
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(or(ilike(variants.name, term), ilike(variants.sku, term))!);
    }

    const [data, countResult] = await Promise.all([
      this.db.db
        .select({ ...getTableColumns(variants), quantity: sql<number>`coalesce(${stock.quantity}, 0)`.mapWith(Number) })
        .from(variants)
        .leftJoin(stock, eq(stock.variantId, variants.id))
        .where(and(...filters))
        .limit(query.limit)
        .offset(query.offset),
      this.db.db.select({ value: count() }).from(variants).where(and(...filters)),
    ]);
    const total = countResult[0]?.value ?? 0;
    return { data, page: query.page, pageSize: query.pageSize, total };
  }
}
