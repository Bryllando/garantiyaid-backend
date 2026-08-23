export const STAFF_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
  "BARANGAY_FACILITATOR",
]);

export const USERNAME_LOGIN_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "BARANGAY_FACILITATOR",
]);

export const ROLE_PERMISSIONS = Object.freeze({
  SYSTEM_ADMIN: ["*"],
  DSWD_STAFF: [
    "programs:manage",
    "enrollments:review",
    "distributions:monitor",
    "wallets:manage",
    "biometrics:read",
    "biometric-consents:manage",
    "reports:read",
  ],
  BARANGAY_FACILITATOR: ["beneficiaries:manage", "documents:manage", "schedules:manage", "claims:verify", "biometrics:manage"],
});
