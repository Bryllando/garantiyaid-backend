import OpenAI from "openai";
import { env } from "../config/env.js";

export const MISTRAL_MODEL = "mistralai/mistral-large-4-1t-a52b";
export const INTERACTIVE_AI_TIMEOUT_MS = 12_000;

export function createMistralClient({ apiKey = env.nvidiaApiKey, timeoutMs = 90_000 } = {}) {
  return new OpenAI({ apiKey, baseURL: "https://integrate.api.nvidia.com/v1", timeout: timeoutMs, maxRetries: 0 });
}
