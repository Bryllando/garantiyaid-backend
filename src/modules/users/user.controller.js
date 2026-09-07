import bcrypt from "bcrypt";
import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import {
  assertStaffAccountCanBeRemoved,
  assertActiveBarangay,
  assertStaffLoginIdentifiersAvailable,
  generateStaffId,
  generateTemporaryPassword,
  getStaffRemovalMode,
  getStaffUserOrThrow,
  operationalStaffActivityCountSelect,
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
  const { page, pageSize, role, isActive, archived, search } = req.validatedQuery;
  const where = {
    archivedAt: archived === "true" ? { not: null } : null,
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
      select: {
        ...staffUserSelect,
        _count: { select: operationalStaffActivityCountSelect },
      },
      orderBy: [{ role: "asc" }, { fullName: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.user.count({ where }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      users: users.map(({ _count, ...user }) => ({
        ...user,
        removalMode: getStaffRemovalMode(_count),
      })),
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

export const restoreStaffUser = asyncHandler(async (req, res) => {
  const targetUser = await prisma.user.findUnique({
    where: { userId: req.validatedParams.userId, archivedAt: { not: null } },
    select: staffUserSelect,
  });

  if (!targetUser) {
    throw new AppError(404, "ARCHIVED_STAFF_USER_NOT_FOUND", "Archived staff user was not found.");
  }

  const user = await prisma.$transaction(async (tx) => {
    const restoredUser = await tx.user.update({
      where: { userId: targetUser.userId },
      data: { archivedAt: null, isActive: false },
      select: staffUserSelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "STAFF_ACCOUNT_RESTORED",
        entityAffected: "USER",
        recordId: restoredUser.userId,
        ipAddress: clientIpAddress(req),
        details: { targetEmployeeId: restoredUser.employeeId, restoredAs: "INACTIVE" },
      },
    });

    return restoredUser;
  });

  res.status(200).json({ success: true, data: { user } });
});

export const deleteStaffUser = asyncHandler(async (req, res) => {
  const targetUser = await getStaffUserOrThrow(req.validatedParams.userId);
  const activity = await prisma.user.findUnique({
    where: { userId: targetUser.userId },
    select: { _count: { select: operationalStaffActivityCountSelect } },
  });
  const removalMode = getStaffRemovalMode(activity._count);

  assertStaffAccountCanBeRemoved({
    actorUserId: req.auth.userId,
    confirmation: req.validatedBody.confirmation,
    removalMode,
    targetUser,
  });

  let removedUser;
  try {
    removedUser = await prisma.$transaction(async (tx) => {
      if (removalMode === "ARCHIVE") {
        const archived = await tx.user.update({
          where: { userId: targetUser.userId },
          data: { archivedAt: new Date(), isActive: false },
          select: { userId: true, employeeId: true, fullName: true },
        });
        await tx.staffSession.updateMany({
          where: { userId: targetUser.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            userId: req.auth.userId,
            action: "STAFF_ACCOUNT_ARCHIVED",
            entityAffected: "USER",
            recordId: archived.userId,
            ipAddress: clientIpAddress(req),
            details: { targetEmployeeId: archived.employeeId, targetRole: targetUser.role },
          },
        });
        return archived;
      }

      const actorLogs = await tx.auditLog.findMany({
        where: { userId: targetUser.userId },
        select: { auditId: true, details: true },
      });
      for (const log of actorLogs) {
        const details = log.details && typeof log.details === "object" && !Array.isArray(log.details)
          ? log.details
          : {};
        await tx.auditLog.update({
          where: { auditId: log.auditId },
          data: {
            userId: null,
            actorType: "DELETED_STAFF",
            details: {
              ...details,
              deletedStaffActor: {
                userId: targetUser.userId,
                employeeId: targetUser.employeeId,
                role: targetUser.role,
              },
            },
          },
        });
      }

      const deleted = await tx.user.delete({
        where: { userId: targetUser.userId },
        select: { userId: true, employeeId: true, fullName: true },
      });

      await tx.auditLog.create({
        data: {
          userId: req.auth.userId,
          action: "STAFF_ACCOUNT_DELETED",
          entityAffected: "USER",
          recordId: deleted.userId,
          ipAddress: clientIpAddress(req),
          details: { targetEmployeeId: deleted.employeeId, targetRole: targetUser.role },
        },
      });

      return deleted;
    });
  } catch (error) {
    if (error?.code === "P2003") {
      throw new AppError(
        409,
        "STAFF_ACCOUNT_HAS_OFFICIAL_ACTIVITY",
        "This account is linked to official records and cannot be deleted. Keep it deactivated to preserve the audit trail.",
      );
    }
    throw error;
  }

  res.status(200).json({
    success: true,
    data: {
      user: removedUser,
      removalMode,
      message: removalMode === "ARCHIVE"
        ? "The staff account was archived and its official history was preserved."
        : "The unused staff account was permanently deleted and its audit entries were retained.",
    },
  });
});
