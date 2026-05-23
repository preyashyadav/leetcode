import { GoogleGenAI } from "@google/genai";
import { GEMINI_API_KEY } from "./config.js";

/**
 * Create a GoogleGenAI client instance.
 * (Stub: no calls are made here; callers own usage and retries.)
 * @returns {GoogleGenAI}
 */
export function createGeminiClient() {
  return new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}
