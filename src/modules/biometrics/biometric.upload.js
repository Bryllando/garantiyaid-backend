import multer from "multer";
import { extname } from "node:path";

const MAX_BIOMETRIC_CAPTURE_BYTES = 5 * 1024 * 1024;
const acceptedMimeTypes = new Set([
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/jfif",
  "image/png",
  "image/x-png",
  "image/webp",
]);
const acceptedFileExtensions = new Set([".jpg", ".jpeg", ".jfif", ".png", ".webp"]);

const parseBiometricCapture = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BIOMETRIC_CAPTURE_BYTES,
    files: 1,
    fields: 4,
    parts: 5,
  },
  fileFilter(req, file, callback) {
    const declaredMimeType = file.mimetype?.toLowerCase().split(";", 1)[0].trim();
    const fileExtension = extname(file.originalname ?? "").toLowerCase();

    // Some camera, browser, and government-scanner clients label a valid JPEG/JFIF
    // as application/octet-stream. Permit a recognized declaration or extension
    // here, then enforce the actual magic-byte signature in the biometric service.
    if (!acceptedMimeTypes.has(declaredMimeType) && !acceptedFileExtensions.has(fileExtension)) {
      return callback(Object.assign(new Error("Biometric capture must be JPG, JPEG, JFIF, PNG, or WebP."), {
        statusCode: 400,
        code: "INVALID_BIOMETRIC_CAPTURE_TYPE",
        isOperational: true,
      }));
    }
    return callback(null, true);
  },
}).single("faceCapture");

export function uploadBiometricCapture(req, res, next) {
  req.uploadContext = "BIOMETRIC_CAPTURE";
  return parseBiometricCapture(req, res, (error) => {
    if (req.file?.buffer) {
      res.once("finish", () => req.file?.buffer?.fill(0));
    }
    return next(error);
  });
}

export {
  MAX_BIOMETRIC_CAPTURE_BYTES,
  acceptedFileExtensions as ACCEPTED_BIOMETRIC_FILE_EXTENSIONS,
  acceptedMimeTypes as ACCEPTED_BIOMETRIC_MIME_TYPES,
};
