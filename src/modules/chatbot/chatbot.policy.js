import { AppError } from "../../utils/AppError.js";
import { CHATBOT_STAFF_ROLES } from "./chatbot.constants.js";

function facilitatorBarangay(staffUser) {
  if (!staffUser?.barangayId) {
    throw new AppError(
      403,
      "BARANGAY_ASSIGNMENT_REQUIRED",
      "This facilitator has no assigned barangay.",
    );
  }
  return staffUser.barangayId;
}

export function assertChatbotStaffAccess(staffUser) {
  if (!staffUser || !CHATBOT_STAFF_ROLES.includes(staffUser.role)) {
    throw new AppError(403, "FORBIDDEN", "You do not have permission to access chatbot escalations.");
  }
  if (staffUser.role === "BARANGAY_FACILITATOR") facilitatorBarangay(staffUser);
}

export function resolveChatbotBarangayScope(staffUser, requestedBarangayId) {
  assertChatbotStaffAccess(staffUser);
  if (staffUser.role !== "BARANGAY_FACILITATOR") return requestedBarangayId;
  const assignedBarangayId = facilitatorBarangay(staffUser);
  if (requestedBarangayId && requestedBarangayId !== assignedBarangayId) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "You can only access chatbot sessions in your assigned barangay.",
    );
  }
  return assignedBarangayId;
}

export function assertChatbotSessionBarangayAccess(staffUser, session) {
  assertChatbotStaffAccess(staffUser);
  if (staffUser.role !== "BARANGAY_FACILITATOR") return;
  const assignedBarangayId = facilitatorBarangay(staffUser);
  if (!session.beneficiaryId || !session.beneficiary?.barangayId) {
    throw new AppError(
      403,
      "CHATBOT_GENERIC_SESSION_FORBIDDEN",
      "Facilitators cannot access generic sessions that are not securely linked to their Barangay.",
    );
  }
  if (session.beneficiary.barangayId !== assignedBarangayId) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "You can only access chatbot sessions in your assigned barangay.",
    );
  }
}

export function chatbotEscalationScope(staffUser, requestedBarangayId) {
  const barangayId = resolveChatbotBarangayScope(staffUser, requestedBarangayId);
  return barangayId ? { beneficiary: { is: { barangayId } } } : {};
}

export function assertChatbotReplyOwnership(staffUser, session) {
  if (session.status !== "ESCALATED") {
    throw new AppError(
      409,
      "CHATBOT_SESSION_NOT_ESCALATED",
      "Only an escalated session accepts staff replies.",
    );
  }
  if (session.assignedStaffId && session.assignedStaffId !== staffUser.userId) {
    throw new AppError(
      409,
      "CHATBOT_SESSION_ASSIGNED",
      "Another staff member owns this escalation.",
    );
  }
}
