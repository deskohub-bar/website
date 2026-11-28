import { createHash } from "node:crypto";

/** The sha256 digest of a UTF-8 string, as lowercase hex. @param {string} value */
export const sha256Hex = (value) =>
  createHash("sha256").update(value).digest("hex");
