import { readFile } from "node:fs/promises";
import { env } from "../src/config/env.js";
import {
  cosineSimilarity,
  processBiometricEnrollment,
} from "../src/modules/biometrics/biometric.service.js";

const [firstCapturePath, secondCapturePath, differentPersonPath, spoofPath] = process.argv.slice(2);

if (![firstCapturePath, secondCapturePath, differentPersonPath, spoofPath].every(Boolean)) {
  throw new Error(
    "Usage: npm run verify:biometric:remote -- <same-person-1> <same-person-2> <different-person> <spoof>",
  );
}
if (env.biometricProcessorMode !== "REMOTE") {
  throw new Error("BIOMETRIC_PROCESSOR_MODE must be REMOTE for this acceptance check.");
}

async function processCapture(path) {
  const buffer = await readFile(path);
  try {
    return await processBiometricEnrollment({ buffer });
  } finally {
    buffer.fill(0);
  }
}

const processed = [];
try {
  for (const path of [firstCapturePath, secondCapturePath, differentPersonPath]) {
    const result = await processCapture(path);
    if (!result.livenessPassed || !result.embedding) {
      throw new Error(`A live acceptance capture failed liveness: ${path}`);
    }
    processed.push(result);
  }

  const samePersonScore = cosineSimilarity(processed[0].embedding, processed[1].embedding);
  const differentPersonScore = cosineSimilarity(processed[0].embedding, processed[2].embedding);
  if (samePersonScore < env.biometricMatchThreshold) {
    throw new Error("The two captures of the same person did not meet the configured match threshold.");
  }
  if (differentPersonScore >= env.biometricMatchThreshold) {
    throw new Error("The different-person capture incorrectly met the configured match threshold.");
  }

  let spoofBlocked = false;
  try {
    const spoof = await processCapture(spoofPath);
    spoofBlocked = !spoof.livenessPassed || !spoof.embedding;
    spoof.embedding?.fill(0);
  } catch (error) {
    if (error.code === "BIOMETRIC_SERVICE_UNAVAILABLE") throw error;
    spoofBlocked = ["BIOMETRIC_CAPTURE_REJECTED", "BIOMETRIC_FACE_COUNT_INVALID"].includes(error.code);
    if (!spoofBlocked) throw error;
  }
  if (!spoofBlocked) throw new Error("The spoof capture was accepted as a live face.");

  console.log(JSON.stringify({
    passed: true,
    processor: processed[0].processor,
    configuredMatchThreshold: env.biometricMatchThreshold,
    checks: {
      samePersonMatched: true,
      differentPersonAllowed: true,
      spoofBlocked: true,
    },
  }, null, 2));
} finally {
  for (const result of processed) result.embedding?.fill(0);
}
