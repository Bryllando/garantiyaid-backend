import { AppError } from "../utils/AppError.js";

export function authorizeRoles(...allowedRoles) {
  return function authorizeRequest(req, res, next) {
    if (!req.auth || !allowedRoles.includes(req.auth.role)) {
      return next(new AppError(403, "FORBIDDEN", "You do not have permission to perform this action."));
    }

    return next();
  };
}
