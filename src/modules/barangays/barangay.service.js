import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";

export const barangaySelect = {
  barangayId: true,
  barangayCode: true,
  barangayName: true,
  city: true,
  province: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
};

export async function getBarangayOrThrow(barangayId) {
  const barangay = await prisma.barangay.findUnique({
    where: { barangayId },
    select: barangaySelect,
  });

  if (!barangay) {
    throw new AppError(404, "BARANGAY_NOT_FOUND", "Barangay was not found.");
  }

  return barangay;
}
