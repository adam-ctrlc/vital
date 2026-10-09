import { IS_NATIVE } from '@/lib/platform';

type FileData = { name: string; mimeType: string } & ({ text: string } | { bytes: ArrayBuffer });

function toBase64(bytes: ArrayBuffer) {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * A download in the browser. In the app, where the WebView cannot download, the file is
 * written to the cache and handed to the share sheet, to save to Files or Drive or send.
 */
export async function saveFile(file: FileData): Promise<void> {
  if (!IS_NATIVE) {
    const blob = new Blob(['text' in file ? file.text : file.bytes], { type: file.mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }

  const [{ Directory, Encoding, Filesystem }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
  const written =
    'text' in file
      ? await Filesystem.writeFile({ path: file.name, data: file.text, directory: Directory.Cache, encoding: Encoding.UTF8 })
      : await Filesystem.writeFile({ path: file.name, data: toBase64(file.bytes), directory: Directory.Cache });

  try {
    await Share.share({ title: file.name, files: [written.uri] });
  } catch (caught) {
    // Closing the share sheet without picking anything is not an error.
    if (!/cancel/i.test((caught as Error).message)) throw caught;
  }
}
