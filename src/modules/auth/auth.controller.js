import prisma from "../../lib/prisma.js";
import { authenticateTotpSetup } from "../../middleware/authenticateTotpSetup.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import {
  authenticateStaff as authenticateStaffCredentials,
  generateRecoveryCodes,
  hashRecoveryCode,
  issueAccessToken,
  staffUserSelect,
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

    const { confirmedUser, accessToken } = await prisma.$transaction(async (tx) => {
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
      const { accessToken } = await issueAccessToken(confirmedUser, {
        ipAddress: clientIpAddress(req),
        database: tx,
      });

      return { confirmedUser, accessToken };
    });

    return res.status(200).json({
      success: true,
      data: {
        accessToken,
        user: confirmedUser,
        recoveryCodes,
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
