import { z } from "zod";
import { env } from "../../config/env.js";
import {
  MAX_SMS_MESSAGE_LENGTH,
  NOTIFICATION_TYPES,
  REMINDER_TEMPLATE_PLACEHOLDERS,
} from "./notification.templates.js";

export const NOTIFICATION_CHANNELS = Object.freeze(["IN_APP", "SMS", "EMAIL"]);
export const NOTIFICATION_STATUSES = Object.freeze(["PENDING", "SENT", "FAILED", "READ"]);

const optionalEnum = (values) => z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(values).optional(),
);

const requiredEnum = (values) => z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(values),
);

const optionalDateTime = (endOfDay = false) => z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().refine((value) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return !Number.isNaN(new Date(`${value}T00:00:00+08:00`).getTime());
    return z.iso.datetime({ offset: true }).safeParse(value).success;
  }, "Use YYYY-MM-DD or an ISO 8601 timestamp with an offset.")
    .transform((value) => new Date(
      /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+08:00`
        : value,
    ))
    .optional(),
);

const notificationFilterShape = {
  beneficiaryId: z.uuid().optional(),
  distributionId: z.uuid().optional(),
  scheduleId: z.uuid().optional(),
  channel: optionalEnum(NOTIFICATION_CHANNELS),
  notificationType: optionalEnum(NOTIFICATION_TYPES),
  status: optionalEnum(NOTIFICATION_STATUSES),
  dateFrom: optionalDateTime(false),
  dateTo: optionalDateTime(true),
};

function validateRange(schema) {
  return schema.superRefine((value, context) => {
    if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
      context.addIssue({
        code: "custom",
        path: ["dateTo"],
        message: "dateTo must be the same as or later than dateFrom.",
      });
    }
  });
}

export const notificationListQuerySchema = validateRange(z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  ...notificationFilterShape,
}).strict());

export const notificationSummaryQuerySchema = validateRange(z.object({
  ...notificationFilterShape,
}).strict());

export const distributionNotificationListQuerySchema = validateRange(z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  beneficiaryId: z.uuid().optional(),
  scheduleId: z.uuid().optional(),
  channel: optionalEnum(NOTIFICATION_CHANNELS),
  notificationType: optionalEnum(NOTIFICATION_TYPES),
  status: optionalEnum(NOTIFICATION_STATUSES),
  dateFrom: optionalDateTime(false),
  dateTo: optionalDateTime(true),
}).strict());

export const notificationIdSchema = z.object({
  notificationId: z.uuid(),
}).strict();

export const scheduleNotificationParamsSchema = z.object({
  scheduleId: z.uuid(),
}).strict();

const sendAt = z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional();

const optionalServiceArea = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(120).optional(),
);

const reminderMessageTemplate = z.string().trim().min(10).max(MAX_SMS_MESSAGE_LENGTH)
  .refine((value) => !/<\/?[a-z][\s\S]*>/i.test(value), "HTML markup is not allowed in reminder messages.")
  .refine((value) => {
    const placeholders = [...value.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1].toLowerCase());
    return placeholders.every((placeholder) => REMINDER_TEMPLATE_PLACEHOLDERS.includes(placeholder));
  }, `Use only these placeholders: ${REMINDER_TEMPLATE_PLACEHOLDERS.map((value) => `{${value}}`).join(", ")}.`);

const assistantReminderFields = {
  serviceArea: optionalServiceArea,
  messageTemplate: reminderMessageTemplate,
  sendAt,
};

export const assistantReminderPreviewSchema = z.object(assistantReminderFields).strict();

export const assistantReminderEnqueueSchema = z.object({
  ...assistantReminderFields,
  approvalId: z.uuid(),
  confirmed: z.literal(true),
  expectedRecipientCount: z.coerce.number().int().min(1).max(env.notificationBatchMaxSize),
  expectedPreviewHash: z.string().regex(/^[a-f0-9]{64}$/, "expectedPreviewHash must be a SHA-256 digest."),
}).strict();

function delayedReminderOnly(schema) {
  return schema.superRefine((value, context) => {
    if (value.sendAt && value.notificationType !== "DISTRIBUTION_REMINDER") {
      context.addIssue({
        code: "custom",
        path: ["sendAt"],
        message: "sendAt is supported only for DISTRIBUTION_REMINDER.",
      });
    }
  });
}

export const distributionNotificationEnqueueSchema = delayedReminderOnly(z.object({
  notificationType: requiredEnum(NOTIFICATION_TYPES),
  scheduleIds: z.array(z.uuid()).min(1).max(env.notificationBatchMaxSize).optional(),
  sendAt,
}).strict().superRefine((value, context) => {
  if (value.scheduleIds && new Set(value.scheduleIds).size !== value.scheduleIds.length) {
    context.addIssue({
      code: "custom",
      path: ["scheduleIds"],
      message: "scheduleIds must not contain duplicates.",
    });
  }
}));

export const scheduleNotificationEnqueueSchema = delayedReminderOnly(z.object({
  notificationType: requiredEnum(NOTIFICATION_TYPES),
  sendAt,
}).strict());

export const emptyNotificationBodySchema = z.object({}).strict();
