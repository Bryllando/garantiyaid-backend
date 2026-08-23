import prisma from "../lib/prisma.js";
import { verifyAccessToken, staffUserSelect } from "../modules/auth/auth.service.js";
import { AppError } from "../utils/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const authenticateStaff = asyncHandler(async (req, res, next) => {
  const authorization = req.get("authorization");
  const [scheme, token] = authorization?.split(" ") ?? [];

  if (scheme !== "Bearer" || !token) {
    throw new AppError(401, "AUTHENTICATION_REQUIRED", "A staff access token is required.");
  }

  const payload = verifyAccessToken(token);
  const [user, session] = await Promise.all([
    prisma.user.findUnique({
      where: { userId: payload.sub },
      select: staffUserSelect,
    }),
    prisma.staffSession.findFirst({
      where: {
        sessionId: payload.jti,
        userId: payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { sessionId: true },
    }),
  ]);

  if (!user || !user.isActive) {
    throw new AppError(401, "ACCOUNT_INACTIVE", "This staff account is no longer active.");
  }

  if (!session) {
    throw new AppError(401, "INVALID_SESSION", "This staff session is invalid or expired.");
  }

  req.auth = {
    userId: user.userId,
    role: user.role,
    sessionId: session.sessionId,
  };
  req.staffUser = user;
  return next();
});
