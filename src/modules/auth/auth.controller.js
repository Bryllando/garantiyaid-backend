import bcrypt from "bcrypt";
import prisma from "../../lib/prisma.js";
import { authenticateTotpSetup } from "../../middleware/authenticateTotpSetup.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import {
  createStaffSecurityNotification,
  dispatchStaffSecurityNotification,
  emailDeliveryConfiguration,
} from "../staffNotifications/staffSecurityEmail.service.js";
import {
  authenticateStaff as authenticateStaffCredentials,
  generateRecoveryCodes,
  hashRecoveryCode,
  issueAccessToken,
  signTotpReplacementToken,
  staffUserSelect,
  verifyStaffReauthentication,
  verifyTotpReplacementToken,
} from "./auth.service.js";
import {
  createTotpUri,
  decryptTotpSecret,
  encryptTotpSecret,
  findValidTotpCounter,
  generateTotpSecret,
} from "./totp.service.js";
import {
  PASSWORD_RESET_PUBLIC_MESSAGE,
  generatePasswordResetToken,
  hashPasswordResetToken,
  passwordResetLookupWhere,
  passwordResetPath,
  passwordResetTokenIsUsable,
} from "./passwordReset.service.js";

function invalidPasswordResetTokenError() {
  return new AppError(
    400,
    "INVALID_OR_EXPIRED_PASSWORD_RESET_TOKEN",
    "This password-reset link is invalid, expired, or already used. Request a new link.",
  );
}

export const requestPasswordReset = asyncHandler(async (req, res) => {
  const user = await prisma.user.findFirst({
    where: passwordResetLookupWhere(req.validatedBody.account),
    select: { userId: true, employeeId: true, fullName: true, email: true },
  });

  if (user) {
    const now = new Date();
    const generated = generatePasswordResetToken(now);
    const securityNotification = await prisma.$transaction(async (tx) => {
      await tx.staffPasswordResetToken.updateMany({
        where: { userId: user.userId, usedAt: null },
        data: { usedAt: now },
      });
      const resetRecord = await tx.staffPasswordResetToken.create({
        data: {
          userId: user.userId,
          tokenHash: generated.tokenHash,
          expiresAt: generated.expiresAt,
        },
        select: { resetTokenId: true },
      });
      await tx.auditLog.create({
        data: {
          userId: null,
          actorType: "SYSTEM",
          action: "STAFF_PASSWORD_RESET_REQUESTED",
          entityAffected: "USER",
          recordId: user.userId,
          ipAddress: clientIpAddress(req),
          details: { resetTokenId: resetRecord.resetTokenId, expiresAt: generated.expiresAt },
        },
      });
      return createStaffSecurityNotification({
        event: "PASSWORD_RESET_REQUESTED",
        eventKey: resetRecord.resetTokenId,
        user,
      }, tx);
    });
    await dispatchStaffSecurityNotification(securityNotification, {
      deliveryTargetPath: passwordResetPath(generated.token),
    });
  }

  res.set("Cache-Control", "no-store").status(202).json({
    success: true,
    data: { message: PASSWORD_RESET_PUBLIC_MESSAGE },
  });
});

export const completePasswordReset = asyncHandler(async (req, res) => {
  const tokenHash = hashPasswordResetToken(req.validatedBody.token);
  const candidate = await prisma.staffPasswordResetToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: {
          userId: true,
          employeeId: true,
          fullName: true,
          email: true,
          passwordHash: true,
          isActive: true,
          archivedAt: true,
        },
      },
    },
  });
  if (!passwordResetTokenIsUsable(candidate)) throw invalidPasswordResetTokenError();
  if (await bcrypt.compare(req.validatedBody.newPassword, candidate.user.passwordHash)) {
    throw new AppError(400, "PASSWORD_REUSE_NOT_ALLOWED", "Choose a password different from your current password.");
  }

  const passwordHash = await bcrypt.hash(req.validatedBody.newPassword, 12);
  const completedAt = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const consumed = await tx.staffPasswordResetToken.updateMany({
      where: {
        resetTokenId: candidate.resetTokenId,
        tokenHash,
        usedAt: null,
        expiresAt: { gt: completedAt },
      },
      data: { usedAt: completedAt },
    });
    if (consumed.count !== 1) throw invalidPasswordResetTokenError();

    const changed = await tx.user.updateMany({
      where: { userId: candidate.userId, isActive: true, archivedAt: null },
      data: {
        passwordHash,
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lastFailedLoginAt: null,
        lockedUntil: null,
      },
    });
    if (changed.count !== 1) throw invalidPasswordResetTokenError();

    await tx.staffPasswordResetToken.updateMany({
      where: { userId: candidate.userId, usedAt: null },
      data: { usedAt: completedAt },
    });
    const revokedSessions = await tx.staffSession.updateMany({
      where: { userId: candidate.userId, revokedAt: null },
      data: { revokedAt: completedAt },
    });
    await tx.auditLog.create({
      data: {
        userId: null,
        actorType: "SYSTEM",
        action: "STAFF_PASSWORD_RESET_COMPLETED",
        entityAffected: "USER",
        recordId: candidate.userId,
        ipAddress: clientIpAddress(req),
        details: {
          resetTokenId: candidate.resetTokenId,
          revokedSessionCount: revokedSessions.count,
        },
      },
    });
    const securityNotification = await createStaffSecurityNotification({
      event: "PASSWORD_RESET_COMPLETED",
      eventKey: candidate.resetTokenId,
      user: candidate.user,
    }, tx);
    return { revokedSessionCount: revokedSessions.count, securityNotification };
  }, { isolationLevel: "Serializable" });

  await dispatchStaffSecurityNotification(result.securityNotification);
  res.set("Cache-Control", "no-store").status(200).json({
    success: true,
    data: {
      message: "Password reset complete. Sign in again with your new password.",
      revokedSessionCount: result.revokedSessionCount,
    },
  });
});

export const login = asyncHandler(async (req, res) => {
  const ipAddress = clientIpAddress(req);
  const result = await authenticateStaffCredentials(req.validatedBody, {
    ipAddress,
    requestId: req.requestId,
  });

  if (result.requiresPasswordChange) {
    return res.status(200).json({
      success: true,
      data: { requiresPasswordChange: true },
    });
  }

  if (result.requiresTotpEnrollment) {
    return res.status(200).json({
      success: true,
      data: {
        requiresTotpEnrollment: true,
        totpSetupToken: result.totpSetupToken,
      },
    });
  }

  if (result.requiresTotp) {
    return res.status(200).json({
      success: true,
      data: { requiresTotp: true },
    });
  }

  const { accessToken } = await prisma.$transaction(async (tx) => {
    const issuedSession = await issueAccessToken(result.user, { ipAddress, database: tx });
    await tx.auditLog.create({
      data: {
        userId: result.user.userId,
        action: "STAFF_LOGIN",
        entityAffected: "USER",
        recordId: result.user.userId,
        ipAddress,
        details: {
          sessionId: issuedSession.sessionId,
          authenticationMethod: result.authenticationMethod ?? "TOTP",
        },
      },
    });
    if (result.authenticationMethod === "RECOVERY_CODE") {
      await tx.auditLog.create({
        data: {
          userId: result.user.userId,
          action: "STAFF_RECOVERY_CODE_USED",
          entityAffected: "USER",
          recordId: result.user.userId,
          ipAddress,
        },
      });
    }
    return issuedSession;
  });

  return res.status(200).json({
    success: true,
    data: {
      accessToken,
      user: result.user,
    },
  });
});

export const getCurrentStaff = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { user: req.staffUser } });
});

export const getOwnAccount = asyncHandler(async (req, res) => {
  const now = new Date();
  const [recoveryCodesRemaining, activeSessionCount, currentSession] = await Promise.all([
    prisma.staffRecoveryCode.count({
      where: { userId: req.auth.userId, usedAt: null },
    }),
    prisma.staffSession.count({
      where: { userId: req.auth.userId, revokedAt: null, expiresAt: { gt: now } },
    }),
    prisma.staffSession.findUnique({
      where: { sessionId: req.auth.sessionId },
      select: { createdAt: true, expiresAt: true, ipAddress: true },
    }),
  ]);

  res.set("Cache-Control", "no-store").status(200).json({
    success: true,
    data: {
      user: req.staffUser,
      security: {
        recoveryCodesRemaining,
        activeSessionCount,
        currentSession,
        securityEmail: emailDeliveryConfiguration(),
      },
    },
  });
});

export const updateOwnProfile = asyncHandler(async (req, res) => {
  const changedFields = Object.keys(req.validatedBody);
  const user = await prisma.$transaction(async (tx) => {
    const updatedUser = await tx.user.update({
      where: { userId: req.auth.userId },
      data: req.validatedBody,
      select: staffUserSelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "OWN_PROFILE_UPDATED",
        entityAffected: "USER",
        recordId: req.auth.userId,
        ipAddress: clientIpAddress(req),
        details: { changedFields },
      },
    });

    return updatedUser;
  });

  res.status(200).json({ success: true, data: { user } });
});

export const changeOwnPassword = asyncHandler(async (req, res) => {
  const credentials = await verifyStaffReauthentication(
    req.auth.userId,
    req.validatedBody,
  );

  if (await bcrypt.compare(req.validatedBody.newPassword, credentials.passwordHash)) {
    throw new AppError(
      400,
      "PASSWORD_REUSE_NOT_ALLOWED",
      "Choose a new password that is different from your current password.",
    );
  }

  const passwordHash = await bcrypt.hash(req.validatedBody.newPassword, 12);
  const changedAt = new Date();
  const { revokedSessions, securityNotification } = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { userId: req.auth.userId },
      data: { passwordHash, mustChangePassword: false },
    });
    const revoked = await tx.staffSession.updateMany({
      where: {
        userId: req.auth.userId,
        sessionId: { not: req.auth.sessionId },
        revokedAt: null,
      },
      data: { revokedAt: changedAt },
    });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "OWN_PASSWORD_CHANGED",
        entityAffected: "USER",
        recordId: req.auth.userId,
        ipAddress: clientIpAddress(req),
        details: { revokedSessionCount: revoked.count },
      },
    });
    const notification = await createStaffSecurityNotification({
      event: "PASSWORD_CHANGED",
      eventKey: req.requestId,
      user: req.staffUser,
    }, tx);
    return { revokedSessions: revoked, securityNotification: notification };
  });
  const emailDelivery = await dispatchStaffSecurityNotification(securityNotification);

  res.status(200).json({
    success: true,
    data: {
      message: "Password changed successfully.",
      revokedSessionCount: revokedSessions.count,
      emailDelivery,
    },
  });
});

async function replaceRecoveryCodes(req, auditAction) {
  const recoveryCodes = generateRecoveryCodes();
  const recoveryCodeHashes = await Promise.all(recoveryCodes.map(hashRecoveryCode));

  await prisma.$transaction(async (tx) => {
    await tx.staffRecoveryCode.deleteMany({ where: { userId: req.auth.userId } });
    await tx.staffRecoveryCode.createMany({
      data: recoveryCodeHashes.map((codeHash) => ({
        userId: req.auth.userId,
        codeHash,
      })),
    });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: auditAction,
        entityAffected: "USER",
        recordId: req.auth.userId,
        ipAddress: clientIpAddress(req),
        details: { recoveryCodeCount: recoveryCodes.length },
      },
    });
  });

  return recoveryCodes;
}

export const regenerateOwnRecoveryCodes = asyncHandler(async (req, res) => {
  await verifyStaffReauthentication(req.auth.userId, req.validatedBody);
  const recoveryCodes = await replaceRecoveryCodes(req, "OWN_RECOVERY_CODES_REGENERATED");

  res.set("Cache-Control", "no-store").status(200).json({
    success: true,
    data: { recoveryCodes },
  });
});

export const startOwnTotpReplacement = asyncHandler(async (req, res) => {
  const credentials = await verifyStaffReauthentication(
    req.auth.userId,
    req.validatedBody,
  );
  const secret = generateTotpSecret();
  const pendingSecret = encryptTotpSecret(secret);
  const replacementToken = signTotpReplacementToken(req.staffUser, {
    currentSecret: credentials.totpSecret,
    pendingSecret,
    sessionId: req.auth.sessionId,
  });

  await prisma.auditLog.create({
    data: {
      userId: req.auth.userId,
      action: "OWN_TOTP_REPLACEMENT_STARTED",
      entityAffected: "USER",
      recordId: req.auth.userId,
      ipAddress: clientIpAddress(req),
    },
  });

  res.set("Cache-Control", "no-store").status(200).json({
    success: true,
    data: {
      secret,
      otpauthUri: createTotpUri({
        accountName: req.staffUser.username ?? req.staffUser.employeeId,
        secret,
      }),
      replacementToken,
    },
  });
});

export const confirmOwnTotpReplacement = asyncHandler(async (req, res) => {
  const payload = verifyTotpReplacementToken(req.validatedBody.replacementToken);
  if (payload.sub !== req.auth.userId || payload.sessionId !== req.auth.sessionId) {
    throw new AppError(
      401,
      "INVALID_TOTP_REPLACEMENT_TOKEN",
      "The authenticator replacement session is invalid or expired.",
    );
  }

  const matchedCounter = findValidTotpCounter(
    decryptTotpSecret(payload.pendingSecret),
    req.validatedBody.code,
  );
  if (matchedCounter === null) {
    throw new AppError(401, "INVALID_TOTP_CODE", "The TOTP code is invalid or expired.");
  }

  const recoveryCodes = generateRecoveryCodes();
  const recoveryCodeHashes = await Promise.all(recoveryCodes.map(hashRecoveryCode));
  const replacedAt = new Date();
  const { user, revokedSessionCount, securityNotification } = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: {
        userId: req.auth.userId,
        totpEnabled: true,
        totpSecret: payload.currentSecret,
      },
      data: {
        totpSecret: payload.pendingSecret,
        lastTotpCounter: matchedCounter,
      },
    });
    if (updated.count !== 1) {
      throw new AppError(
        409,
        "TOTP_REPLACEMENT_ALREADY_COMPLETED",
        "The authenticator changed after this replacement started. Start again.",
      );
    }

    await tx.staffRecoveryCode.deleteMany({ where: { userId: req.auth.userId } });
    await tx.staffRecoveryCode.createMany({
      data: recoveryCodeHashes.map((codeHash) => ({
        userId: req.auth.userId,
        codeHash,
      })),
    });
    const revoked = await tx.staffSession.updateMany({
      where: {
        userId: req.auth.userId,
        sessionId: { not: req.auth.sessionId },
        revokedAt: null,
      },
      data: { revokedAt: replacedAt },
    });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "OWN_TOTP_REPLACED",
        entityAffected: "USER",
        recordId: req.auth.userId,
        ipAddress: clientIpAddress(req),
        details: {
          recoveryCodeCount: recoveryCodes.length,
          revokedSessionCount: revoked.count,
        },
      },
    });
    const user = await tx.user.findUniqueOrThrow({
      where: { userId: req.auth.userId },
      select: staffUserSelect,
    });
    const notification = await createStaffSecurityNotification({
      event: "AUTHENTICATOR_REPLACED",
      eventKey: req.requestId,
      user,
    }, tx);
    return {
      user,
      revokedSessionCount: revoked.count,
      securityNotification: notification,
    };
  });
  const emailDelivery = await dispatchStaffSecurityNotification(securityNotification);

  res.set("Cache-Control", "no-store").status(200).json({
    success: true,
    data: { user, recoveryCodes, revokedSessionCount, emailDelivery },
  });
});

export const revokeOwnOtherSessions = asyncHandler(async (req, res) => {
  const revokedAt = new Date();
  const revokedSessions = await prisma.$transaction(async (tx) => {
    const revoked = await tx.staffSession.updateMany({
      where: {
        userId: req.auth.userId,
        sessionId: { not: req.auth.sessionId },
        revokedAt: null,
      },
      data: { revokedAt },
    });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "OWN_OTHER_SESSIONS_REVOKED",
        entityAffected: "USER",
        recordId: req.auth.userId,
        ipAddress: clientIpAddress(req),
        details: { revokedSessionCount: revoked.count },
      },
    });
    return revoked;
  });

  res.status(200).json({
    success: true,
    data: {
      message: "Other staff sessions were signed out.",
      revokedSessionCount: revokedSessions.count,
    },
  });
});

export const setupTotp = [
  authenticateTotpSetup,
  asyncHandler(async (req, res) => {
    const secret = generateTotpSecret();

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { userId: req.auth.userId },
        data: {
          totpSecret: encryptTotpSecret(secret),
          totpEnabled: false,
          lastTotpCounter: null,
        },
      });

      await tx.auditLog.create({
        data: {
          userId: req.auth.userId,
          action: "TOTP_SETUP_STARTED",
          entityAffected: "USER",
          recordId: req.auth.userId,
          ipAddress: clientIpAddress(req),
        },
      });
    });

    return res.status(200).json({
      success: true,
      data: {
        secret,
        otpauthUri: createTotpUri({
          accountName: req.staffUser.username ?? req.staffUser.employeeId,
          secret,
        }),
      },
    });
  }),
];

export const confirmTotp = [
  authenticateTotpSetup,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { userId: req.auth.userId },
    });

    if (!user?.totpSecret) {
      throw new AppError(400, "TOTP_SETUP_REQUIRED", "Start TOTP setup before confirming it.");
    }

    const matchedCounter = findValidTotpCounter(
      decryptTotpSecret(user.totpSecret),
      req.validatedBody.code,
    );
    if (matchedCounter === null) {
      throw new AppError(401, "INVALID_TOTP_CODE", "The TOTP code is invalid or expired.");
    }

    const recoveryCodes = generateRecoveryCodes();
    const recoveryCodeHashes = await Promise.all(recoveryCodes.map(hashRecoveryCode));

    const { confirmedUser, accessToken, securityNotification } = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: {
          userId: user.userId,
          totpEnabled: false,
          OR: [
            { lastTotpCounter: null },
            { lastTotpCounter: { lt: matchedCounter } },
          ],
        },
        data: {
          totpEnabled: true,
          lastTotpCounter: matchedCounter,
          failedLoginAttempts: 0,
          lastFailedLoginAt: null,
          lockedUntil: null,
        },
      });

      if (updated.count !== 1) {
        throw new AppError(401, "INVALID_TOTP_CODE", "The TOTP code is invalid or expired.");
      }

      await tx.staffRecoveryCode.deleteMany({ where: { userId: user.userId } });
      await tx.staffRecoveryCode.createMany({
        data: recoveryCodeHashes.map((codeHash) => ({
          userId: user.userId,
          codeHash,
        })),
      });

      await tx.auditLog.create({
        data: {
          userId: user.userId,
          action: "TOTP_ENABLED",
          entityAffected: "USER",
          recordId: user.userId,
          ipAddress: clientIpAddress(req),
          details: { recoveryCodeCount: recoveryCodes.length },
        },
      });

      const confirmedUser = await tx.user.findUniqueOrThrow({
        where: { userId: user.userId },
        select: staffUserSelect,
      });
      const notification = await createStaffSecurityNotification({
        event: "AUTHENTICATOR_ENABLED",
        eventKey: req.requestId,
        user: confirmedUser,
      }, tx);
      const { accessToken } = await issueAccessToken(confirmedUser, {
        ipAddress: clientIpAddress(req),
        database: tx,
      });

      return { confirmedUser, accessToken, securityNotification: notification };
    });
    const emailDelivery = await dispatchStaffSecurityNotification(securityNotification);

    return res.status(200).json({
      success: true,
      data: {
        accessToken,
        user: confirmedUser,
        recoveryCodes,
        emailDelivery,
      },
    });
  }),
];

export const logout = asyncHandler(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    await tx.staffSession.updateMany({
      where: {
        sessionId: req.auth.sessionId,
        userId: req.auth.userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "STAFF_LOGOUT",
        entityAffected: "USER",
        recordId: req.auth.userId,
        ipAddress: clientIpAddress(req),
        details: { sessionId: req.auth.sessionId },
      },
    });
  });

  return res.status(200).json({
    success: true,
    data: { message: "Staff session ended successfully." },
  });
});
