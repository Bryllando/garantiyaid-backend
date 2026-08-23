import { z } from "zod";

const optionalText = (maxLength) => z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().max(maxLength).optional(),
);

export const barangayIdSchema = z.object({
  barangayId: z.uuid(),
});

export const createBarangaySchema = z.object({
  barangayCode: optionalText(20),
  barangayName: z.string().trim().min(1).max(100),
  city: z.string().trim().min(1).max(100),
  province: z.string().trim().min(1).max(100),
});

export const updateBarangaySchema = createBarangaySchema.partial().extend({
  isActive: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field must be supplied.");

export const barangayListQuerySchema = z.object({
  activeOnly: z.enum(["true", "false"]).optional().default("true"),
  search: optionalText(100),
});
