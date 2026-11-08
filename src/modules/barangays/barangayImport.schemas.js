import { z } from "zod";

export const previewBarangayImportSchema = z.object({
  rows: z.array(z.object({
    sourceRow: z.number().int().min(2).max(100_000),
    barangayName: z.string().max(300),
    barangayCode: z.string().max(100).optional(),
    city: z.string().max(300),
    province: z.string().max(300),
  }).strict()).min(1).max(500).refine(rows => new Set(rows.map(row => row.sourceRow)).size === rows.length, "Source row numbers must be unique."),
}).strict();

export const confirmBarangayImportSchema = previewBarangayImportSchema.extend({
  approvalId: z.uuid(),
  confirmed: z.literal(true),
}).strict();
