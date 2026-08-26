import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { clientIpAddress } from "../../utils/clientIp.js";
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
  await getBarangayOrThrow(req.validatedParams.barangayId);
  const barangay = await prisma.$transaction(async (tx) => {
    await assertBarangayCanDeactivate(
      req.validatedParams.barangayId,
      req.validatedBody,
      tx,
    );
    const updatedBarangay = await tx.barangay.update({
      where: { barangayId: req.validatedParams.barangayId },
      data: req.validatedBody,
      select: barangaySelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "BARANGAY_UPDATED",
        entityAffected: "BARANGAY",
        recordId: updatedBarangay.barangayId,
        ipAddress: clientIpAddress(req),
      },
    });

    return updatedBarangay;
  });

  res.status(200).json({ success: true, data: { barangay } });
});
