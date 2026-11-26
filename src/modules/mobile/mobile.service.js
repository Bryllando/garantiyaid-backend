import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { mobileSmsConfigured, sendMobileOtpSms } from "./mobileSms.service.js";

const OTP_LIFETIME_MS = 5 * 60_000;
const RESEND_WAIT_MS = 60_000;
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60_000;

function requireMobileAuth() {
  if (!env.mobileAuthSecret || !["DEVELOPMENT", "SMS"].includes(env.mobileAuthMode)
    || (env.mobileAuthMode === "DEVELOPMENT" && env.nodeEnv === "production")
    || (env.mobileAuthMode === "SMS" && !mobileSmsConfigured())) {
    throw new AppError(503, "MOBILE_AUTH_UNAVAILABLE", "Beneficiary authentication is not configured. Contact the system administrator.");
  }
}

export function hashMobileSecret(value) {
  requireMobileAuth();
  return createHmac("sha256", env.mobileAuthSecret).update(value).digest("hex");
}

export function mobileProfile(account) {
  const person = account.link?.beneficiary ?? account.registration;
  return {
    id: person.beneficiaryId ?? account.accountId,
    firstName: person.firstName, middleName: person.middleName, lastName: person.lastName,
    birthDate: new Date(person.birthDate).toISOString().slice(0, 10),
    sex: ({ FEMALE: "female", MALE: "male", UNKNOWN: "prefer_not_to_say", OTHER: "prefer_not_to_say" })[person.sex] ?? "prefer_not_to_say",
    address: person.address, barangayId: person.barangayId,
    contactNumber: account.contactNumber,
    linkStatus: account.link?.status ?? "PENDING", linkNote: account.link?.reviewNote ?? null,
    identityStatus: account.link?.identityStatus ?? "REQUIRED", identityNote: account.link?.identityNote ?? null,
    isVerified: account.link?.identityStatus === "APPROVED", phoneVerified: Boolean(account.verifiedAt),
    status: (person.status ?? "PENDING").toLowerCase(),
  };
}

function assertActive(account) {
  if (account.link?.beneficiary && account.link.beneficiary.status !== "ACTIVE") throw new AppError(403, "ACCOUNT_INACTIVE", "This beneficiary account is inactive. Contact your barangay facilitator.");
}

async function activeBarangay(database, barangayId) {
  if (!await database.barangay.findFirst({ where: { barangayId, isActive: true }, select: { barangayId: true } })) {
    throw new AppError(422, "INVALID_BARANGAY", "Select an active barangay.", { fields: [{ field: "barangayId", message: "Select an active barangay." }] });
  }
}

async function audit(database, account, action) {
  await database.auditLog.create({ data: {
    actorType: "BENEFICIARY", action, entityAffected: "MOBILE_LOGIN", recordId: account.accountId,
    details: { source: "MOBILE_APP" },
  } });
}

// Serialize OTP issue/verification for one account, including across API instances.
async function lockedAccount(database, accountId) {
  await database.$queryRaw`SELECT account_id FROM beneficiary_mobile_accounts WHERE account_id = ${accountId}::uuid FOR UPDATE`;
  const account = await database.beneficiaryMobileAccount.findUniqueOrThrow({ where: { accountId }, include: { link: { include: { beneficiary: true } } } });
  return withBeneficiary(account);
}

function withBeneficiary(account) {
  return { ...account, beneficiaryId: account.link?.beneficiary?.beneficiaryId ?? null };
}

async function createChallenge(database, accountId, purpose) {
  const now = new Date();
  const recent = await database.beneficiaryMobileOtp.findFirst({
    where: { accountId, createdAt: { gt: new Date(now.getTime() - RESEND_WAIT_MS) } },
  });
  if (recent) throw new AppError(429, "OTP_TOO_SOON", "Wait one minute before requesting another code.");
  await database.beneficiaryMobileOtp.updateMany({ where: { accountId, consumedAt: null }, data: { consumedAt: now } });
  const challengeId = randomUUID();
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await database.beneficiaryMobileOtp.create({ data: {
    challengeId, accountId, purpose, codeHash: hashMobileSecret(`otp:${challengeId}:${code}`),
    deliveryMode: env.mobileAuthMode, deliveryAcceptedAt: env.mobileAuthMode === "DEVELOPMENT" ? now : null,
    expiresAt: new Date(now.getTime() + OTP_LIFETIME_MS),
  } });
  return { challengeId, code };
}

async function deliverChallenge(contactNumber, challenge) {
  const expiresInSeconds = OTP_LIFETIME_MS / 1000;
  if (env.mobileAuthMode === "DEVELOPMENT") return { expiresInSeconds, developmentOtp: challenge.code };
  try {
    // Release the account/database lock before contacting the external gateway.
    await sendMobileOtpSms(contactNumber, challenge.code);
    const accepted = await prisma.beneficiaryMobileOtp.updateMany({
      where: { challengeId: challenge.challengeId, deliveryMode: "SMS", consumedAt: null, expiresAt: { gt: new Date() } },
      data: { deliveryAcceptedAt: new Date() },
    });
    if (accepted.count !== 1) throw new Error("OTP delivery changed concurrently");
    return { expiresInSeconds };
  } catch {
    await prisma.beneficiaryMobileOtp.updateMany({ where: { challengeId: challenge.challengeId, consumedAt: null }, data: { consumedAt: new Date() } });
    throw new AppError(503, "OTP_DELIVERY_FAILED", "The verification text could not be sent. Wait one minute, then request a new code.");
  }
}

export async function registerMobile(input) {
  requireMobileAuth();
  try {
    const registered = await prisma.$transaction(async (tx) => {
      if (await tx.beneficiaryMobileAccount.findUnique({ where: { contactNumber: input.contactNumber } })) {
        throw new AppError(409, "PHONE_ALREADY_REGISTERED", "This mobile number already has an account.");
      }
      await activeBarangay(tx, input.barangayId);
      const account = await tx.beneficiaryMobileAccount.create({ data: {
        contactNumber: input.contactNumber, registration: { ...input, birthDate: input.birthDate.toISOString() },
      } });
      const otp = await createChallenge(tx, account.accountId, "register");
      await audit(tx, account, "MOBILE_ACCOUNT_REGISTERED");
      return { beneficiary: mobileProfile(account), otp };
    });
    return { beneficiary: registered.beneficiary, verificationRequired: true,
      ...await deliverChallenge(input.contactNumber, registered.otp) };
  } catch (error) {
    if (error.code === "P2002") throw new AppError(409, "PHONE_ALREADY_REGISTERED", "This mobile number already has an account.");
    throw error;
  }
}

async function findAccount(contactNumber) {
  requireMobileAuth();
  const account = await prisma.beneficiaryMobileAccount.findUnique({ where: { contactNumber }, select: { accountId: true } });
  if (!account) throw new AppError(404, "ACCOUNT_NOT_FOUND", "No mobile account uses this number. Register or contact your barangay facilitator.");
  return account;
}

function assertPurpose(account, purpose) {
  assertActive(account);
  if (purpose === "login" && !account.verifiedAt) throw new AppError(403, "ACCOUNT_NOT_VERIFIED", "Verify your phone before signing in.");
  if (purpose === "register" && account.verifiedAt) throw new AppError(409, "ACCOUNT_ALREADY_VERIFIED", "This account is already verified. Sign in instead.");
}

export async function requestMobileOtp({ contactNumber, purpose }) {
  const { accountId } = await findAccount(contactNumber);
  const challenge = await prisma.$transaction(async (tx) => {
    const account = await lockedAccount(tx, accountId);
    assertPurpose(account, purpose);
    return createChallenge(tx, accountId, purpose);
  });
  return deliverChallenge(contactNumber, challenge);
}

export async function verifyMobileOtp({ contactNumber, purpose, code }) {
  const { accountId } = await findAccount(contactNumber);
  const result = await prisma.$transaction(async (tx) => {
    const account = await lockedAccount(tx, accountId);
    assertPurpose(account, purpose);
    const challenge = await tx.beneficiaryMobileOtp.findFirst({ where: { accountId, purpose, consumedAt: null }, orderBy: { createdAt: "desc" } });
    if (!challenge || challenge.expiresAt <= new Date() || challenge.deliveryMode !== env.mobileAuthMode) throw new AppError(400, "OTP_EXPIRED", "This code has expired. Request a new one.");
    if (!challenge.deliveryAcceptedAt) throw new AppError(409, "OTP_NOT_READY", "Your code is still being prepared. Wait a moment and try again.");
    if (challenge.attemptsRemaining <= 0) throw new AppError(429, "OTP_ATTEMPTS_EXCEEDED", "Request a new code and try again.");
    const candidate = Buffer.from(hashMobileSecret(`otp:${challenge.challengeId}:${code}`), "hex");
    const stored = Buffer.from(challenge.codeHash, "hex");
    if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) {
      await tx.beneficiaryMobileOtp.update({ where: { challengeId: challenge.challengeId }, data: { attemptsRemaining: { decrement: 1 } } });
      // Return then throw after commit so the failed attempt is not rolled back.
      return { error: true };
    }
    const now = new Date();
    await tx.beneficiaryMobileOtp.update({ where: { challengeId: challenge.challengeId }, data: { consumedAt: now } });
    if (purpose === "register") {
      const { firstName, middleName, lastName, birthDate, barangayId } = account.registration;
      account.link = await tx.mobileBeneficiaryAccount.create({ data: {
        issuer: "garantiyaid:phone-login", subject: accountId, firstName, middleName, lastName, birthDate, barangayId,
      } });
      await tx.beneficiaryMobileAccount.update({ where: { accountId }, data: { verifiedAt: now, linkId: account.link.accountId } });
      account.verifiedAt = now;
      await audit(tx, account, "MOBILE_LINK_REQUESTED");
    }
    const token = `gya_mobile_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    await tx.beneficiaryMobileSession.create({ data: { accountId, tokenHash: hashMobileSecret(`session:${token}`), authMode: env.mobileAuthMode, expiresAt } });
    await audit(tx, account, "MOBILE_PHONE_AUTHENTICATED");
    return { accessToken: token, tokenType: "Bearer", expiresAt: expiresAt.toISOString(), beneficiary: mobileProfile(account) };
  });
  if (result.error) throw new AppError(400, "OTP_INCORRECT", "The verification code is incorrect.");
  return result;
}

export async function authenticateMobile(authorization) {
  const match = /^Bearer (gya_mobile_[A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
  if (!match) throw new AppError(401, "AUTHENTICATION_REQUIRED", "A beneficiary access token is required.");
  const session = await prisma.beneficiaryMobileSession.findUnique({
    where: { tokenHash: hashMobileSecret(`session:${match[1]}`) },
    include: { account: { include: { link: { include: { beneficiary: true } } } } },
  });
  if (!session || session.authMode !== env.mobileAuthMode || session.revokedAt || session.expiresAt <= new Date() || !session.account.verifiedAt) {
    throw new AppError(401, "SESSION_EXPIRED", "Your beneficiary session has expired or the account is inactive. Sign in again.");
  }
  assertActive(session.account);
  return { ...session, account: withBeneficiary(session.account) };
}

export async function updateMobileProfile(session, input) {
  return prisma.$transaction(async (tx) => {
    const account = await lockMobileSession(tx, session);
    if (account.link.status === "LINKED") {
      throw new AppError(409, "STAFF_CORRECTION_REQUIRED", "Contact staff to correct your linked official record.");
    }
    if (input.barangayId) await activeBarangay(tx, input.barangayId);
    const { address, ...details } = input;
    const registration = { ...account.registration, ...input };
    if (input.birthDate) registration.birthDate = input.birthDate.toISOString();
    const changed = await tx.mobileBeneficiaryAccount.updateMany({
      where: { accountId: account.link.accountId, revision: account.link.revision, status: { not: "LINKED" } },
      data: { ...details, status: "PENDING", reviewNote: null, reviewedAt: null, reviewedById: null, revision: { increment: 1 } },
    });
    if (changed.count !== 1) throw new AppError(409, "MOBILE_LINK_CONFLICT", "Refresh the link decision.");
    await tx.beneficiaryMobileAccount.update({ where: { accountId: account.accountId }, data: { registration } });
    account.registration = registration;
    account.link = { ...account.link, status: "PENDING", reviewNote: null };
    await audit(tx, account, "MOBILE_LINK_CORRECTED");
    return mobileProfile(account);
  });
}

export async function lockMobileSession(database, session) {
  const account = await lockedAccount(database, session.accountId);
  const current = await database.beneficiaryMobileSession.findUnique({ where: { sessionId: session.sessionId } });
  if (!current || current.authMode !== env.mobileAuthMode || current.revokedAt || current.expiresAt <= new Date() || !account.verifiedAt) {
    throw new AppError(401, "SESSION_EXPIRED", "Sign in again before saving.");
  }
  assertActive(account);
  return account;
}

export async function logoutMobile(session) {
  await prisma.$transaction(async (tx) => {
    const account = await lockedAccount(tx, session.accountId);
    await tx.beneficiaryMobileSession.update({ where: { sessionId: session.sessionId }, data: { revokedAt: new Date() } });
    await audit(tx, account, "MOBILE_SESSION_REVOKED");
  });
}
