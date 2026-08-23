import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { staffUserSelect } from "../auth/auth.service.js";

export { staffUserSelect };

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
) {
  if (username && username.toUpperCase() === employeeId.toUpperCase()) {
    throw new AppError(
      409,
      "STAFF_IDENTIFIER_CONFLICT",
      "Username and employee ID must be different.",
    );
  }

  const conflict = await prisma.user.findFirst({
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
      "That username or employee ID is already used by another staff account.",
    );
  }
}

export function resolveStaffUserUpdate(existingUser, input) {
  const nextRole = input.role ?? existingUser.role;
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
    if (existingUser.role !== "BARANGAY_FACILITATOR" || !input.role) {
      throw new AppError(
        400,
        "INVALID_BARANGAY_ASSIGNMENT",
        "Only barangay facilitators can have a barangay assignment.",
      );
    }
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
      "DSWD Staff must log in with their official employee ID and cannot have a username.",
    );
  }

  return {
    ...input,
    ...(nextRole === "BARANGAY_FACILITATOR"
      ? { barangayId: submittedBarangayId }
      : existingUser.barangayId
        ? { barangayId: null }
        : {}),
    ...(usernameIsAllowed
      ? { username: submittedUsername }
      : existingUser.username || usernameWasSubmitted
        ? { username: null }
        : {}),
  };
}
