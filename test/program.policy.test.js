import test from "node:test";
import assert from "node:assert/strict";
import {
  PROGRAM_MANAGE_ROLES,
  PROGRAM_READ_ROLES,
} from "../src/modules/programs/program.policy.js";
import {
  assertProgramDetailsValid,
  assertProgramDraft,
  assertProgramTransition,
  getProgramOrThrow,
} from "../src/modules/programs/program.service.js";

test("DSWD manages programs while every authenticated staff role can read them", () => {
  assert.deepEqual(PROGRAM_MANAGE_ROLES, ["DSWD_STAFF"]);
  assert.deepEqual(PROGRAM_READ_ROLES, [
    "SYSTEM_ADMIN",
    "DSWD_STAFF",
    "BARANGAY_FACILITATOR",
  ]);
});

test("only draft programs are editable", () => {
  assert.doesNotThrow(() => assertProgramDraft({ status: "DRAFT" }));
  assert.throws(
    () => assertProgramDraft({ status: "ACTIVE" }),
    (error) => error.code === "PROGRAM_NOT_EDITABLE" && error.statusCode === 409,
  );
});

test("program detail lookup does not hide non-active records from read-authorized staff", async () => {
  let capturedWhere;
  const program = { programId: "11111111-1111-4111-8111-111111111111", status: "DRAFT" };
  const database = {
    program: {
      findFirst: async ({ where }) => {
        capturedWhere = where;
        return program;
      },
    },
  };

  assert.equal(
    await getProgramOrThrow(program.programId, { role: "BARANGAY_FACILITATOR" }, database),
    program,
  );
  assert.deepEqual(capturedWhere, { programId: program.programId });
});

test("program dates and budget must be internally consistent", () => {
  assert.throws(
    () => assertProgramDetailsValid({
      applicationStartDate: new Date("2026-09-01T00:00:00.000Z"),
      applicationEndDate: new Date("2026-08-01T00:00:00.000Z"),
    }),
    (error) => error.code === "INVALID_APPLICATION_PERIOD",
  );

  assert.throws(
    () => assertProgramDetailsValid({ grantAmount: 5001, budgetAmount: 5000 }),
    (error) => error.code === "INVALID_PROGRAM_BUDGET",
  );
});

test("program lifecycle permits only the approved transitions", () => {
  assert.doesNotThrow(() => assertProgramTransition({ status: "DRAFT" }, "ACTIVE"));
  assert.doesNotThrow(() => assertProgramTransition({ status: "DRAFT" }, "CANCELLED"));
  assert.doesNotThrow(() => assertProgramTransition({ status: "ACTIVE" }, "CLOSED"));
  assert.throws(
    () => assertProgramTransition({ status: "CLOSED" }, "ACTIVE"),
    (error) => error.code === "INVALID_PROGRAM_TRANSITION",
  );
});
