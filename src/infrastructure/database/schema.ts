import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const productStatus = pgEnum('product_status', ['ACTIVE', 'INACTIVE']);
export const saleStatus = pgEnum('sale_status', ['DRAFT', 'COMPLETED', 'CANCELLED']);
export const purchaseStatus = pgEnum('purchase_status', ['DRAFT', 'RECEIVED', 'CANCELLED']);
export const movementType = pgEnum('stock_movement_type', ['PURCHASE', 'SALE', 'RETURN', 'ADJUSTMENT', 'DAMAGE']);
export const userRole = pgEnum('user_role', ['OWNER', 'STAFF']);
export const returnStatus = pgEnum('return_status', ['COMPLETED', 'CANCELLED']);

export const businesses = pgTable('businesses', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  currency: text('currency').notNull().default('XOF'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// v2.0 — Better Auth owns this table now (mapped via drizzleAdapter's
// `schema: { user: schema.users, ... }` option in src/auth/auth.ts).
// id/name/email/emailVerified/image/createdAt/updatedAt are Better Auth's
// required core "user" fields — do not rename or drop them. Passwords are
// NOT stored here: Better Auth keeps them on `accounts` instead (one row
// per credential/provider), which is also where a future social-login
// provider would attach without touching this table.
//
// businessId/businessName/businessCurrency/role are Boutica's own
// `additionalFields` (see src/auth/auth.ts). businessName/businessCurrency
// are write-only at sign-up time — consumed by the databaseHooks.user.
// create.before hook to create the `businesses` row and never returned to
// clients afterward — but the columns stay on this table because that's
// where Better Auth's Drizzle adapter needs to write them; there's no
// clean way to route a single field through a hook into a different table
// before the row exists yet to reference.
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // Set by the create-hook before insert, never by client input — see
    // AUDIT_REPORT.md section H. NOT NULL is deliberate defense-in-depth:
    // if the hook is ever bypassed or refactored incorrectly, insertion
    // fails loudly instead of silently creating a tenant-less user.
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    businessName: text('business_name'),
    businessCurrency: text('business_currency'),
    role: userRole('role').notNull().default('OWNER'),
  },
  (t) => ({
    emailUnique: uniqueIndex('users_email_unique').on(t.email),
    businessIdx: index('users_business_idx').on(t.businessId),
  }),
);

// Better Auth "session" core model.
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ userIdx: index('sessions_user_idx').on(t.userId) }),
);

// Better Auth "account" core model — one row per credential/provider per
// user. For email+password (the only provider this app enables), this is
// where the password hash actually lives (Better Auth's own scrypt-based
// hashing, not bcrypt — see AUDIT_REPORT.md section H for why bcrypt was
// dropped rather than kept alongside it).
export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ userIdx: index('accounts_user_idx').on(t.userId) }),
);

// Better Auth "verification" core model — required by the adapter even
// though this app doesn't enable email verification or password-reset
// emails today (no email-sending infrastructure exists); Better Auth
// writes to it internally regardless of which features are switched on.
export const verifications = pgTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ identifierIdx: index('verifications_identifier_idx').on(t.identifier) }),
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category'),
    brand: text('brand'),
    status: productStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ businessNameIdx: index('products_business_name_idx').on(t.businessId, t.name) }),
);

export const variants = pgTable(
  'variants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Denormalized on purpose: the inventory/sales/purchasing hot paths key
    // directly off variantId with no join to products, so businessId must
    // live here too or tenant filtering on those paths is impossible
    // without a join on every single query. See AUDIT_REPORT.md P0-1/P0-2.
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    attributes: jsonb('attributes').$type<Record<string, string>>().notNull().default({}),
    purchasePrice: numeric('purchase_price', { precision: 14, scale: 2 }).notNull().default('0'),
    sellingPrice: numeric('selling_price', { precision: 14, scale: 2 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // FIX: SKU used to be globally unique across ALL tenants, which makes
    // the product unusable by more than one business at a time (two
    // unrelated shops both want to use "SKU-001"). Scoped to the business
    // instead. See AUDIT_REPORT.md P1-1.
    skuPerBusinessIdx: uniqueIndex('variants_business_sku_unique').on(t.businessId, t.sku),
    productIdx: index('variants_product_idx').on(t.productId),
    businessIdx: index('variants_business_idx').on(t.businessId),
    sellingGtePurchase: check('variant_selling_gte_purchase', sql`${t.sellingPrice} >= ${t.purchasePrice}`),
    pricesNonNegative: check('variant_prices_non_negative', sql`${t.purchasePrice} >= 0 AND ${t.sellingPrice} >= 0`),
  }),
);

export const stock = pgTable(
  'stock',
  {
    variantId: uuid('variant_id').primaryKey().references(() => variants.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    quantity: integer('quantity').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessIdx: index('stock_business_idx').on(t.businessId),
    // Last-resort, defence-in-depth invariant: even if application-level
    // locking is ever bypassed or buggy, Postgres itself will refuse to let
    // stock go negative. See AUDIT_REPORT.md P0-2.
    quantityNonNegative: check('stock_quantity_non_negative', sql`${t.quantity} >= 0`),
  }),
);

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    variantId: uuid('variant_id').notNull().references(() => variants.id),
    type: movementType('type').notNull(),
    quantity: integer('quantity').notNull(),
    referenceId: uuid('reference_id'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    variantDateIdx: index('stock_movements_variant_date_idx').on(t.variantId, t.createdAt),
    businessIdx: index('stock_movements_business_idx').on(t.businessId),
  }),
);

export const suppliers = pgTable('suppliers', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').notNull().references(() => businesses.id),
  name: text('name').notNull(),
  phone: text('phone'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const purchases = pgTable('purchases', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').notNull().references(() => businesses.id),
  supplierId: uuid('supplier_id').references(() => suppliers.id),
  status: purchaseStatus('status').notNull().default('DRAFT'),
  total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const purchaseItems = pgTable('purchase_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  purchaseId: uuid('purchase_id').notNull().references(() => purchases.id, { onDelete: 'cascade' }),
  variantId: uuid('variant_id').notNull().references(() => variants.id),
  quantity: integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
}, (t) => ({
  quantityPositive: check('purchase_items_quantity_positive', sql`${t.quantity} > 0`),
}));

export const customers = pgTable('customers', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').notNull().references(() => businesses.id),
  name: text('name').notNull(),
  phone: text('phone'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const sales = pgTable(
  'sales',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    customerId: uuid('customer_id').references(() => customers.id),
    status: saleStatus('status').notNull().default('DRAFT'),
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull().default('0'),
    discount: numeric('discount', { precision: 14, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    discountWithinSubtotal: check('sales_discount_within_subtotal', sql`${t.discount} >= 0 AND ${t.discount} <= ${t.subtotal}`),
  }),
);

export const saleItems = pgTable('sale_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  saleId: uuid('sale_id').notNull().references(() => sales.id, { onDelete: 'cascade' }),
  variantId: uuid('variant_id').notNull().references(() => variants.id),
  quantity: integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
  // NEW (v2.0) — the variant's purchasePrice *at the moment of this sale*,
  // captured once and never updated again. Fixes the caveat flagged in
  // AUDIT_REPORT.md round 2 (R2-5): margin/profit reporting used to read
  // variants.purchasePrice, the CURRENT cost, so an old sale's reported
  // margin would silently drift if the variant's cost changed later.
  // Nullable only because rows created before this migration have no
  // historical value to backfill; every new sale populates it.
  costAtSale: numeric('cost_at_sale', { precision: 14, scale: 2 }),
}, (t) => ({
  quantityPositive: check('sale_items_quantity_positive', sql`${t.quantity} > 0`),
}));

export const expenses = pgTable('expenses', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').notNull().references(() => businesses.id),
  category: text('category').notNull(),
  description: text('description'),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// NEW — Returns did not exist at all. See AUDIT_REPORT.md P0-3.
export const returns = pgTable(
  'returns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    saleId: uuid('sale_id').notNull().references(() => sales.id),
    status: returnStatus('status').notNull().default('COMPLETED'),
    total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessIdx: index('returns_business_idx').on(t.businessId),
    saleIdx: index('returns_sale_idx').on(t.saleId),
  }),
);

export const returnItems = pgTable('return_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  returnId: uuid('return_id').notNull().references(() => returns.id, { onDelete: 'cascade' }),
  saleItemId: uuid('sale_item_id').notNull().references(() => saleItems.id),
  variantId: uuid('variant_id').notNull().references(() => variants.id),
  quantity: integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
  // RESTOCK -> goes back into sellable stock. DAMAGED -> logged as a DAMAGE
  // stock movement, never re-enters sellable stock.
  condition: text('condition').notNull().default('RESTOCK'),
}, (t) => ({
  quantityPositive: check('return_items_quantity_positive', sql`${t.quantity} > 0`),
  conditionValid: check('return_items_condition_valid', sql`${t.condition} IN ('RESTOCK','DAMAGED')`),
}));

// NEW — supports the Idempotency-Key handling for Create Sale / Receive
// Purchase / Create Return. See AUDIT_REPORT.md P0-5.
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    endpoint: text('endpoint').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    scopeUnique: uniqueIndex('idempotency_keys_scope_unique').on(t.businessId, t.endpoint, t.key),
  }),
);
