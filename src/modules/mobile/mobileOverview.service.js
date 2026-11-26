import prisma from "../../lib/prisma.js";
import { distributionSlotToResponse } from "../distributions/distributionSlot.service.js";

const programSelect = {
  programId: true, programCode: true, programName: true, programType: true,
  description: true, grantAmount: true,
};

function mobileProgram(program) {
  return {
    id: program.programId, code: program.programCode, name: program.programName,
    type: program.programType, description: program.description,
    grantAmount: program.grantAmount === null ? null : Number(program.grantAmount),
  };
}

export async function getMobileOverview(session, database = prisma) {
  const beneficiaryId = session.account.beneficiaryId;
  const [enrollments, schedule] = await Promise.all([
    database.enrollment.findMany({
      where: { beneficiaryId },
      select: {
        enrollmentId: true, enrollmentDate: true, status: true,
        reviewNotes: true, reviewedAt: true, program: { select: programSelect },
      },
      orderBy: [{ enrollmentDate: "desc" }, { enrollmentId: "asc" }],
    }),
    database.schedule.findFirst({
      where: {
        beneficiaryId, status: { in: ["SCHEDULED", "CHECKED_IN"] },
        slot: { slotEnd: { gt: new Date() }, slotStatus: { not: "CLOSED" } },
        distribution: {
          status: "OPEN", program: { status: "ACTIVE" },
          allocations: { some: {
            beneficiaryId, allocationStatus: "ALLOCATED", enrollment: { status: "APPROVED" },
          } },
        },
      },
      select: {
        scheduleId: true, distributionId: true, queueNumber: true, status: true,
        slot: { select: { slotStart: true, slotEnd: true, location: true } },
        distribution: { select: { title: true, program: { select: programSelect } } },
      },
      orderBy: [{ slot: { slotStart: "asc" } }, { scheduleId: "asc" }],
    }),
  ]);
  const slot = schedule ? distributionSlotToResponse(schedule.slot) : null;
  return {
    enrollments: enrollments.map(enrollment => ({
      id: enrollment.enrollmentId,
      enrollmentDate: enrollment.enrollmentDate.toISOString().slice(0, 10),
      status: enrollment.status.toLowerCase(),
      reviewNotes: enrollment.reviewNotes,
      reviewedAt: enrollment.reviewedAt?.toISOString() ?? null,
      program: mobileProgram(enrollment.program),
    })),
    nextSchedule: schedule ? {
      id: schedule.scheduleId, distributionId: schedule.distributionId,
      title: schedule.distribution.title, date: slot.slotStart.slice(0, 10),
      slotStart: slot.slotStart, slotEnd: slot.slotEnd,
      queueNumber: schedule.queueNumber, status: schedule.status.toLowerCase(),
      location: schedule.slot.location, program: mobileProgram(schedule.distribution.program),
    } : null,
  };
}
