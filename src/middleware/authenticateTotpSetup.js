import prisma from "../lib/prisma.js";
import { staffUserSelect, verifyTotpSetupToken } from "../modules/auth/auth.service.js";
import { AppError } from "../utils/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const authenticateTotpSetup = asyncHandler(async (req, res, next) => {
  const authorization = req.get("authorization");
  const [scheme, token] = authorization?.split(" ") ?? [];

  if (scheme !== "Bearer" || !token) {
    throw new AppError(401, "AUTHENTICATION_REQUIRED", "A TOTP setup token is required.");
  }

  const payload = verifyTotpSetupToken(token);
  const user = await prisma.user.findUnique({
    where: { userId: payload.sub },
    select: staffUserSelect,
  });

  if (!user || !user.isActive) {
    throw new AppError(401, "ACCOUNT_INACTIVE", "This staff account is no longer active.");
  }

  if (user.totpEnabled) {
    throw new AppError(403, "TOTP_ALREADY_ENABLED", "TOTP is already enabled for this staff account.");
  }

  req.auth = { userId: user.userId, role: user.role };
  req.staffUser = user;
  return next();
});
