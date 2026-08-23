import { AppError } from "../utils/AppError.js";

export function validateBody(schema) {
  return function validateRequestBody(req, res, next) {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      return next(
        new AppError(400, "VALIDATION_ERROR", "Request validation failed.", {
          fields: result.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        }),
      );
    }

    req.validatedBody = result.data;
    return next();
  };
}

export function validateQuery(schema) {
  return function validateRequestQuery(req, res, next) {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      return next(
        new AppError(400, "VALIDATION_ERROR", "Request validation failed.", {
          fields: result.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        }),
      );
    }

    req.validatedQuery = result.data;
    return next();
  };
}

export function validateParams(schema) {
  return function validateRequestParams(req, res, next) {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      return next(
        new AppError(400, "VALIDATION_ERROR", "Request validation failed.", {
          fields: result.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        }),
      );
    }

    req.validatedParams = result.data;
    return next();
  };
}
