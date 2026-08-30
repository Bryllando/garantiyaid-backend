import { publishRealtimeEvent } from "./socket.js";

function claimFromResult(result) {
  return result.responseBody?.data?.claim ?? null;
}

function resultError(result) {
  return result.responseBody?.error ?? null;
}

export async function publishDistributionUpdated(distribution, change) {
  await Promise.all([
    publishRealtimeEvent("distribution.updated", {
      distributionId: distribution.distributionId,
      barangayId: distribution.barangayId,
      data: {
        change,
        status: distribution.status,
        updatedAt: distribution.updatedAt,
      },
    }),
    publishRealtimeEvent("dashboard.metrics.updated", {
      distributionId: distribution.distributionId,
      barangayId: distribution.barangayId,
      data: { reason: `DISTRIBUTION_${change}` },
    }),
  ]);
}

function qrOutcome(result) {
  const errorCode = resultError(result)?.code;
  return {
    INVALID_QR_TOKEN: "INVALID_TOKEN",
    QR_TOKEN_ALREADY_USED: "DUPLICATE",
    QR_TOKEN_REVOKED: "REVOKED",
    QR_TOKEN_EXPIRED: "EXPIRED",
    DUPLICATE_CLAIM: "DUPLICATE",
    SCHEDULE_NOT_CLAIMABLE: "INVALID_SCHEDULE",
    ALLOCATION_NOT_CLAIMABLE: "INVALID_ALLOCATION",
  }[errorCode] ?? (claimFromResult(result) ? "VERIFIED" : "REJECTED");
}

export async function publishQrVerificationResult(distributionId, result) {
  if (result.replayed) return;
  const claim = claimFromResult(result);
  const error = resultError(result);
  const outcome = qrOutcome(result);
  const common = {
    distributionId,
    data: {
      outcome,
      responseStatus: result.responseStatus,
      ...(claim?.claimId ? { claimId: claim.claimId } : {}),
      ...(error?.details?.claimId ? { claimId: error.details.claimId } : {}),
    },
  };
  const events = [publishRealtimeEvent("qr.scan.recorded", common)];
  if (claim) {
    events.push(
      publishRealtimeEvent("claim.updated", {
        distributionId,
        data: {
          claimId: claim.claimId,
          beneficiaryId: claim.beneficiaryId,
          claimStatus: claim.claimStatus,
          qrVerified: claim.qrVerified,
          biometricVerified: claim.biometricVerified,
        },
      }),
      publishRealtimeEvent("schedule.checked_in", {
        distributionId,
        data: {
          scheduleId: claim.scheduleId,
          beneficiaryId: claim.beneficiaryId,
          status: "CHECKED_IN",
        },
      }),
    );
  }
  if (error) {
    events.push(publishRealtimeEvent("anomaly.detected", {
      distributionId,
      data: {
        category: "QR_SCAN",
        outcome,
        errorCode: error.code,
        ...(error.details?.claimId ? { claimId: error.details.claimId } : {}),
      },
    }));
  }
  events.push(publishRealtimeEvent("dashboard.metrics.updated", {
    distributionId,
    data: { reason: error ? "QR_SCAN_ANOMALY" : "QR_CLAIM_UPDATED" },
  }));
  await Promise.all(events);
}

function biometricOutcome(result) {
  if (claimFromResult(result)) return "MATCHED";
  return resultError(result)?.code?.replace(/^BIOMETRIC_/, "") ?? "REJECTED";
}

export async function publishBiometricVerificationResult(
  distributionId,
  beneficiaryId,
  result,
) {
  if (result.replayed) return;
  const claim = claimFromResult(result);
  const error = resultError(result);
  const attemptId = result.responseBody?.data?.biometricVerification?.attemptId
    ?? error?.details?.attemptId
    ?? null;
  const outcome = biometricOutcome(result);
  const events = [publishRealtimeEvent("biometric.attempt.recorded", {
    distributionId,
    data: {
      attemptId,
      beneficiaryId,
      outcome,
      ...(claim?.claimId ? { claimId: claim.claimId } : {}),
    },
  })];
  if (claim) {
    events.push(
      publishRealtimeEvent("claim.updated", {
        distributionId,
        data: {
          claimId: claim.claimId,
          beneficiaryId,
          claimStatus: claim.claimStatus,
          qrVerified: claim.qrVerified,
          biometricVerified: claim.biometricVerified,
        },
      }),
      publishRealtimeEvent("schedule.checked_in", {
        distributionId,
        data: { scheduleId: claim.scheduleId, beneficiaryId, status: "CHECKED_IN" },
      }),
    );
  }
  if (error) {
    events.push(publishRealtimeEvent("anomaly.detected", {
      distributionId,
      data: {
        category: "BIOMETRIC",
        attemptId,
        beneficiaryId,
        outcome,
        errorCode: error.code,
      },
    }));
  }
  events.push(publishRealtimeEvent("dashboard.metrics.updated", {
    distributionId,
    data: { reason: error ? "BIOMETRIC_ANOMALY" : "BIOMETRIC_CLAIM_UPDATED" },
  }));
  await Promise.all(events);
}

export async function publishClaimSignatureResult(distributionId, result) {
  if (result.replayed) return;
  const claim = claimFromResult(result);
  if (!claim) return;
  await Promise.all([
    publishRealtimeEvent("claim.updated", {
      distributionId,
      data: {
        claimId: claim.claimId,
        beneficiaryId: claim.beneficiaryId,
        claimStatus: claim.claimStatus,
        biometricVerified: claim.biometricVerified,
        signatureVerified: claim.signatureVerified,
      },
    }),
    publishRealtimeEvent("dashboard.metrics.updated", {
      distributionId,
      data: { reason: "CLAIM_SIGNATURE_COMPLETED" },
    }),
  ]);
}

export async function publishWalletCreditResult(distributionId, result) {
  if (result.replayed || !result.responseBody?.data?.transaction) return;
  const transaction = result.responseBody.data.transaction;
  const lifecycle = result.responseBody.data.lifecycle;
  await Promise.all([
    publishRealtimeEvent("wallet.transaction.completed", {
      distributionId,
      data: {
        transactionId: transaction.transactionId,
        claimId: transaction.claimId,
        beneficiaryId: transaction.beneficiaryId,
        transactionType: transaction.transactionType,
        status: transaction.status,
        amount: transaction.amount,
        simulated: true,
        realFundsMoved: false,
      },
    }),
    publishRealtimeEvent("claim.updated", {
      distributionId,
      data: {
        claimId: lifecycle.claimId,
        claimStatus: lifecycle.claimStatus,
        allocationId: lifecycle.allocationId,
        allocationStatus: lifecycle.allocationStatus,
      },
    }),
    publishRealtimeEvent("dashboard.metrics.updated", {
      distributionId,
      data: { reason: "SIMULATED_BENEFIT_CREDIT_COMPLETED" },
    }),
  ]);
}

export async function publishWalletReversalResult(result) {
  if (result.replayed || !result.responseBody?.data?.reversalTransaction) return;
  const transaction = result.responseBody.data.reversalTransaction;
  const lifecycle = result.responseBody.data.lifecycle;
  const distributionId = transaction.distributionId;
  await Promise.all([
    publishRealtimeEvent("wallet.transaction.reversed", {
      distributionId,
      data: {
        transactionId: transaction.transactionId,
        originalTransactionId: transaction.reversalOfId,
        claimId: transaction.claimId,
        beneficiaryId: transaction.beneficiaryId,
        amount: transaction.amount,
        status: transaction.status,
        simulated: true,
        realFundsMoved: false,
      },
    }),
    publishRealtimeEvent("claim.updated", {
      distributionId,
      data: {
        claimId: lifecycle.claimId,
        claimStatus: lifecycle.claimStatus,
        allocationId: lifecycle.allocationId,
        allocationStatus: lifecycle.allocationStatus,
      },
    }),
    publishRealtimeEvent("anomaly.detected", {
      distributionId,
      data: {
        category: "SIMULATED_TRANSACTION_REVERSAL",
        transactionId: transaction.transactionId,
        claimId: transaction.claimId,
      },
    }),
    publishRealtimeEvent("dashboard.metrics.updated", {
      distributionId,
      data: { reason: "SIMULATED_BENEFIT_CREDIT_REVERSED" },
    }),
  ]);
}

export async function publishNotificationLifecycle(eventName, notification, data = {}) {
  const barangayId = notification.beneficiary?.barangayId ?? null;
  await Promise.all([
    publishRealtimeEvent(eventName, {
      distributionId: notification.distributionId,
      barangayId,
      data: {
        notificationId: notification.notificationId,
        beneficiaryId: notification.beneficiaryId,
        scheduleId: notification.scheduleId,
        notificationType: notification.notificationType,
        channel: notification.channel,
        ...data,
      },
    }),
    publishRealtimeEvent("notification.metrics.updated", {
      distributionId: notification.distributionId,
      barangayId,
      data: {
        reason: eventName.toUpperCase().replaceAll(".", "_"),
      },
    }),
  ]);
}

async function publishChatbotLifecycle(eventName, session, data = {}) {
  await Promise.all([
    publishRealtimeEvent(eventName, {
      barangayId: session.barangayId,
      data: {
        sessionId: session.sessionId,
        status: session.status,
        ...data,
      },
    }),
    publishRealtimeEvent("chatbot.metrics.updated", {
      barangayId: session.barangayId,
      data: { reason: eventName.toUpperCase().replaceAll(".", "_") },
    }),
  ]);
}

export async function publishChatbotSessionEscalated(session, data = {}) {
  return publishChatbotLifecycle("chatbot.session.escalated", session, data);
}

export async function publishChatbotStaffReplyCreated(session, data = {}) {
  return publishChatbotLifecycle("chatbot.staff_reply.created", session, data);
}

export async function publishChatbotSessionResolved(session, data = {}) {
  return publishChatbotLifecycle("chatbot.session.resolved", session, data);
}
