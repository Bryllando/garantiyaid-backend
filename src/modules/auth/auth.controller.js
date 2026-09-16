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
