import OpenAI from "openai";
import { env } from "../config/env.js";

export const MISTRAL_MODEL = "mistral-large-4-0";
export const INTERACTIVE_AI_TIMEOUT_MS = 12_000;

export function createMistralClient({ apiKey = env.mistralApiKey, timeoutMs = 90_000 } = {}) {
  return new OpenAI({ apiKey, baseURL: "https://api.mistral.ai/openai/v1", timeout: timeoutMs, maxRetries: 0 });
}
