import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../src/lib/prisma.js";
import { activateProgram, closeProgram, createProgram } from "../src/modules/programs/program.controller.js";
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

test("administrators and DSWD manage programs while every authenticated staff role can read them", () => {
  assert.deepEqual(PROGRAM_MANAGE_ROLES, ["SYSTEM_ADMIN", "DSWD_STAFF"]);
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

test("creation saves the budget and initial rule atomically, and unresolved claims block closure", async (t) => {
  const programId = "11111111-1111-4111-8111-111111111111";
  const criterion = { criterionName: "Adult applicant", fieldName: "AGE", operator: "GREATER_THAN_OR_EQUAL", expectedValue: 18, isRequired: true };
  let program;
  let unresolved = 1;
  let transitions = 0;
  const tx = {
    program: {
      create: async ({ data }) => {
        assert.deepEqual(data.criteria, { create: [criterion] });
        assert.equal(data.budgetAmount, 500);
        program = { ...data, programId, status: "DRAFT", criteria: data.criteria.create };
        return program;
      },
      findFirst: async () => program,
      findUniqueOrThrow: async () => program,
      updateMany: async ({ data }) => { transitions++; Object.assign(program, data); return { count: 1 }; },
    },
    claim: { count: async ({ where }) => {
      assert.deepEqual(where, { distribution: { programId }, claimStatus: { in: ["PENDING", "VERIFIED"] } });
      return unresolved;
    } },
    auditLog: { create: async () => {} },
  };
  const original = prisma.$transaction;
  prisma.$transaction = async (work) => work(tx);
  t.after(() => { prisma.$transaction = original; });
  const invoke = (handler, validatedBody) => new Promise((resolve, reject) => handler({
    auth: { userId: programId }, staffUser: { role: "SYSTEM_ADMIN" }, validatedParams: { programId }, validatedBody, headers: {},
  }, { status() { return this; }, json: resolve }, reject));

  await invoke(createProgram, { programCode: "QA", budgetAmount: 500, criteria: [criterion] });
  program.budgetAmount = null;
  await assert.rejects(invoke(activateProgram), { code: "INVALID_PROGRAM_BUDGET" });
  program.budgetAmount = 500;
  await invoke(activateProgram);
  await assert.rejects(invoke(closeProgram), { code: "PROGRAM_HAS_UNRESOLVED_CLAIMS" });
  assert.equal(program.status, "ACTIVE");
  assert.equal(transitions, 1);
  unresolved = 0;
  assert.equal((await invoke(closeProgram)).data.program.status, "CLOSED");
});
