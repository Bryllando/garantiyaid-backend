import OpenAI from "openai";
import { env } from "../config/env.js";

export const NVIDIA_MODEL = "mistralai/mistral-large-4-1t-a52b";

export function createNvidiaClient({ apiKey = env.nvidiaApiKey, timeoutMs = 90_000 } = {}) {
  return new OpenAI({ apiKey, baseURL: "https://integrate.api.nvidia.com/v1", timeout: timeoutMs, maxRetries: 0 });
}
