// @ts-check
// An image a reply box is given, made into one the store keeps: checked, or converted when the store does not keep its type.
import { TEXT } from "./text.js";
import { IMAGE_MAX_BYTES, IMAGE_MAX_MB, IMAGE_TYPES, imageType } from "./image-rules.js";

/** The types the store keeps as they are; a reply box converts any other image to one of them. @type {string[]} */
export const KEPT_TYPES = Object.values(IMAGE_TYPES);
/** The type the first bytes say, of those the store keeps. @param {Uint8Array} bytes */
const sniffedType = (bytes) => {
  const ext = imageType(bytes);
  return ext && IMAGE_TYPES[ext];
};
// Past this a converted image goes as a JPEG: a phone's screenshot (1179×2556) is a PNG of about 2 MB, a photo's PNG 15 MB or more.
const PNG_MAX_BYTES = 4 * 1024 * 1024;
// iOS Safari draws nothing on a canvas of more than 4096×4096 pixels in area (a 24 MP photo is larger).
const CANVAS_AREA_MAX = 4096 * 4096;
/** The conversion the next one waits for: each holds a decoded image and its canvas, up to 64 MB apiece, which iOS Safari cannot hold for many at once. @type {Promise<void>} */
let converting = Promise.resolve();

/**
 * An image as the store keeps it. One whose label or bytes say it is a PNG, JPEG, WebP or GIF goes untouched, under the type
 * its bytes say (the server takes only an image/* Content-Type); one of another type (an iPhone's HEIC) is converted.
 * @param {File} file @returns {Promise<Blob>}
 */
export async function storable(file) {
  const type = KEPT_TYPES.includes(file.type) ? file.type : sniffedType(await head(file));
  if (type) {
    if (file.size > IMAGE_MAX_BYTES) throw new Error(TEXT.tooLargeImage(file.name, IMAGE_MAX_MB));
    return type === file.type ? file : file.slice(0, file.size, type);
  }
  const turn = converting.then(() => converted(file));
  // The chain only keeps the order: each conversion's error reaches its own upload through `turn`.
  converting = turn.then(() => {}).catch(() => {});
  const blob = await turn;
  if (blob.size > IMAGE_MAX_BYTES) throw new Error(TEXT.tooLargeConverted(file.name, IMAGE_MAX_MB));
  return blob;
}

/** A file's first 12 bytes, enough to tell an image's type. @param {File} file */
async function head(file) {
  try {
    return new Uint8Array(await file.slice(0, 12).arrayBuffer());
  } catch (error) {
    throw new Error(TEXT.fileNotRead(file.name, error instanceof Error ? error.message : String(error)), { cause: error });
  }
}

/**
 * An image of a type the store does not keep, decoded by the browser and drawn anew: as a PNG, which keeps a screenshot's
 * text sharp, or as a JPEG at 0.9 when that PNG passes PNG_MAX_BYTES (a photo). Always PNG first: the pixel count alone
 * cannot tell a 5K screenshot (15 MP) from a 12 MP photo.
 * @param {File} file @returns {Promise<Blob>}
 */
async function converted(file) {
  const image = await decoded(file);
  const canvas = document.createElement("canvas");
  try {
    const [width, height] = image instanceof ImageBitmap ? [image.width, image.height] : [image.naturalWidth, image.naturalHeight];
    // An image with no size of its own (an SVG without width and height) would come out as one blank pixel.
    if (width === 0 || height === 0) throw new Error(TEXT.unreadableImage(file.name, file.type));
    const scale = Math.min(1, Math.sqrt(CANVAS_AREA_MAX / (width * height)));
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error(TEXT.unconvertedImage(file.name, "image/png"));
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await encoded(canvas, file.name, "image/png");
    if (png.size <= PNG_MAX_BYTES) return png;
    // A JPEG has no transparency: what was transparent would come out black, so it goes over white.
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return await encoded(canvas, file.name, "image/jpeg", 0.9);
  } finally {
    if (image instanceof ImageBitmap) image.close();
    else image.removeAttribute("src"); // an <img> holds its decoded pixels while it has a source
    // Safari holds a canvas's pixels against a page-wide budget until it is shrunk.
    canvas.width = canvas.height = 0;
  }
}

/** An image file decoded by this browser; fails naming the file when it cannot read its type. @param {File} file */
async function decoded(file) {
  try {
    return await createImageBitmap(file);
  } catch (bitmapError) {
    // The <img> below reads the file whole into a string: one larger than the store keeps is not read at all, so its type is
    // one this browser cannot read (a smaller file of it would not help).
    if (file.size > IMAGE_MAX_BYTES) throw new Error(TEXT.unreadableImage(file.name, file.type), { cause: bitmapError });
    // A browser may decode in an <img> a type createImageBitmap refuses; the page's CSP lets images come from data:, not blob:.
    const img = new Image();
    try {
      img.src = await new Promise((done, fail) => {
        const reader = new FileReader();
        reader.onload = () => done(String(reader.result));
        reader.onerror = () => fail(reader.error);
        reader.readAsDataURL(file);
      });
      await img.decode();
    } catch (imgError) {
      img.removeAttribute("src");
      throw new Error(TEXT.unreadableImage(file.name, file.type), { cause: new AggregateError([bitmapError, imgError]) });
    }
    return img;
  }
}

/** A canvas encoded as `type`. @param {HTMLCanvasElement} canvas @param {string} name the file drawn on it @param {string} type @param {number} [quality] */
const encoded = (canvas, name, type, quality) =>
  new Promise((/** @type {(blob: Blob) => void} */ done, fail) => {
    const failed = (/** @type {unknown} */ cause) => fail(new Error(TEXT.unconvertedImage(name, type), { cause }));
    try {
      canvas.toBlob((blob) => (blob ? done(blob) : failed(new Error(`toBlob gave no ${type}`))), type, quality);
    } catch (error) {
      failed(error); // a canvas an image tainted refuses to be read (SecurityError)
    }
  });
/** Whether a file a box is given may be an image: a browser labels some images "" (no type), and the bytes then tell. @param {string} type */
export const mayBeImage = (type) => type === "" || type.startsWith("image/");
