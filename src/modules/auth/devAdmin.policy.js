import { AppError } from "../../utils/AppError.js";

export const DEV_ADMIN_EMPLOYEE_ID = "DEV-ADMIN";
export const DEV_ADMIN_USERNAME = "dev.admin";
export const DEV_ADMIN_EMAIL = "dev-admin@garantiyaid.invalid";

const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "::ffff:127.0.0.1"]);
const localUrl = value => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && loopback.has(url.hostname)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch { return false; }
};

export function devAdminConfigurationError(config) {
  if (!config.devQuickLoginEnabled) return null;
  if (config.nodeEnv !== "development") return "Developer Admin login is allowed only in development.";
  if (config.trustProxyHops !== 0) return "Developer Admin login requires TRUST_PROXY_HOPS=0.";
  try {
    const database = new URL(config.databaseUrl);
    if (!["postgres:", "postgresql:"].includes(database.protocol) || !loopback.has(database.hostname)
      || !config.devAdminDatabase || decodeURIComponent(database.pathname.slice(1)) !== config.devAdminDatabase) {
      return "Developer Admin login requires an explicitly designated local DEV_ADMIN_DATABASE matching DATABASE_URL.";
    }
  } catch { return "Developer Admin login requires a local demo database."; }
  if (!config.corsOrigins?.length || config.corsOrigins.some(origin => !localUrl(origin))) {
    return "Developer Admin login requires exclusively local CORS origins.";
  }
  return null;
}

export function isDeveloperAdmin(user) {
  return user?.employeeId?.toUpperCase() === DEV_ADMIN_EMPLOYEE_ID || user?.username?.toLowerCase() === DEV_ADMIN_USERNAME;
}

export function assertDevAdminRequest(req, config, { requireOrigin = false } = {}) {
  if (!config.devQuickLoginEnabled || devAdminConfigurationError(config)) {
    throw new AppError(403, "DEV_LOGIN_UNAVAILABLE", "Developer sign-in is disabled outside the designated local development setup.");
  }
  const headers = req?.headers ?? {};
  const origin = headers.origin;
  if (!loopback.has(req?.socket?.remoteAddress) || !loopback.has(req?.socket?.localAddress)
    || !localUrl(`http://${headers.host}`)
    || (requireOrigin && !origin)
    || (origin && (!localUrl(origin) || !config.corsOrigins.includes(origin)))
    || headers["sec-fetch-site"] === "cross-site") {
    throw new AppError(403, "DEV_LOGIN_LOCAL_ONLY", "Developer sign-in is available only from the configured local app address.");
  }
}

export function assertDevAdminAccount(user) {
  if (user?.employeeId !== DEV_ADMIN_EMPLOYEE_ID || user?.username !== DEV_ADMIN_USERNAME
    || user?.role !== "SYSTEM_ADMIN" || !user.isActive || user.archivedAt) {
    throw new AppError(403, "DEV_ADMIN_UNAVAILABLE", "The dedicated Developer Admin account is unavailable. Run the local setup command or review its status.");
  }
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    throw new AppError(429, "ACCOUNT_TEMPORARILY_LOCKED", "This account is temporarily locked. Wait before trying again.");
  }
}
