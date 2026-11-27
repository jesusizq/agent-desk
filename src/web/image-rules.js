// @ts-check
// The images the store keeps: one module for the store and the page, which the desk also serves.

/** The image types the store keeps as they are, by the extension it stores them under. */
export const IMAGE_TYPES = /** @type {const} */ ({ png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" });
/** @typedef {keyof typeof IMAGE_TYPES} ImageExt */

/** The largest image the store keeps, in MB. */
export const IMAGE_MAX_MB = 20;
export const IMAGE_MAX_BYTES = IMAGE_MAX_MB * 1024 * 1024;
/** The most images one answer or message carries. */
export const ATTACHED_IMAGES_MAX = 10;

/**
 * The type its first bytes say, of those the store keeps (a Node Buffer is a Uint8Array too).
 * @param {Uint8Array} data @returns {ImageExt | undefined}
 */
export function imageType(data) {
  const at = (/** @type {number} */ offset, /** @type {number[]} */ ...bytes) => bytes.every((b, i) => data[offset + i] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp"; // "RIFF", its size, "WEBP"
  return undefined;
}
