import { z } from "zod";
import { optionalPhilippineMobileSchema } from "../../lib/philippine-mobile.js";

const staffRoles = ["SYSTEM_ADMIN", "DSWD_STAFF", "BARANGAY_FACILITATOR"];
const creatableStaffRoles = ["DSWD_STAFF", "BARANGAY_FACILITATOR"];
const usernameRoles = ["SYSTEM_ADMIN", "BARANGAY_FACILITATOR"];
const username = z.string().trim().toLowerCase().min(4).max(30).regex(
  /^[a-z][a-z0-9._]{3,29}$/,
  "Username must start with a letter and use only lowercase letters, numbers, dots, or underscores.",
);
const optionalText = (maxLength) => z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().max(maxLength).optional(),
);

const optionalBarangayId = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.uuid().optional(),
);

const optionalUsername = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  username.optional(),
);

export const userIdSchema = z.object({
  userId: z.uuid(),
});

export const resetStaffTotpSchema = z.object({
  staffIdVerified: z.boolean().refine(Boolean, "Verify the staff ID before resetting TOTP."),
  validIdVerified: z.boolean().refine(Boolean, "Verify a valid ID before resetting TOTP."),
  supervisorConfirmed: z.boolean().refine(Boolean, "Obtain supervisor confirmation before resetting TOTP."),
}).strict();

export const deleteStaffUserSchema = z.object({
  confirmation: z.string().trim().min(1).max(80),
}).strict();

export const createStaffUserSchema = z.object({
  username: optionalUsername,
  fullName: z.string().trim().min(1).max(150),
  email: z.string().trim().toLowerCase().email().max(150),
  role: z.enum(creatableStaffRoles),
  contactNumber: optionalPhilippineMobileSchema(undefined),
  barangayId: optionalBarangayId,
}).strict().superRefine((value, context) => {
  if (usernameRoles.includes(value.role) && !value.username) {
    context.addIssue({
      code: "custom",
      path: ["username"],
      message: "A username is required for Barangay Facilitators.",
    });
  }

  if (value.role === "DSWD_STAFF" && value.username) {
    context.addIssue({
      code: "custom",
      path: ["username"],
      message: "DSWD Staff sign in with their generated Staff ID and cannot have a username.",
    });
  }

  if (value.role === "BARANGAY_FACILITATOR" && !value.barangayId) {
    context.addIssue({
      code: "custom",
      path: ["barangayId"],
      message: "A barangay facilitator must be assigned to an active barangay.",
    });
  }

  if (value.role !== "BARANGAY_FACILITATOR" && value.barangayId) {
    context.addIssue({
      code: "custom",
      path: ["barangayId"],
      message: "Only barangay facilitators can have a barangay assignment.",
    });
  }
});

export const updateStaffUserSchema = z.object({
  username: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.union([username, z.null()]).optional(),
  ),
  fullName: z.string().trim().min(1).max(150).optional(),
  email: z.string().trim().toLowerCase().email().max(150).optional(),
  contactNumber: optionalPhilippineMobileSchema(),
  barangayId: z.union([z.uuid(), z.null()]).optional(),
  isActive: z.boolean().optional(),
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field must be supplied.",
);

export const staffUserListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  role: z.enum(staffRoles).optional(),
  isActive: z.enum(["true", "false"]).optional(),
  archived: z.enum(["true", "false"]).default("false"),
  search: optionalText(100),
});
