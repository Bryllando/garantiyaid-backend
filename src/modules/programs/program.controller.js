import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import {
  assertProgramCriteriaValid,
  assertProgramDetailsValid,
  assertProgramDraft,
  assertProgramTransition,
  getProgramOrThrow,
  programCriterionSelect,
  programSelect,
} from "./program.service.js";

async function runProgramTransaction(operation) {
  try {
    return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error?.code === "P2034") {
      throw new AppError(
        409,
        "PROGRAM_CONCURRENT_CHANGE",
        "The program changed while this request was being processed. Refresh and try again.",
      );
    }
    throw error;
  }
}

export const createProgram = asyncHandler(async (req, res) => {
  assertProgramDetailsValid(req.validatedBody);

  const program = await prisma.$transaction(async (tx) => {
    const createdProgram = await tx.program.create({
      data: {
        ...req.validatedBody,
        requiredDocumentTypes: req.validatedBody.requiredDocumentTypes ?? [],
        createdById: req.auth.userId,
      },
      select: programSelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "PROGRAM_CREATED",
        entityAffected: "PROGRAM",
        recordId: createdProgram.programId,
        ipAddress: clientIpAddress(req),
        details: { programCode: createdProgram.programCode, status: createdProgram.status },
      },
    });

    return createdProgram;
  });

  res.status(201).json({ success: true, data: { program } });
});

export const listPrograms = asyncHandler(async (req, res) => {
  const { page, pageSize, status, search } = req.validatedQuery;
  const where = {
    ...(status ? { status } : {}),
    ...(search ? {
      OR: [
        { programName: { contains: search, mode: "insensitive" } },
        { programCode: { contains: search, mode: "insensitive" } },
        { programType: { contains: search, mode: "insensitive" } },
      ],
    } : {}),
  };

  const [programs, total] = await Promise.all([
    prisma.program.findMany({
      where,
      select: programSelect,
      orderBy: [{ createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.program.count({ where }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      programs,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  });
});

export const getProgram = asyncHandler(async (req, res) => {
  const program = await getProgramOrThrow(req.validatedParams.programId, req.staffUser);
  res.status(200).json({ success: true, data: { program } });
});

export const updateProgram = asyncHandler(async (req, res) => {
  const program = await runProgramTransaction(async (tx) => {
    const existingProgram = await getProgramOrThrow(
      req.validatedParams.programId,
      req.staffUser,
      tx,
    );
    assertProgramDraft(existingProgram);
    assertProgramDetailsValid({ ...existingProgram, ...req.validatedBody });

    const updatedProgram = await tx.program.update({
      where: { programId: existingProgram.programId },
      data: req.validatedBody,
      select: programSelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "PROGRAM_UPDATED",
        entityAffected: "PROGRAM",
        recordId: updatedProgram.programId,
        ipAddress: clientIpAddress(req),
        details: { changedFields: Object.keys(req.validatedBody) },
      },
    });

    return updatedProgram;
  });

  res.status(200).json({ success: true, data: { program } });
});

async function transitionProgram(req, res, nextStatus, action) {
  const program = await runProgramTransaction(async (tx) => {
    const existingProgram = await getProgramOrThrow(
      req.validatedParams.programId,
      req.staffUser,
      tx,
    );
    assertProgramTransition(existingProgram, nextStatus);

    if (nextStatus === "ACTIVE") {
      assertProgramDetailsValid(existingProgram);
      if (existingProgram.criteria.length === 0) {
        throw new AppError(
          409,
          "PROGRAM_CRITERIA_REQUIRED",
          "Add at least one eligibility criterion before activating the program.",
        );
      }
      await assertProgramCriteriaValid(existingProgram.criteria, tx);

      const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      if (existingProgram.applicationEndDate && existingProgram.applicationEndDate < today) {
        throw new AppError(
          409,
          "PROGRAM_APPLICATION_CLOSED",
          "A program with an expired application period cannot be activated.",
        );
      }
    }

    const transition = await tx.program.updateMany({
      where: {
        programId: existingProgram.programId,
        status: existingProgram.status,
      },
      data: { status: nextStatus },
    });

    if (transition.count !== 1) {
      throw new AppError(
        409,
        "PROGRAM_STATUS_CHANGED",
        "Program status changed while this request was being processed. Refresh and try again.",
      );
    }

    const updatedProgram = await tx.program.findUniqueOrThrow({
      where: { programId: existingProgram.programId },
      select: programSelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action,
        entityAffected: "PROGRAM",
        recordId: updatedProgram.programId,
        ipAddress: clientIpAddress(req),
        details: { previousStatus: existingProgram.status, status: nextStatus },
      },
    });

    return updatedProgram;
  });

  res.status(200).json({ success: true, data: { program } });
}

export const activateProgram = asyncHandler((req, res) => (
  transitionProgram(req, res, "ACTIVE", "PROGRAM_ACTIVATED")
));

export const closeProgram = asyncHandler((req, res) => (
  transitionProgram(req, res, "CLOSED", "PROGRAM_CLOSED")
));

export const cancelProgram = asyncHandler((req, res) => (
  transitionProgram(req, res, "CANCELLED", "PROGRAM_CANCELLED")
));

export const createCriterion = asyncHandler(async (req, res) => {
  const criterion = await runProgramTransaction(async (tx) => {
    const program = await getProgramOrThrow(
      req.validatedParams.programId,
      req.staffUser,
      tx,
    );
    assertProgramDraft(program);
    const [validatedCriterion] = await assertProgramCriteriaValid([req.validatedBody], tx);

    const createdCriterion = await tx.programCriterion.create({
      data: {
        programId: program.programId,
        ...validatedCriterion,
      },
      select: programCriterionSelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "PROGRAM_CRITERION_CREATED",
        entityAffected: "PROGRAM_CRITERION",
        recordId: createdCriterion.criterionId,
        ipAddress: clientIpAddress(req),
        details: { programId: program.programId, fieldName: createdCriterion.fieldName },
      },
    });

    return createdCriterion;
  });

  res.status(201).json({ success: true, data: { criterion } });
});

async function getCriterionOrThrow(programId, criterionId, database = prisma) {
  const criterion = await database.programCriterion.findFirst({
    where: { programId, criterionId },
    select: programCriterionSelect,
  });

  if (!criterion) {
    throw new AppError(404, "PROGRAM_CRITERION_NOT_FOUND", "Program criterion was not found.");
  }

  return criterion;
}

export const updateCriterion = asyncHandler(async (req, res) => {
  const criterion = await runProgramTransaction(async (tx) => {
    const program = await getProgramOrThrow(
      req.validatedParams.programId,
      req.staffUser,
      tx,
    );
    assertProgramDraft(program);
    const existingCriterion = await getCriterionOrThrow(
      program.programId,
      req.validatedParams.criterionId,
      tx,
    );
    const [validatedCriterion] = await assertProgramCriteriaValid([{
      ...existingCriterion,
      ...req.validatedBody,
    }], tx);
    const updateData = Object.fromEntries(
      Object.keys(req.validatedBody).map((field) => [field, validatedCriterion[field]]),
    );

    const updatedCriterion = await tx.programCriterion.update({
      where: { criterionId: existingCriterion.criterionId },
      data: updateData,
      select: programCriterionSelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "PROGRAM_CRITERION_UPDATED",
        entityAffected: "PROGRAM_CRITERION",
        recordId: updatedCriterion.criterionId,
        ipAddress: clientIpAddress(req),
        details: { programId: program.programId, changedFields: Object.keys(req.validatedBody) },
      },
    });

    return updatedCriterion;
  });

  res.status(200).json({ success: true, data: { criterion } });
});

export const deleteCriterion = asyncHandler(async (req, res) => {
  await runProgramTransaction(async (tx) => {
    const program = await getProgramOrThrow(
      req.validatedParams.programId,
      req.staffUser,
      tx,
    );
    assertProgramDraft(program);
    const existingCriterion = await getCriterionOrThrow(
      program.programId,
      req.validatedParams.criterionId,
      tx,
    );

    await tx.programCriterion.delete({ where: { criterionId: existingCriterion.criterionId } });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "PROGRAM_CRITERION_DELETED",
        entityAffected: "PROGRAM_CRITERION",
        recordId: existingCriterion.criterionId,
        ipAddress: clientIpAddress(req),
        details: { programId: program.programId },
      },
    });
  });

  res.status(204).send();
});
