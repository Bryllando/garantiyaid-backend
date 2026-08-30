import bcrypt from "bcrypt";
import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import {
  assertActiveBarangay,
  assertStaffLoginIdentifiersAvailable,
  generateStaffId,
  generateTemporaryPassword,
  getStaffUserOrThrow,
  resolveStaffUserUpdate,
  staffUserSelect,
} from "./user.service.js";

export const createStaffUser = asyncHandler(async (req, res) => {
  const staffUserInput = req.validatedBody;

  if (staffUserInput.role === "BARANGAY_FACILITATOR") {
    await assertActiveBarangay(staffUserInput.barangayId);
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await bcrypt.hash(temporaryPassword, 12);
  const user = await prisma.$transaction(async (tx) => {
    const employeeId = await generateStaffId(staffUserInput.role, tx);
    await assertStaffLoginIdentifiersAvailable(
      { employeeId, username: staffUserInput.username },
      undefined,
      tx,
    );
    const createdUser = await tx.user.create({
      data: { ...staffUserInput, employeeId, passwordHash },
      select: staffUserSelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "STAFF_ACCOUNT_CREATED",
        entityAffected: "USER",
        recordId: createdUser.userId,
        ipAddress: clientIpAddress(req),
        details: { role: createdUser.role, staffId: createdUser.employeeId },
      },
    });

    return createdUser;
  });

  res.set("Cache-Control", "no-store").status(201).json({
    success: true,
    data: { user, temporaryPassword },
  });
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

export const resetStaffTotp = asyncHandler(async (req, res) => {
  const targetUser = await getStaffUserOrThrow(req.validatedParams.userId);

  if (targetUser.userId === req.auth.userId) {
    throw new AppError(
      403,
      "SELF_TOTP_RESET_FORBIDDEN",
      "Another System Administrator must reset your authenticator.",
    );
  }

  if (!targetUser.isActive) {
    throw new AppError(400, "STAFF_ACCOUNT_INACTIVE", "Reactivate this staff account before resetting TOTP.");
  }

  const resetAt = new Date();
  const { user, revokedSessionCount } = await prisma.$transaction(async (tx) => {
    const revokedSessions = await tx.staffSession.updateMany({
      where: { userId: targetUser.userId, revokedAt: null },
      data: { revokedAt: resetAt },
    });

    await tx.staffRecoveryCode.deleteMany({ where: { userId: targetUser.userId } });

    const resetUser = await tx.user.update({
      where: { userId: targetUser.userId },
      data: {
        totpSecret: null,
        totpEnabled: false,
        lastTotpCounter: null,
        otpCodeHash: null,
        otpExpiresAt: null,
        failedLoginAttempts: 0,
        lastFailedLoginAt: null,
        lockedUntil: null,
      },
      select: staffUserSelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "STAFF_TOTP_RESET",
        entityAffected: "USER",
        recordId: targetUser.userId,
        ipAddress: clientIpAddress(req),
        details: {
          targetEmployeeId: targetUser.employeeId,
          identityVerification: req.validatedBody,
          revokedSessionCount: revokedSessions.count,
        },
      },
    });

    return { user: resetUser, revokedSessionCount: revokedSessions.count };
  });

  res.status(200).json({
    success: true,
    data: {
      user,
      revokedSessionCount,
      message: "Authenticator reset. The staff member must sign in and enroll a new authenticator.",
    },
  });
});

export const updateStaffUser = asyncHandler(async (req, res) => {
  const existingUser = await getStaffUserOrThrow(req.validatedParams.userId);

  if (
    existingUser.userId === req.auth.userId &&
    Object.hasOwn(req.validatedBody, "isActive")
  ) {
    throw new AppError(403, "SELF_PRIVILEGE_CHANGE_FORBIDDEN", "You cannot change your own active status.");
  }

  const updateData = resolveStaffUserUpdate(existingUser, req.validatedBody);
  const nextIsActive = updateData.isActive ?? existingUser.isActive;
  const nextUsername = Object.hasOwn(updateData, "username")
    ? updateData.username
    : existingUser.username;
  const nextBarangayId = Object.hasOwn(updateData, "barangayId")
    ? updateData.barangayId
    : existingUser.barangayId;

  await assertStaffLoginIdentifiersAvailable(
    { employeeId: existingUser.employeeId, username: nextUsername },
    existingUser.userId,
  );

  if (existingUser.role === "BARANGAY_FACILITATOR") {
    await assertActiveBarangay(nextBarangayId);
  }

  const removesActiveAdministrator =
    existingUser.role === "SYSTEM_ADMIN" &&
    existingUser.isActive &&
    !nextIsActive;

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

    if (changedFields.includes("isActive")) {
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
