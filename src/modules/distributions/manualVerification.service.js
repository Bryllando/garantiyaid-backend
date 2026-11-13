import { AppError } from "../../utils/AppError.js";

export function manualVerificationAllowed(event) {
  return Boolean(event.manualVerificationBasis?.trim())
    && ["QR", "BIOMETRIC", "QR_OR_BIOMETRIC", "MANUAL"].includes(event.verificationRequirement);
}

export function assertManualVerificationAllowed(event) {
  if (!manualVerificationAllowed(event)) {
    throw new AppError(409, "MANUAL_VERIFICATION_NOT_ALLOWED", "This event does not permit manual identity verification. Keep its required checks or ask the responsible office for assistance.");
  }
}
