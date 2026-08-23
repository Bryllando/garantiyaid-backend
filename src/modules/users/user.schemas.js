import { z } from "zod";
import { newStaffPasswordSchema } from "../auth/password.schemas.js";

const staffRoles = ["SYSTEM_ADMIN", "DSWD_STAFF", "BARANGAY_FACILITATOR"];
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

export const createStaffUserSchema = z.object({
  employeeId: z.string().trim().min(1).max(30).transform((value) => value.toUpperCase()),
  username: optionalUsername,
  fullName: z.string().trim().min(1).max(150),
  email: z.string().trim().toLowerCase().email().max(150),
  password: newStaffPasswordSchema,
  role: z.enum(staffRoles),
  contactNumber: optionalText(20),
  barangayId: optionalBarangayId,
}).strict().superRefine((value, context) => {
  if (usernameRoles.includes(value.role) && !value.username) {
    context.addIssue({
      code: "custom",
      path: ["username"],
      message: "A username is required for System Administrators and Barangay Facilitators.",
    });
  }

  if (value.role === "DSWD_STAFF" && value.username) {
    context.addIssue({
      code: "custom",
      path: ["username"],
      message: "DSWD Staff must log in with their official employee ID and cannot have a username.",
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
  contactNumber: optionalText(20),
  role: z.enum(staffRoles).optional(),
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
  search: optionalText(100),
});
