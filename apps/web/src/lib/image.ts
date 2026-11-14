/** Downscale a cover image in the browser so the upload stays under the server limit (512 KB). */
export async function prepareCover(file: File, maxBytes = 500 * 1024): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  let width = Math.min(1600, bitmap.width);
  for (let attempt = 0; attempt < 6; attempt++) {
    const height = Math.round((bitmap.height / bitmap.width) * width);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('canvas unsupported');
    g.drawImage(bitmap, 0, 0, width, height);
    for (const quality of [0.85, 0.75, 0.65]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', quality));
      const out =
        blob && blob.type === 'image/webp'
          ? blob
          : await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
      if (out && out.size <= maxBytes) return out;
    }
    width = Math.round(width * 0.75);
  }
  throw new Error('image_too_large');
}

/** Deterministic gradient for events without a cover (no external images). */
export function gradientFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = h % 360;
  const b = (a + 40 + ((h >> 9) % 80)) % 360;
  return `radial-gradient(120% 120% at 0% 0%, oklch(0.55 0.17 ${a}) 0%, transparent 60%), radial-gradient(120% 120% at 100% 100%, oklch(0.5 0.18 ${b}) 0%, transparent 55%), oklch(0.22 0.03 ${a})`;
}
