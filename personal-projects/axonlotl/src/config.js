import dotenv from "dotenv";

dotenv.config();

/**
 * Gemini API key (managed agents / GoogleGenAI client).
 * @type {string}
 */
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "placeholder_replace_me";

/**
 * Default HTTP port for the Axonlotl server.
 * @type {number}
 */
export const PORT = Number(process.env.PORT ?? 3000);

/**
 * Bind host for the HTTP server (avoid 0.0.0.0 in restricted environments).
 * @type {string}
 */
export const HOST = process.env.HOST ?? "127.0.0.1";

/**
 * Environment name.
 * @type {string}
 */
export const NODE_ENV = process.env.NODE_ENV ?? "development";
