/**
 * Downscales an image to Claude's high-resolution ceiling before upload.
 *
 * Anything above 2576px on the long edge is discarded by the model, so sending
 * it costs bandwidth and image tokens for nothing. Doing this in a canvas
 * rather than with `sharp` on the server means no dependency, no cold-start
 * weight, and a smaller upload.
 *
 * Returns the original file unchanged if it is already small enough or if
 * anything goes wrong — a failed optimisation must never fail the upload.
 */

const MAX_EDGE = 2576;
const JPEG_QUALITY = 0.92;

export async function resizeImageIfNeeded(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= MAX_EDGE) {
      bitmap.close();
      return file;
    }

    const scale = MAX_EDGE / longest;
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return file;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!blob) return file;

    const renamed = file.name.replace(/\.(png|jpe?g|webp)$/i, "") + ".jpg";
    return new File([blob], renamed, { type: "image/jpeg" });
  } catch {
    return file;
  }
}
