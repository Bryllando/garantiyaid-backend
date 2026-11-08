import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { AppError } from "../../utils/AppError.js";
import {
  assertBarangayCanDeactivate,
  barangaySelect,
  getBarangayOrThrow,
} from "./barangay.service.js";

export const listBarangays = asyncHandler(async (req, res) => {
  const { activeOnly, search } = req.validatedQuery;
  const where = {
    ...(activeOnly === "true" ? { isActive: true } : {}),
    ...(req.auth.role === "BARANGAY_FACILITATOR" ? { barangayId: req.staffUser.barangayId } : {}),
    ...(search ? {
      OR: [
        { barangayName: { contains: search, mode: "insensitive" } },
        { barangayCode: { contains: search, mode: "insensitive" } },
      ],
    } : {}),
  };

  const barangays = await prisma.barangay.findMany({
    where,
    select: barangaySelect,
    orderBy: [{ city: "asc" }, { barangayName: "asc" }],
  });

  res.status(200).json({ success: true, data: { barangays } });
});

export const createBarangay = asyncHandler(async (req, res) => {
  const barangay = await prisma.$transaction(async (tx) => {
    const createdBarangay = await tx.barangay.create({
      data: req.validatedBody,
      select: barangaySelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "BARANGAY_CREATED",
        entityAffected: "BARANGAY",
        recordId: createdBarangay.barangayId,
        ipAddress: clientIpAddress(req),
      },
    });

    return createdBarangay;
  });

  res.status(201).json({ success: true, data: { barangay } });
});

export const updateBarangay = asyncHandler(async (req, res) => {
  let barangay;
  try {
    barangay = await prisma.$transaction(async (tx) => {
      const existing = await getBarangayOrThrow(req.validatedParams.barangayId, tx);
      if (Object.keys(req.validatedBody).length === 1 && req.validatedBody.isActive === existing.isActive) return existing;
      await assertBarangayCanDeactivate(req.validatedParams.barangayId, req.validatedBody, tx);
      const updatedBarangay = await tx.barangay.update({
        where: { barangayId: req.validatedParams.barangayId },
        data: req.validatedBody,
        select: barangaySelect,
      });

      await tx.auditLog.create({
        data: {
          userId: req.auth.userId,
          action: existing.isActive && !updatedBarangay.isActive ? "BARANGAY_ARCHIVED"
            : !existing.isActive && updatedBarangay.isActive ? "BARANGAY_RESTORED" : "BARANGAY_UPDATED",
          entityAffected: "BARANGAY",
          recordId: updatedBarangay.barangayId,
          ipAddress: clientIpAddress(req),
          details: {
            changedFields: Object.keys(req.validatedBody),
            previousIsActive: existing.isActive,
            isActive: updatedBarangay.isActive,
          },
        },
      });

      return updatedBarangay;
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error.code === "P2034") throw new AppError(409, "BARANGAY_CHANGED", "The barangay or its assignments changed. Refresh the list and review it before trying again.");
    throw error;
  }

  res.status(200).json({ success: true, data: { barangay } });
});
