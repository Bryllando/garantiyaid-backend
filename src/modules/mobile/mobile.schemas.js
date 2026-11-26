import { z } from "zod";
import { optionalPhilippineMobileSchema } from "../../lib/philippine-mobile.js";
import { createBeneficiarySchema } from "../beneficiaries/beneficiary.schemas.js";
import { chatbotMessageSchema } from "../chatbot/chatbot.schemas.js";

const name = z.string().trim().min(1).max(100)
  .regex(/^[\p{L}\p{M} .'’-]+$/u, "Use letters and normal name punctuation only.")
  .refine((value) => /\p{L}/u.test(value), "Enter a name containing letters.");
const middleName = z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? null : value,
  name.nullable().optional(),
);
const address = z.string().trim().min(5).max(500);
const barangayId = z.uuid();
const contactNumber = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const compact = value.trim().replace(/[\s()-]/g, "");
  return /^9\d{9}$/.test(compact) ? `+63${compact}` : /^639\d{9}$/.test(compact) ? `+${compact}` : compact;
}, optionalPhilippineMobileSchema().pipe(z.string()));
const purpose = z.enum(["register", "login"]);

export const mobileRegistrationSchema = createBeneficiarySchema.pick({ birthDate: true }).extend({
  firstName: name, middleName, lastName: name, address, barangayId, contactNumber,
  sex: z.preprocess(
    (value) => typeof value === "string" ? value.trim().toLowerCase().replaceAll(" ", "_") : value,
    z.enum(["female", "male", "prefer_not_to_say"]),
  ).transform((value) => ({ female: "FEMALE", male: "MALE", prefer_not_to_say: "UNKNOWN" })[value]),
}).strict();

export const mobileOtpRequestSchema = z.object({ contactNumber, purpose }).strict();
export const mobileNotificationParamsSchema = z.object({ notificationId: z.uuid() }).strict();
export const mobileNotificationPreferencesSchema = z.object({
  enrollmentUpdates: z.boolean(), scheduleUpdates: z.boolean(), claimUpdates: z.boolean(),
}).strict();
// Expo push tokens travel only in this JSON body; messages never repeat the submitted value.
export const mobilePushDeviceSchema = z.object({
  token: z.string().regex(/^(?:Exponent|Expo)PushToken\[[A-Za-z0-9_-]{8,200}\]$/, "Use a valid Expo push token."),
  platform: z.literal("android"),
  language: z.enum(["en", "bs"]),
}).strict();
export const mobileBiometricConsentSchema = z.object({ consentVersion: z.string().min(1).max(20),
  retentionUntil: z.iso.datetime(), expectedConsentId: z.uuid().nullable() }).strict();
export const mobileBiometricConsentParamsSchema = z.object({ consentId: z.uuid() }).strict();
export const mobileSupportCreateSchema = chatbotMessageSchema.extend({ requestId: z.uuid(), language: z.enum(["en", "bs"]).transform(value => value === "bs" ? "ceb" : "en") }).strict();
export const mobileSupportReplySchema = chatbotMessageSchema.extend({ messageId: z.uuid() }).strict();
export const mobileSupportParamsSchema = z.object({ requestId: z.uuid() }).strict();
export const mobileSupportListSchema = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(20).default(20) }).strict();
export const mobileDocumentRequirementQuerySchema = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(20).default(10) }).strict();
export const mobileOtpVerificationSchema = mobileOtpRequestSchema.extend({ code: z.string().regex(/^\d{6}$/) }).strict();
export const mobileProfileSchema = mobileRegistrationSchema.pick({
  firstName: true, middleName: true, lastName: true, address: true, barangayId: true, birthDate: true,
}).partial().strict().refine((value) => Object.keys(value).length > 0, "Supply the details to correct.");
