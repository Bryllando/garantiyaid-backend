import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { STAFF_ROLES, USERNAME_LOGIN_ROLES } from "./auth.constants.js";
import { decryptTotpSecret, findValidTotpCounter } from "./totp.service.js";

const JWT_ALGORITHM = "HS256";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DUMMY_PASSWORD_HASH = "$2b$12$ZSGoWkbD9XCXsf.MA/3FeeB.AaMH.ebbF1gB1AnqiJx8NReGnmCJe";
const RECOVERY_CODE_COUNT = 8;

export const staffUserSelect = {
  userId: true,
  employeeId: true,
  username: true,
  fullName: true,
  email: true,
  role: true,
  contactNumber: true,
  mustChangePassword: true,
  totpEnabled: true,
  barangayId: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  barangay: {
    select: {
      barangayId: true,
      barangayCode: true,
      barangayName: true,
      city: true,
    },
  },
};

export function normalizeRecoveryCode(value) {
  return typeof value === "string" ? value.replace(/[^a-f0-9]/gi, "").toUpperCase() : "";
}

export function hashRecoveryCode(value) {
  return bcrypt.hash(normalizeRecoveryCode(value), 12);
}

export async function verifyRecoveryCode(value, hash) {
  const normalized = normalizeRecoveryCode(value);
  if (hash.startsWith("$2")) return bcrypt.compare(normalized, hash);

  // ponytail: accept pre-migration SHA-256 codes until existing recovery sets rotate.
  const candidate = Buffer.from(createHash("sha256").update(normalized).digest("hex"));
  const stored = Buffer.from(hash);
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export function generateRecoveryCodes() {
  const codes = new Set();
  while (codes.size < RECOVERY_CODE_COUNT) {
    codes.add(randomBytes(8).toString("hex").toUpperCase().match(/.{4}/g).join("-"));
  }
  return [...codes];
}

function requireJwtSecret() {
  if (!env.jwtAccessSecret) {
    throw new AppError(
      503,
      "AUTH_CONFIGURATION_ERROR",
      "Authentication is not configured on this server.",
    );
  }

  return env.jwtAccessSecret;
}

function jwtOptions(options = {}) {
  return {
    algorithm: JWT_ALGORITHM,
    issuer: env.jwtIssuer,
    audience: env.jwtAudience,
    ...options,
  };
}

export function signAccessToken(user, { jwtId = randomUUID() } = {}) {
  return jwt.sign(
    {
      sub: user.userId,
      role: user.role,
      type: "staff",
    },
    requireJwtSecret(),
    jwtOptions({ expiresIn: env.jwtAccessExpiresIn, jwtid: jwtId }),
  );
}

export function signTotpSetupToken(user) {
  return jwt.sign(
    {
      sub: user.userId,
      type: "staff_totp_setup",
    },
    requireJwtSecret(),
    jwtOptions({ expiresIn: "10m", jwtid: randomUUID() }),
  );
}

function verifyStaffToken(token, expectedType, errorCode, message) {
  try {
    const payload = jwt.verify(token, requireJwtSecret(), {
      algorithms: [JWT_ALGORITHM],
      issuer: env.jwtIssuer,
      audience: env.jwtAudience,
    });

    if (
      typeof payload !== "object"
      || payload.type !== expectedType
      || typeof payload.sub !== "string"
      || typeof payload.jti !== "string"
      || !UUID_PATTERN.test(payload.sub)
      || !UUID_PATTERN.test(payload.jti)
    ) {
      throw new AppError(401, errorCode, message);
    }

    return payload;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(401, errorCode, message);
  }
}

export function verifyAccessToken(token) {
  return verifyStaffToken(
    token,
    "staff",
    "INVALID_TOKEN",
    "The access token is invalid or expired.",
  );
}

export function verifyTotpSetupToken(token) {
  return verifyStaffToken(
    token,
    "staff_totp_setup",
    "INVALID_SETUP_TOKEN",
    "The TOTP setup token is invalid or expired.",
  );
}

export async function issueAccessToken(user, { ipAddress = null, database = prisma } = {}) {
  const sessionId = randomUUID();
  const accessToken = signAccessToken(user, { jwtId: sessionId });
  const payload = jwt.decode(accessToken);

  if (typeof payload !== "object" || typeof payload.exp !== "number") {
    throw new AppError(500, "AUTH_TOKEN_ERROR", "Unable to issue a staff access token.");
  }

  const expiresAt = new Date(payload.exp * 1000);
  await database.staffSession.create({
    data: {
      sessionId,
      userId: user.userId,
      expiresAt,
      ipAddress,
    },
  });

  return { accessToken, sessionId, expiresAt };
}

export function resolveStaffLoginLookup(identifier) {
  const normalizedIdentifier = identifier.trim();
  return {
    OR: [
      { employeeId: normalizedIdentifier.toUpperCase() },
      { username: normalizedIdentifier.toLowerCase() },
    ],
  };
}

export function staffLoginMethodAllowed(user, identifier) {
  const normalizedIdentifier = identifier.trim();

  return user?.employeeId === normalizedIdentifier.toUpperCase()
    || (
      USERNAME_LOGIN_ROLES.includes(user?.role)
      && user.username === normalizedIdentifier.toLowerCase()
    );
}

export function accountIsLocked(user, now = new Date()) {
  return Boolean(user.lockedUntil && user.lockedUntil > now);
}

export function nextLoginFailureState(user, now = new Date()) {
  const failureWindowStart = new Date(
    now.getTime() - env.authFailureWindowMinutes * 60_000,
  );
  const lockExpired = Boolean(user.lockedUntil && user.lockedUntil <= now);
  const withinFailureWindow = Boolean(
    !lockExpired
    && user.lastFailedLoginAt
    && user.lastFailedLoginAt >= failureWindowStart,
  );
  const failedLoginAttempts = withinFailureWindow
    ? user.failedLoginAttempts + 1
    : 1;
  const isNowLocked = failedLoginAttempts >= env.authMaxFailedAttempts;

  return {
    failedLoginAttempts,
    lastFailedLoginAt: now,
    lockedUntil: isNowLocked
      ? new Date(now.getTime() + env.authLockoutMinutes * 60_000)
      : null,
    isNowLocked,
  };
}

function logAuthenticationSecurityEvent(event, context, userId, reason) {
  console.warn({
    securityEvent: event,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userId,
    reason,
    occurredAt: new Date().toISOString(),
  });
}

async function recordFailedLogin(user, context, reason) {
  const state = nextLoginFailureState(user);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { userId: user.userId },
      data: {
        failedLoginAttempts: state.failedLoginAttempts,
        lastFailedLoginAt: state.lastFailedLoginAt,
        lockedUntil: state.lockedUntil,
      },
    });

    if (state.isNowLocked) {
      await tx.auditLog.create({
        data: {
          userId: user.userId,
          action: "STAFF_ACCOUNT_TEMPORARILY_LOCKED",
          entityAffected: "USER",
          recordId: user.userId,
          ipAddress: context.ipAddress,
          details: { reason, failedLoginAttempts: state.failedLoginAttempts },
        },
      });
    }
  });

  logAuthenticationSecurityEvent(
    state.isNowLocked ? "STAFF_ACCOUNT_TEMPORARILY_LOCKED" : "STAFF_LOGIN_FAILED",
    context,
    user.userId,
    reason,
  );

  return state;
}

function accountLockedError(lockedUntil) {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((lockedUntil.getTime() - Date.now()) / 1000),
  );

  return new AppError(
    429,
    "ACCOUNT_TEMPORARILY_LOCKED",
    "This account is temporarily locked. Wait before trying again.",
    { retryAfterSeconds },
  );
}

function invalidCredentialsError() {
  return new AppError(
    401,
    "INVALID_CREDENTIALS",
    "Invalid username/staff ID or password.",
  );
}

export async function authenticateStaff(
  { identifier, password, newPassword, totpCode, recoveryCode },
  context = {},
) {
  const matches = await prisma.user.findMany({
    where: resolveStaffLoginLookup(identifier),
    take: 2,
  });
  const user = matches.length === 1 ? matches[0] : null;
  const eligibleUser = staffLoginMethodAllowed(user, identifier) ? user : null;
  const passwordMatches = await bcrypt.compare(
    password,
    eligibleUser?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );

  if (eligibleUser && accountIsLocked(eligibleUser)) {
    if (passwordMatches) {
      logAuthenticationSecurityEvent(
        "STAFF_LOGIN_BLOCKED",
        context,
        eligibleUser.userId,
        "ACCOUNT_LOCKED",
      );
      throw accountLockedError(eligibleUser.lockedUntil);
    }

    logAuthenticationSecurityEvent(
      "STAFF_LOGIN_FAILED",
      context,
      eligibleUser.userId,
      "INVALID_CREDENTIALS",
    );
    throw invalidCredentialsError();
  }

  if (!eligibleUser || !passwordMatches) {
    if (eligibleUser) {
      await recordFailedLogin(eligibleUser, context, "INVALID_CREDENTIALS");
    } else {
      logAuthenticationSecurityEvent(
        "STAFF_LOGIN_FAILED",
        context,
        null,
        "INVALID_CREDENTIALS",
      );
    }
    throw invalidCredentialsError();
  }

  if (!eligibleUser.isActive || !STAFF_ROLES.includes(eligibleUser.role)) {
    throw new AppError(403, "ACCOUNT_INACTIVE", "This staff account is not active.");
  }

  if (eligibleUser.mustChangePassword) {
    if (!newPassword) {
      return {
        user: eligibleUser,
        requiresPasswordChange: true,
        requiresTotp: false,
        requiresTotpEnrollment: false,
      };
    }

    if (await bcrypt.compare(newPassword, eligibleUser.passwordHash)) {
      throw new AppError(
        400,
        "PASSWORD_REUSE_NOT_ALLOWED",
        "Choose a new password that is different from the temporary password.",
      );
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const safeUser = await prisma.$transaction(async (tx) => {
      const changed = await tx.user.updateMany({
        where: { userId: eligibleUser.userId, mustChangePassword: true },
        data: {
          passwordHash,
          mustChangePassword: false,
          failedLoginAttempts: 0,
          lastFailedLoginAt: null,
          lockedUntil: null,
        },
      });

      if (changed.count !== 1) {
        throw new AppError(
          409,
          "INITIAL_PASSWORD_ALREADY_CHANGED",
          "The temporary password was already changed. Sign in using the new password.",
        );
      }

      await tx.auditLog.create({
        data: {
          userId: eligibleUser.userId,
          action: "INITIAL_STAFF_PASSWORD_CHANGED",
          entityAffected: "USER",
          recordId: eligibleUser.userId,
          ipAddress: context.ipAddress,
        },
      });

      return tx.user.findUniqueOrThrow({
        where: { userId: eligibleUser.userId },
        select: staffUserSelect,
      });
    });

    if (!safeUser.totpEnabled) {
      return {
        user: safeUser,
        requiresPasswordChange: false,
        requiresTotp: false,
        requiresTotpEnrollment: true,
        totpSetupToken: signTotpSetupToken(safeUser),
      };
    }

    return {
      user: safeUser,
      requiresPasswordChange: false,
      requiresTotp: true,
      requiresTotpEnrollment: false,
    };
  }

  if (newPassword) {
    throw new AppError(
      400,
      "PASSWORD_CHANGE_NOT_REQUIRED",
      "This account no longer requires an initial password change.",
    );
  }

  if (!eligibleUser.totpEnabled) {
    return {
      user: eligibleUser,
      requiresTotp: false,
      requiresTotpEnrollment: true,
      totpSetupToken: signTotpSetupToken(eligibleUser),
    };
  }

  if (!totpCode && !recoveryCode) {
    return { user: eligibleUser, requiresTotp: true, requiresTotpEnrollment: false };
  }

  if (recoveryCode) {
    const storedCodes = await prisma.staffRecoveryCode.findMany({
      where: { userId: eligibleUser.userId, usedAt: null },
      select: { recoveryCodeId: true, codeHash: true },
    });
    const comparisons = await Promise.all(
      storedCodes.map(({ codeHash }) => verifyRecoveryCode(recoveryCode, codeHash)),
    );
    const storedCode = storedCodes[comparisons.findIndex(Boolean)];
    const consumed = storedCode
      ? await prisma.$transaction(async (tx) => {
          const result = await tx.staffRecoveryCode.updateMany({
            where: { recoveryCodeId: storedCode.recoveryCodeId, usedAt: null },
            data: { usedAt: new Date() },
          });
          if (result.count !== 1) return false;
          await tx.user.update({
            where: { userId: eligibleUser.userId },
            data: {
              failedLoginAttempts: 0,
              lastFailedLoginAt: null,
              lockedUntil: null,
            },
          });
          return true;
        })
      : false;

    if (!consumed) {
      const failure = await recordFailedLogin(eligibleUser, context, "INVALID_RECOVERY_CODE");
      if (failure.isNowLocked) throw accountLockedError(failure.lockedUntil);
      throw new AppError(401, "INVALID_RECOVERY_CODE", "The recovery code is invalid or has already been used.");
    }

    const safeUser = await prisma.user.findUnique({
      where: { userId: eligibleUser.userId },
      select: staffUserSelect,
    });

    return {
      user: safeUser,
      requiresTotp: false,
      requiresTotpEnrollment: false,
      authenticationMethod: "RECOVERY_CODE",
    };
  }

  const matchedCounter = eligibleUser.totpSecret
    ? findValidTotpCounter(decryptTotpSecret(eligibleUser.totpSecret), totpCode)
    : null;

  if (matchedCounter === null) {
    const failure = await recordFailedLogin(eligibleUser, context, "INVALID_TOTP_CODE");
    if (failure.isNowLocked) {
      throw accountLockedError(failure.lockedUntil);
    }
    throw new AppError(401, "INVALID_TOTP_CODE", "The TOTP code is invalid or expired.");
  }

  const consumedCode = await prisma.user.updateMany({
    where: {
      userId: eligibleUser.userId,
      OR: [
        { lastTotpCounter: null },
        { lastTotpCounter: { lt: matchedCounter } },
      ],
    },
    data: {
      lastTotpCounter: matchedCounter,
      failedLoginAttempts: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
    },
  });

  if (consumedCode.count !== 1) {
    const failure = await recordFailedLogin(eligibleUser, context, "TOTP_REPLAY_BLOCKED");
    logAuthenticationSecurityEvent(
      "TOTP_REPLAY_BLOCKED",
      context,
      eligibleUser.userId,
      "TOTP_REPLAY_BLOCKED",
    );
    if (failure.isNowLocked) {
      throw accountLockedError(failure.lockedUntil);
    }
    throw new AppError(401, "INVALID_TOTP_CODE", "The TOTP code is invalid or expired.");
  }

  const safeUser = await prisma.user.findUnique({
    where: { userId: eligibleUser.userId },
    select: staffUserSelect,
  });

  return {
    user: safeUser,
    requiresTotp: false,
    requiresTotpEnrollment: false,
    authenticationMethod: "TOTP",
  };
}
