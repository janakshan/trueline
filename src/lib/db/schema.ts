import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Mirrors db/migrations/*.sql. The SQL is the source of truth; this file exists
 * so queries are typed. Regenerate with `drizzle-kit pull` after changing a
 * migration rather than editing both by hand.
 */

export const DOCUMENT_STATUSES = [
  "queued",
  "processing",
  "needs_review",
  "approved",
  "failed",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
] as const;
export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    filename: text("filename").notNull(),
    mimeType: text("mime_type").$type<SupportedMimeType>().notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    pageCount: integer("page_count"),
    storagePath: text("storage_path").notNull(),

    status: text("status").$type<DocumentStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("documents_user_created_idx").on(t.userId, t.createdAt),
    index("documents_user_status_idx").on(t.userId, t.status),
  ],
);

export interface LineItem {
  line_number: number;
  description: string;
  quantity: number;
  unit_price: number | null;
  line_total: number;
}

export interface ExtractionData {
  document_type: "invoice" | "receipt";
  vendor_name: string | null;
  vendor_address: string | null;
  vendor_tax_id: string | null;
  invoice_number: string | null;
  issue_date: string | null;
  due_date: string | null;
  currency: string | null;
  subtotal: number | null;
  tax_amount: number | null;
  tax_rate: number | null;
  shipping_amount: number | null;
  service_charge: number | null;
  discount_amount: number | null;
  total_amount: number | null;
  payment_method: string | null;
  line_items: LineItem[];
}

export interface ValidationIssue {
  field: string;
  severity: "check" | "conflict";
  message: string;
}

export interface EditRecord {
  field: string;
  from: unknown;
  to: unknown;
  at: string;
}

export const extractions = pgTable(
  "extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),

    data: jsonb("data").$type<ExtractionData>().notNull(),
    confidence: jsonb("confidence")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    validationIssues: jsonb("validation_issues")
      .$type<ValidationIssue[]>()
      .notNull()
      .default([]),
    reviewedFields: text("reviewed_fields").array().notNull().default([]),
    edits: jsonb("edits").$type<EditRecord[]>().notNull().default([]),
    isCurrent: boolean("is_current").notNull().default(true),

    model: text("model"),
    effort: text("effort"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    rawResponse: text("raw_response"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // Maintained by Postgres from `data`. Declared generated so a typed insert
    // cannot try to set them — the database would reject it at runtime.
    vendorName: text("vendor_name").generatedAlwaysAs(sql`(data->>'vendor_name')`),
    currency: text("currency").generatedAlwaysAs(sql`(data->>'currency')`),
    totalAmount: numeric("total_amount", { precision: 14, scale: 2 })
      .generatedAlwaysAs(sql`(CASE WHEN data->>'total_amount' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (data->>'total_amount')::numeric END)`),
    issueDate: text("issue_date")
      .generatedAlwaysAs(sql`(CASE WHEN data->>'issue_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN data->>'issue_date' END)`),
    lineItemCount: integer("line_item_count")
      .generatedAlwaysAs(sql`(CASE WHEN jsonb_typeof(data->'line_items') = 'array' THEN jsonb_array_length(data->'line_items') END)`),
  },
  (t) => [
    uniqueIndex("extractions_one_current_per_document")
      .on(t.documentId)
      .where(sql`is_current`),
    index("extractions_document_created_idx").on(t.documentId, t.createdAt),
  ],
);

export type DocumentRow = typeof documents.$inferSelect;
export type NewDocumentRow = typeof documents.$inferInsert;
export type ExtractionRow = typeof extractions.$inferSelect;

/**
 * Mirrors db/migrations/0002_extraction_usage.sql.
 *
 * One row per billable extraction attempt. The in-memory limiter cannot bound
 * spend across serverless instances, so the money guard reads and writes here.
 */
export const extractionUsage = pgTable(
  "extraction_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientKey: text("client_key").notNull(),
    userId: uuid("user_id"),
    documentId: uuid("document_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("extraction_usage_client_created_idx").on(t.clientKey, t.createdAt),
    index("extraction_usage_created_idx").on(t.createdAt),
  ],
);

export type ExtractionUsageRow = typeof extractionUsage.$inferSelect;
