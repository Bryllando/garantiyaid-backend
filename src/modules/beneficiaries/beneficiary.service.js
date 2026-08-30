import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { beneficiaryAccessScope } from "./beneficiary.policy.js";

export const beneficiarySelect = {
  beneficiaryId: true,
  firstName: true,
  middleName: true,
  lastName: true,
  birthDate: true,
  sex: true,
  address: true,
  sitioPurok: true,
  barangayId: true,
  contactNumber: true,
  email: true,
  philsysNumber: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  barangay: {
    select: {
      barangayId: true,
      barangayCode: true,
      barangayName: true,
      city: true,
      province: true,
    },
  },
};

export async function getBeneficiaryOrThrow(beneficiaryId, staffUser) {
  const beneficiary = await prisma.beneficiary.findFirst({
    where: {
      beneficiaryId,
      ...beneficiaryAccessScope(staffUser),
    },
    select: beneficiarySelect,
  });

  if (!beneficiary) {
    throw new AppError(404, "BENEFICIARY_NOT_FOUND", "Beneficiary was not found.");
  }

  return beneficiary;
}

export async function assertNoPotentialDuplicateBeneficiary({
  beneficiaryId,
  firstName,
  middleName,
  lastName,
  birthDate,
  barangayId,
  email,
  philsysNumber,
}) {
  if (email || philsysNumber) {
    return;
  }

  const duplicate = await prisma.beneficiary.findFirst({
    where: {
      ...(beneficiaryId ? { beneficiaryId: { not: beneficiaryId } } : {}),
      firstName: { equals: firstName, mode: "insensitive" },
      middleName: middleName
        ? { equals: middleName, mode: "insensitive" }
        : null,
      lastName: { equals: lastName, mode: "insensitive" },
      birthDate,
      barangayId,
    },
    select: { beneficiaryId: true },
  });

  if (duplicate) {
    throw new AppError(
      409,
      "POSSIBLE_DUPLICATE_BENEFICIARY",
      "A possible duplicate beneficiary record already exists.",
    );
  }
}
