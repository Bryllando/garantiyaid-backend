import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../src/lib/prisma.js";

// Opt-in checks insert synthetic rows inside transactions that always roll back.
const enabled = process.env.RUN_MOBILE_LINK_DATABASE_TESTS === "1";
for (const scenario of ["one account per beneficiary", "one request per mobile identity", "linked state requires a beneficiary"]) {
  test(`database enforces ${scenario} without retaining fixtures`, { skip: !enabled }, async () => {
    const barangayId = randomUUID(), beneficiaryId = randomUUID();
    const issuer = `fixture-${randomUUID()}`;
    const profile = { issuer, subject: "fixture", firstName: "Mobile", lastName: "Fixture", birthDate: new Date("1990-01-12"), barangayId };
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.barangay.create({ data: { barangayId, barangayCode: randomUUID().slice(0, 20), barangayName: "Rollback fixture", city: "Test city", province: "Test province" } });
      await tx.beneficiary.create({ data: { beneficiaryId, firstName: "Mobile", lastName: "Fixture", birthDate: profile.birthDate, sex: "UNKNOWN", address: "Synthetic fixture", barangayId } });
      if (scenario === "one account per beneficiary") {
        await tx.mobileBeneficiaryAccount.create({ data: { ...profile, status: "LINKED", beneficiaryId } });
        await tx.mobileBeneficiaryAccount.create({ data: { ...profile, subject: "second", status: "LINKED", beneficiaryId } });
      } else if (scenario === "one request per mobile identity") {
        await tx.mobileBeneficiaryAccount.create({ data: profile });
        await tx.mobileBeneficiaryAccount.create({ data: profile });
      } else {
        await tx.mobileBeneficiaryAccount.create({ data: { ...profile, status: "LINKED" } });
      }
      throw new Error("Database incorrectly accepted the duplicate or invalid link");
    }), error => scenario === "linked state requires a beneficiary"
      ? error.message.includes("mobile_beneficiary_accounts_link_state_check") : error.code === "P2002");
    assert.equal(await prisma.barangay.count({ where: { barangayId } }), 0);
    assert.equal(await prisma.beneficiary.count({ where: { beneficiaryId } }), 0);
    assert.equal(await prisma.mobileBeneficiaryAccount.count({ where: { issuer } }), 0);
  });
}
test.after(async () => { if (enabled) await prisma.$disconnect(); });
