import multer from "multer";

export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  if (error.code === "P2002") {
    return res.status(409).json({
      success: false,
      error: {
        code: "DUPLICATE_RECORD",
        message: "A record with one of these unique values already exists.",
        requestId: req.requestId,
      },
    });
  }

  if (error instanceof multer.MulterError) {
    const biometricUpload = req.uploadContext === "BIOMETRIC_CAPTURE" || error.field === "faceCapture";
    const biometricCodeByMulterCode = {
      LIMIT_FILE_SIZE: "BIOMETRIC_CAPTURE_TOO_LARGE",
      LIMIT_FILE_COUNT: "BIOMETRIC_CAPTURE_FILE_COUNT_EXCEEDED",
      LIMIT_UNEXPECTED_FILE: "BIOMETRIC_CAPTURE_FILE_FIELD_INVALID",
      LIMIT_PART_COUNT: "BIOMETRIC_CAPTURE_PART_COUNT_EXCEEDED",
      LIMIT_FIELD_COUNT: "BIOMETRIC_CAPTURE_FIELD_COUNT_EXCEEDED",
    };
    const biometricMessageByMulterCode = {
      LIMIT_FILE_SIZE: "Biometric captures must not exceed 5 MB.",
      LIMIT_FILE_COUNT: "Submit exactly one biometric capture file.",
      LIMIT_UNEXPECTED_FILE: "Submit exactly one File field named faceCapture and remove duplicate or additional file fields.",
      LIMIT_PART_COUNT: "The biometric form contains too many multipart entries.",
      LIMIT_FIELD_COUNT: "The biometric form contains too many text fields.",
    };
    const biometricFieldDetails = biometricUpload && error.code === "LIMIT_UNEXPECTED_FILE"
      ? {
          expectedFileField: "faceCapture",
          receivedFileField: typeof error.field === "string" ? error.field.slice(0, 80) : null,
          receivedFileFieldLength: typeof error.field === "string" ? error.field.length : null,
        }
      : null;
    return res.status(400).json({
      success: false,
      error: {
        code: biometricUpload
          ? (biometricCodeByMulterCode[error.code] ?? "INVALID_BIOMETRIC_CAPTURE")
          : (error.code === "LIMIT_FILE_SIZE" ? "DOCUMENT_TOO_LARGE" : "INVALID_FILE_UPLOAD"),
        message: biometricUpload
          ? (biometricMessageByMulterCode[error.code] ?? "Biometric capture upload failed validation.")
          : (error.code === "LIMIT_FILE_SIZE"
            ? "Beneficiary documents must not exceed 5 MB."
            : "Beneficiary document upload failed validation."),
        requestId: req.requestId,
        ...(biometricFieldDetails ? { details: biometricFieldDetails } : {}),
      },
    });
  }

  if (
    typeof error.message === "string"
    && (
      error.message.startsWith("Multipart:")
      || error.message === "Unexpected end of form"
    )
  ) {
    const biometricUpload = req.uploadContext === "BIOMETRIC_CAPTURE";
    return res.status(400).json({
      success: false,
      error: {
        code: biometricUpload ? "INVALID_BIOMETRIC_CAPTURE" : "INVALID_FILE_UPLOAD",
        message: biometricUpload
          ? "The multipart biometric capture upload request is malformed."
          : "The multipart file upload request is malformed.",
        requestId: req.requestId,
      },
    });
  }

  if (error.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      error: {
        code: "INVALID_JSON",
        message: "The JSON request body is malformed.",
        requestId: req.requestId,
      },
    });
  }

  if (error.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      error: {
        code: "REQUEST_TOO_LARGE",
        message: "The request body exceeds the allowed size.",
        requestId: req.requestId,
      },
    });
  }

  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const isOperational = error.isOperational ?? statusCode < 500;

  if (!isOperational) {
    console.error({
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      errorName: error.name,
      errorCode: error.code,
      ...(process.env.NODE_ENV !== "production" ? { stack: error.stack } : {}),
    });
  }

  if (error.code === "ACCOUNT_TEMPORARILY_LOCKED" && error.details?.retryAfterSeconds) {
    res.set("Retry-After", String(error.details.retryAfterSeconds));
  }

  return res.status(statusCode).json({
    success: false,
    error: {
      code: error.code ?? (isOperational ? "REQUEST_ERROR" : "INTERNAL_SERVER_ERROR"),
      message: isOperational ? error.message : "An unexpected server error occurred.",
      requestId: req.requestId,
      ...(error.details ? { details: error.details } : {}),
    },
  });
}
