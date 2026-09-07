import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import app from "../src/app.js";
import {
  createStaffNotification,
  notifyStaffScope,
  staffNotificationToResponse,
} from "../src/modules/staffNotifications/staffNotification.service.js";
import {
  staffNotificationIdSchema,
  staffNotificationListQuerySchema,
} from "../src/modules/staffNotifications/staffNotification.schemas.js";

const createdAt = new Date("2026-09-01T12:00:00.000Z");

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("staff inbox validates bounded reads, UUIDs, and internal navigation targets", async () => {
  assert.deepEqual(staffNotificationListQuerySchema.parse({}), { pageSize: 8 });
  assert.equal(staffNotificationListQuerySchema.safeParse({ pageSize: 21 }).success, false);
  assert.equal(staffNotificationIdSchema.safeParse({ notificationId: "not-a-uuid" }).success, false);
  await assert.rejects(
    () => createStaffNotification({
      userId: "11111111-1111-4111-8111-111111111111",
      notificationType: "TEST",
      title: "Unsafe",
      message: "Unsafe target",
      targetPath: "https://example.com",
    }, { staffNotification: { create: async () => null } }),
    /internal application path/,
  );
});

test("staff inbox fans one persisted notification to each scoped active account", async () => {
  const users = [
    { userId: "11111111-1111-4111-8111-111111111111", role: "SYSTEM_ADMIN" },
    { userId: "22222222-2222-4222-8222-222222222222", role: "BARANGAY_FACILITATOR" },
  ];
  const writes = [];
  const events = [];
  const database = {
    user: { findMany: async (query) => {
      assert.equal(query.where.isActive, true);
      return users;
    } },
    staffNotification: { upsert: async ({ create }) => {
      writes.push(create);
      return {
        notificationId: `${writes.length}1111111-1111-4111-8111-111111111111`.slice(0, 36),
        notificationType: create.notificationType,
        title: create.title,
        message: create.message,
        targetPath: create.targetPath,
        readAt: null,
        createdAt,
      };
    } },
  };
  const notifications = await notifyStaffScope({
    barangayId: "33333333-3333-4333-8333-333333333333",
    notificationType: "DISTRIBUTION_OPENED",
    title: "Distribution update",
    message: "A distribution was opened.",
    targetPaths: {
      SYSTEM_ADMIN: "/distributions/manage",
      BARANGAY_FACILITATOR: "/facilitator/queue",
    },
    deduplicationKey: "distribution-opened",
  }, {
    database,
    publish: async (eventName, payload) => { events.push({ eventName, payload }); return true },
  });

  assert.equal(notifications.length, 2);
  assert.deepEqual(writes.map(({ targetPath }) => targetPath), ["/distributions/manage", "/facilitator/queue"]);
  assert.deepEqual(events.map(({ eventName }) => eventName), ["staff.notification.created", "staff.notification.created"]);
  assert.deepEqual(events.map(({ payload }) => payload.userId), users.map(({ userId }) => userId));
  assert.deepEqual(staffNotificationToResponse(notifications[0]), {
    ...notifications[0],
    readAt: null,
    createdAt: createdAt.toISOString(),
  });
});

test("staff inbox list and read actions require an authenticated staff session", async () => {
  const notificationId = "11111111-1111-4111-8111-111111111111";
  const responses = await Promise.all([
    fetch(`${baseUrl}/api/v1/staff-notifications`),
    fetch(`${baseUrl}/api/v1/staff-notifications/${notificationId}/read`, { method: "PATCH" }),
    fetch(`${baseUrl}/api/v1/staff-notifications/read-all`, { method: "POST" }),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "AUTHENTICATION_REQUIRED");
  }
});
