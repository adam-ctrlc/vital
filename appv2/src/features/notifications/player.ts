/**
 * Plays a sound file in the page, standing in for expo-audio's player.
 *
 * Starting can fail: a browser refuses to play audio before the page has had a tap or a
 * key press. That is swallowed here, because a sound that will not play must never take
 * the vibration or the banner down with it. Inside the Capacitor app the WebView does
 * not have that restriction.
 */
export function playSound(src: string, loop = false): HTMLAudioElement | null {
  try {
    const audio = new Audio(src);
    audio.loop = loop;
    void audio.play().catch(() => undefined);
    return audio;
  } catch {
    return null;
  }
}

/**
 * Stops a sound and lets it go.
 *
 * The loop is cleared before pausing, so a looping one cannot restart in the gap, and
 * the source is dropped so the element releases the file rather than holding it.
 */
export function releaseSound(audio: HTMLAudioElement | null) {
  if (!audio) return;

  try {
    audio.loop = false;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch {
    // Already stopped, or gone. Nothing worth reporting.
  }
}
