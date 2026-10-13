const SIZE = 256;
// Matches the server's limit on the decoded image.
const MAX_BYTES = 100 * 1024;

function decodedBytes(dataUrl: string): number {
  return Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);
}

/**
 * Crops a photo to a centred square, scales it to 256 px and encodes it as WebP (JPEG where
 * WebP is not supported), lowering the quality until it fits. Usually 10 to 20 KB.
 */
export async function compressAvatar(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('That file is not a photo this device can read.');
  }

  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare the photo.');

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, SIZE, SIZE);
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bitmap.close();

  for (const quality of [0.82, 0.7, 0.55, 0.4]) {
    let url = canvas.toDataURL('image/webp', quality);
    if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', quality);
    if (decodedBytes(url) <= MAX_BYTES) return url;
  }
  throw new Error('This photo could not be made small enough. Try another one.');
}
