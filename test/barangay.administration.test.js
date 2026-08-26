import test from "node:test";
import assert from "node:assert/strict";
import { assertBarangayCanDeactivate } from "../src/modules/barangays/barangay.service.js";
import { updateBarangaySchema } from "../src/modules/barangays/barangay.schemas.js";

const barangayId = "11111111-1111-4111-8111-111111111111";

test("barangay deactivation protects active facilitator assignments", async () => {
  await assert.doesNotReject(() => assertBarangayCanDeactivate(barangayId, { isActive: true }, {}));
  await assert.doesNotReject(() => assertBarangayCanDeactivate(barangayId, { isActive: false }, {
    user: { count: async () => 0 },
  }));
  await assert.rejects(
    () => assertBarangayCanDeactivate(barangayId, { isActive: false }, {
      user: { count: async () => 2 },
    }),
    { code: "BARANGAY_HAS_ACTIVE_FACILITATORS", statusCode: 409 },
  );
});

test("barangay administration allows an optional code to be cleared", () => {
  assert.equal(updateBarangaySchema.parse({ barangayCode: "" }).barangayCode, null);
});
