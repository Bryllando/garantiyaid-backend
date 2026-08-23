import bcrypt from "bcrypt";
import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import {
  assertActiveBarangay,
  assertStaffLoginIdentifiersAvailable,
  getStaffUserOrThrow,
  resolveStaffUserUpdate,
  staffUserSelect,
} from "./user.service.js";

export const createStaffUser = asyncHandler(async (req, res) => {
  const { password, ...staffUserInput } = req.validatedBody;

  await assertStaffLoginIdentifiersAvailable(staffUserInput);

  if (staffUserInput.role === "BARANGAY_FACILITATOR") {
    await assertActiveBarangay(staffUserInput.barangayId);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.$transaction(async (tx) => {
    const createdUser = await tx.user.create({
      data: { ...staffUserInput, passwordHash },
      select: staffUserSelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "STAFF_ACCOUNT_CREATED",
        entityAffected: "USER",
        recordId: createdUser.userId,
        ipAddress: clientIpAddress(req),
        details: { role: createdUser.role },
      },
    });

    return createdUser;
  });

  res.status(201).json({ success: true, data: { user } });
});

export const listStaffUsers = asyncHandler(async (req, res) => {
  const { page, pageSize, role, isActive, search } = req.validatedQuery;
  const where = {
    ...(role ? { role } : {}),
    ...(isActive ? { isActive: isActive === "true" } : {}),
    ...(search ? {
      OR: [
        { fullName: { contains: search, mode: "insensitive" } },
        { employeeId: { contains: search, mode: "insensitive" } },
        { username: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ],
    } : {}),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: staffUserSelect,
      orderBy: [{ role: "asc" }, { fullName: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.user.count({ where }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      users,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  });
});

export const getStaffUser = asyncHandler(async (req, res) => {
  const user = await getStaffUserOrThrow(req.validatedParams.userId);
  res.status(200).json({ success: true, data: { user } });
});

export const updateStaffUser = asyncHandler(async (req, res) => {
  const existingUser = await getStaffUserOrThrow(req.validatedParams.userId);

  if (
    existingUser.userId === req.auth.userId &&
    (Object.hasOwn(req.validatedBody, "role") || Object.hasOwn(req.validatedBody, "isActive"))
  ) {
    throw new AppError(403, "SELF_PRIVILEGE_CHANGE_FORBIDDEN", "You cannot change your own role or active status.");
  }

  const updateData = resolveStaffUserUpdate(existingUser, req.validatedBody);
  const nextRole = updateData.role ?? existingUser.role;
  const nextIsActive = updateData.isActive ?? existingUser.isActive;
  const nextUsername = Object.hasOwn(updateData, "username")
    ? updateData.username
    : existingUser.username;

  await assertStaffLoginIdentifiersAvailable(
    { employeeId: existingUser.employeeId, username: nextUsername },
    existingUser.userId,
  );

  if (nextRole === "BARANGAY_FACILITATOR") {
    await assertActiveBarangay(updateData.barangayId);
  }

  const removesActiveAdministrator =
    existingUser.role === "SYSTEM_ADMIN" &&
    existingUser.isActive &&
    (nextRole !== "SYSTEM_ADMIN" || !nextIsActive);

  if (removesActiveAdministrator) {
    const activeAdminCount = await prisma.user.count({
      where: { role: "SYSTEM_ADMIN", isActive: true },
    });

    if (activeAdminCount <= 1) {
      throw new AppError(
        400,
        "LAST_SYSTEM_ADMIN_PROTECTED",
        "At least one active System Administrator must remain in the system.",
      );
    }
  }

  const changedFields = Object.keys(updateData);
  const user = await prisma.$transaction(async (tx) => {
    const updatedUser = await tx.user.update({
      where: { userId: existingUser.userId },
      data: updateData,
      select: staffUserSelect,
    });

    const action =
      existingUser.isActive && !updatedUser.isActive
        ? "STAFF_ACCOUNT_DEACTIVATED"
        : !existingUser.isActive && updatedUser.isActive
          ? "STAFF_ACCOUNT_REACTIVATED"
          : "STAFF_ACCOUNT_UPDATED";

    if (changedFields.some((field) => field === "role" || field === "isActive")) {
      await tx.staffSession.updateMany({
        where: { userId: updatedUser.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action,
        entityAffected: "USER",
        recordId: updatedUser.userId,
        ipAddress: clientIpAddress(req),
        details: { changedFields },
      },
    });

    return updatedUser;
  });

  res.status(200).json({ success: true, data: { user } });
});
