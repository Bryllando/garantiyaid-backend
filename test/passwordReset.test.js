import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import express from "express";
import { once } from "node:events";
import prisma from "../src/lib/prisma.js";
import authRoutes from "../src/modules/auth/auth.routes.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import {
  completePasswordResetSchema,
  requestPasswordResetSchema,
} from "../src/modules/auth/auth.schemas.js";
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
  passwordResetLookupWhere,
  passwordResetTokenIsUsable,
} from "../src/modules/auth/passwordReset.service.js";
import { staffEmailDeliveryTargetPath } from "../src/workers/staffEmail.processor.js";

function routeSurface(router) {
  return router.stack.filter((layer) => layer.route).map((layer) => ({
    path: layer.route.path,
    methods: Object.keys(layer.route.methods).sort(),
  }));
}

test("password-reset inputs reuse the staff password policy and expose public routes", () => {
  assert.deepEqual(requestPasswordResetSchema.parse({ account: " Staff@Example.com " }), {
    account: "staff@example.com",
  });
  const generated = generatePasswordResetToken(new Date("2026-09-19T00:00:00Z"));
  assert.match(generated.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(generated.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(hashPasswordResetToken(generated.token), generated.tokenHash);
  assert.equal(completePasswordResetSchema.safeParse({
    token: generated.token,
    newPassword: "A secure replacement password",
  }).success, true);
  assert.equal(completePasswordResetSchema.safeParse({
    token: generated.token,
    newPassword: "too short",
  }).success, false);
  const routes = routeSurface(authRoutes);
  assert.ok(routes.some((route) => route.path === "/password-reset/request" && route.methods.includes("post")));
  assert.ok(routes.some((route) => route.path === "/password-reset/complete" && route.methods.includes("post")));
});

test("password-reset lookup is active-only and token state rejects used, expired, and inactive records", () => {
  assert.deepEqual(passwordResetLookupWhere(" dswd-0001 "), {
    isActive: true,
    archivedAt: null,
    role: { in: ["SYSTEM_ADMIN", "DSWD_STAFF", "BARANGAY_FACILITATOR"] },
    OR: [
      { email: "dswd-0001" },
      { employeeId: "DSWD-0001" },
      { username: "dswd-0001" },
    ],
  });
  const now = new Date("2026-09-19T00:00:00Z");
  const record = { usedAt: null, expiresAt: new Date(now.getTime() + 60_000), user: { isActive: true, archivedAt: null } };
  assert.equal(passwordResetTokenIsUsable(record, now), true);
  assert.equal(passwordResetTokenIsUsable({ ...record, usedAt: now }, now), false);
  assert.equal(passwordResetTokenIsUsable({ ...record, expiresAt: now }, now), false);
  assert.equal(passwordResetTokenIsUsable({ ...record, user: { isActive: false, archivedAt: null } }, now), false);
});

test("only reset-request email jobs may use the transient reset link", () => {
  const resetPath = `/reset-password?token=${"a".repeat(43)}`;
  assert.equal(staffEmailDeliveryTargetPath({
    notificationType: "SECURITY_PASSWORD_RESET_REQUESTED",
    targetPath: "/login",
  }, resetPath), resetPath);
  assert.equal(staffEmailDeliveryTargetPath({
    notificationType: "SECURITY_PASSWORD_RESET_REQUESTED",
    targetPath: "/login",
  }, "https://evil.test/reset"), null);
  assert.equal(staffEmailDeliveryTargetPath({
    notificationType: "SECURITY_PASSWORD_CHANGED",
    targetPath: "/account?section=password",
  }, resetPath), "/account?section=password");
});

test("reset requests are enumeration-safe and completion consumes the token and revokes every session", async (t) => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const resetTokenId = "22222222-2222-4222-8222-222222222222";
  const generated = generatePasswordResetToken();
  const originalPasswordHash = await bcrypt.hash("Original private password", 12);
  const state = {
    user: {
      userId,
      employeeId: "DSWD-0001",
      fullName: "Temporary Reset User",
      email: "reset@example.test",
      passwordHash: originalPasswordHash,
      isActive: true,
      archivedAt: null,
    },
    token: null,
    sessions: [{ revokedAt: null }, { revokedAt: null }],
    audits: [],
    notifications: [],
  };
  const originals = {
    findUser: prisma.user.findFirst,
    findToken: prisma.staffPasswordResetToken.findUnique,
    transaction: prisma.$transaction,
  };
  t.after(() => {
    prisma.user.findFirst = originals.findUser;
    prisma.staffPasswordResetToken.findUnique = originals.findToken;
    prisma.$transaction = originals.transaction;
  });

  const database = {
    user: {
      updateMany: async ({ where, data }) => {
        if (where.userId !== userId || !state.user.isActive || state.user.archivedAt) return { count: 0 };
        Object.assign(state.user, data);
        return { count: 1 };
      },
    },
    staffPasswordResetToken: {
      create: async ({ data }) => {
        state.token = { resetTokenId, ...data, usedAt: null, user: state.user };
        return { resetTokenId };
      },
      updateMany: async ({ where, data }) => {
        if (!state.token) return { count: 0 };
        if (where.resetTokenId && where.resetTokenId !== resetTokenId) return { count: 0 };
        if (where.userId && where.userId !== userId) return { count: 0 };
        if (where.usedAt === null && state.token.usedAt) return { count: 0 };
        if (where.expiresAt?.gt && state.token.expiresAt <= where.expiresAt.gt) return { count: 0 };
        Object.assign(state.token, data);
        return { count: 1 };
      },
    },
    staffSession: {
      updateMany: async ({ data }) => {
        let count = 0;
        for (const session of state.sessions) {
          if (!session.revokedAt) { Object.assign(session, data); count += 1; }
        }
        return { count };
      },
    },
    auditLog: { create: async ({ data }) => { state.audits.push(data); return data } },
    staffNotification: {
      upsert: async ({ create }) => {
        const notification = {
          ...create,
          notificationId: "33333333-3333-4333-8333-333333333333",
          emailStatus: "NOT_REQUESTED",
          emailProviderMode: "DISABLED",
          createdAt: new Date(),
        };
        state.notifications.push(notification);
        return notification;
      },
    },
    $transaction: async (work) => work(database),
  };
  prisma.user.findFirst = async ({ where }) => where.OR.some((entry) => Object.values(entry).includes("reset@example.test")) ? state.user : null;
  prisma.staffPasswordResetToken.findUnique = async ({ where }) => (
    state.token?.tokenHash === where.tokenHash ? { ...state.token, user: state.user } : null
  );
  prisma.$transaction = async (work) => work(database);

  const app = express();
  app.use(express.json());
  app.use("/api/v1/auth", authRoutes);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/auth`;

  const unknown = await fetch(`${baseUrl}/password-reset/request`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "unknown@example.test" }),
  });
  const existing = await fetch(`${baseUrl}/password-reset/request`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "reset@example.test" }),
  });
  assert.equal(unknown.status, 202);
  assert.equal(existing.status, 202);
  assert.deepEqual(await existing.json(), await unknown.json());
  assert.equal(Object.hasOwn(state.token, "token"), false);
  assert.match(state.token.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(state.notifications[0].targetPath, "/login");

  state.token.tokenHash = generated.tokenHash;
  const complete = await fetch(`${baseUrl}/password-reset/complete`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: generated.token, newPassword: "Replacement private password" }),
  });
  assert.equal(complete.status, 200);
  assert.equal(state.sessions.every((session) => session.revokedAt instanceof Date), true);
  assert.equal(await bcrypt.compare("Replacement private password", state.user.passwordHash), true);
  assert.ok(state.token.usedAt instanceof Date);

  const reused = await fetch(`${baseUrl}/password-reset/complete`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: generated.token, newPassword: "Another replacement password" }),
  });
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error.code, "INVALID_OR_EXPIRED_PASSWORD_RESET_TOKEN");
});
