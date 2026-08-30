import { randomBytes } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { staffUserSelect } from "../auth/auth.service.js";

export { staffUserSelect };

export function generateTemporaryPassword() {
  return randomBytes(12).toString("base64url");
}

export async function getStaffUserOrThrow(userId) {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: staffUserSelect,
  });

  if (!user) {
    throw new AppError(404, "STAFF_USER_NOT_FOUND", "Staff user was not found.");
  }

  return user;
}

export async function assertActiveBarangay(barangayId) {
  const barangay = await prisma.barangay.findUnique({
    where: { barangayId },
    select: { barangayId: true, isActive: true },
  });

  if (!barangay) {
    throw new AppError(404, "BARANGAY_NOT_FOUND", "Barangay was not found.");
  }

  if (!barangay.isActive) {
    throw new AppError(400, "BARANGAY_INACTIVE", "Staff cannot be assigned to an inactive barangay.");
  }
}

export async function assertStaffLoginIdentifiersAvailable(
  { employeeId, username },
  excludedUserId,
  database = prisma,
) {
  if (username && username.toUpperCase() === employeeId.toUpperCase()) {
    throw new AppError(
      409,
      "STAFF_IDENTIFIER_CONFLICT",
      "Username and Staff ID must be different.",
    );
  }

  const conflict = await database.user.findFirst({
    where: {
      ...(excludedUserId ? { userId: { not: excludedUserId } } : {}),
      OR: [
        { employeeId: { equals: employeeId, mode: "insensitive" } },
        { username: { equals: employeeId, mode: "insensitive" } },
        ...(username ? [
          { username: { equals: username, mode: "insensitive" } },
          { employeeId: { equals: username, mode: "insensitive" } },
        ] : []),
      ],
    },
    select: { userId: true },
  });

  if (conflict) {
    throw new AppError(
      409,
      "STAFF_IDENTIFIER_CONFLICT",
      "That username or Staff ID is already used by another staff account.",
    );
  }
}

const generatedStaffIdPrefixes = Object.freeze({
  DSWD_STAFF: "DSWD",
  BARANGAY_FACILITATOR: "BSTF",
});

export function formatGeneratedStaffId(role, sequenceValue) {
  const prefix = generatedStaffIdPrefixes[role];

  if (!prefix || sequenceValue == null) {
    throw new AppError(500, "STAFF_ID_GENERATION_FAILED", "A Staff ID could not be generated.");
  }

  const number = BigInt(sequenceValue);

  if (number < 1n) {
    throw new AppError(500, "STAFF_ID_GENERATION_FAILED", "A Staff ID could not be generated.");
  }

  return `${prefix}-${number.toString().padStart(4, "0")}`;
}

export async function generateStaffId(role, database) {
  const rows = role === "DSWD_STAFF"
    ? await database.$queryRaw`SELECT nextval('dswd_staff_id_seq') AS value`
    : role === "BARANGAY_FACILITATOR"
      ? await database.$queryRaw`SELECT nextval('barangay_staff_id_seq') AS value`
      : null;

  return formatGeneratedStaffId(role, rows?.[0]?.value);
}

export function resolveStaffUserUpdate(existingUser, input) {
  if (Object.hasOwn(input, "role")) {
    throw new AppError(
      400,
      "STAFF_ROLE_IMMUTABLE",
      "A staff account role cannot be changed after its Staff ID is assigned.",
    );
  }

  const nextRole = existingUser.role;
  const submittedBarangayId = Object.hasOwn(input, "barangayId")
    ? input.barangayId
    : existingUser.barangayId;

  if (nextRole === "BARANGAY_FACILITATOR" && !submittedBarangayId) {
    throw new AppError(
      400,
      "BARANGAY_ASSIGNMENT_REQUIRED",
      "A barangay facilitator must be assigned to an active barangay.",
    );
  }

  if (nextRole !== "BARANGAY_FACILITATOR" && submittedBarangayId) {
    throw new AppError(
      400,
      "INVALID_BARANGAY_ASSIGNMENT",
      "Only barangay facilitators can have a barangay assignment.",
    );
  }

  const usernameWasSubmitted = Object.hasOwn(input, "username");
  const submittedUsername = usernameWasSubmitted ? input.username : existingUser.username;
  const usernameIsAllowed = nextRole === "SYSTEM_ADMIN" || nextRole === "BARANGAY_FACILITATOR";

  if (usernameIsAllowed && !submittedUsername) {
    throw new AppError(
      400,
      "USERNAME_REQUIRED",
      "A username is required for System Administrators and Barangay Facilitators.",
    );
  }

  if (!usernameIsAllowed && usernameWasSubmitted && submittedUsername) {
    throw new AppError(
      400,
      "USERNAME_NOT_ALLOWED",
      "DSWD Staff sign in with their generated Staff ID and cannot have a username.",
    );
  }

  return {
    ...input,
    ...(Object.hasOwn(input, "barangayId") ? { barangayId: submittedBarangayId } : {}),
    ...(usernameIsAllowed
      ? usernameWasSubmitted ? { username: submittedUsername } : {}
      : existingUser.username || usernameWasSubmitted
        ? { username: null }
        : {}),
  };
}
