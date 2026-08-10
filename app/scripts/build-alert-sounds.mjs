import fs from 'node:fs';
import path from 'node:path';

/**
 * Synthesises the notification sounds that ship inside the app.
 *
 * Written by hand rather than pulled from a library: a WAV is a small header followed
 * by raw samples, so generating one needs no dependency, and a build-time script that
 * adds none is worth more than the few lines it costs.
 *
 * Regenerate with: node scripts/build-alert-sounds.mjs
 */

/**
 * 22.05 kHz rather than 44.1.
 *
 * These are synthesised tones, and the highest partial any of them carries is under
 * 5 kHz, so half the rate loses nothing audible and halves thirty files. That matters
 * once each one is sustained rather than a fraction of a second long.
 */
const RATE = 22050;

/**
 * How long each tone runs, in seconds.
 *
 * Not a fraction of a second, because with the app closed Android plays the channel's
 * sound exactly once and will not loop it: whatever is in the file is the entire alarm.
 * A quarter second reads as a notification ping; this reads as something wanting
 * attention. The motif repeats to fill it rather than being stretched.
 */
const SUSTAIN_SECONDS = 12;
const OUT = path.resolve('assets/sounds');

/** Wraps 16-bit mono PCM in a RIFF/WAVE container. */
function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    // Clamped before scaling, because a sum of tones can exceed full scale and would
    // otherwise wrap around into a loud crackle.
    const clamped = Math.max(-1, Math.min(1, sample));
    data.writeInt16LE(Math.round(clamped * 32767), index * 2);
  });

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels: mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

/**
 * One tone, with a short fade at each end.
 *
 * The fade is not decoration: cutting a waveform mid-cycle leaves a step, and a step
 * is a click. At these levels the click is louder than the tone.
 */
function tone(freq, seconds, { gain = 0.6, harmonic = 0 } = {}) {
  const total = Math.round(RATE * seconds);
  const fade = Math.min(Math.round(RATE * 0.006), Math.floor(total / 2));

  return Array.from({ length: total }, (_, i) => {
    const t = i / RATE;
    // A touch of the octave gives the tone an edge that carries through a pocket
    // better than a pure sine, which reads as soft.
    const wave =
      Math.sin(2 * Math.PI * freq * t) + harmonic * Math.sin(4 * Math.PI * freq * t);

    let envelope = 1;
    if (i < fade) envelope = i / fade;
    else if (i > total - fade) envelope = (total - i) / fade;

    return wave * gain * envelope;
  });
}

/**
 * A struck tone that rings out, rather than one held at full volume.
 *
 * `partials` are multiples of the base frequency. Whole multiples sound like a pipe;
 * the deliberately uneven ones below are what make a bell sound like metal.
 */
function struck(freq, seconds, { gain = 0.6, partials = [1], decay = 6 } = {}) {
  const total = Math.round(RATE * seconds);
  const attack = Math.round(RATE * 0.003);
  const weight = partials.reduce((sum, p) => sum + 1 / p, 0);

  return Array.from({ length: total }, (_, i) => {
    const t = i / RATE;
    // Higher partials fade first, the way a real struck object loses its brightness
    // before it loses its pitch.
    const wave = partials.reduce(
      (sum, p) => sum + (Math.sin(2 * Math.PI * freq * p * t) * Math.exp(-decay * p * t)) / p,
      0
    );

    const envelope = i < attack ? i / attack : 1;

    return (wave / weight) * gain * envelope;
  });
}

/** A square wave, softened at the edges. Harsh in the way a horn is harsh. */
function square(freq, seconds, { gain = 0.45 } = {}) {
  const total = Math.round(RATE * seconds);
  const fade = Math.min(Math.round(RATE * 0.006), Math.floor(total / 2));

  return Array.from({ length: total }, (_, i) => {
    const t = i / RATE;
    // Summed odd harmonics rather than a hard sign(), which would alias badly at these
    // frequencies and add a gritty hiss on top of the tone.
    const wave =
      [1, 3, 5, 7, 9].reduce((sum, h) => sum + Math.sin(2 * Math.PI * freq * h * t) / h, 0) /
      1.63;

    let envelope = 1;
    if (i < fade) envelope = i / fade;
    else if (i > total - fade) envelope = (total - i) / fade;

    return wave * gain * envelope;
  });
}

/** One tone whose pitch wobbles between two values. Reads as an urgent warble. */
function warble(low, high, rate, seconds, { gain = 0.6 } = {}) {
  const total = Math.round(RATE * seconds);
  const fade = Math.round(RATE * 0.006);
  const center = (low + high) / 2;
  const depth = (high - low) / 2;
  let phase = 0;

  return Array.from({ length: total }, (_, i) => {
    const t = i / RATE;
    phase += (2 * Math.PI * (center + depth * Math.sin(2 * Math.PI * rate * t))) / RATE;

    let envelope = 1;
    if (i < fade) envelope = i / fade;
    else if (i > total - fade) envelope = (total - i) / fade;

    return Math.sin(phase) * gain * envelope;
  });
}

/** A frequency ramp, for the rising siren. */
function sweep(from, to, seconds, { gain = 0.6 } = {}) {
  const total = Math.round(RATE * seconds);
  const fade = Math.round(RATE * 0.006);
  let phase = 0;

  return Array.from({ length: total }, (_, i) => {
    const progress = i / total;
    const freq = from + (to - from) * progress;
    phase += (2 * Math.PI * freq) / RATE;

    let envelope = 1;
    if (i < fade) envelope = i / fade;
    else if (i > total - fade) envelope = (total - i) / fade;

    return Math.sin(phase) * gain * envelope;
  });
}

/**
 * Deterministic pseudo-random numbers in -1 to 1.
 *
 * Seeded rather than `Math.random`, so regenerating produces byte-identical files. A
 * noise burst that differs every run would show up as a changed asset in every commit.
 */
function rng(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;

    return (state / 0x100000000) * 2 - 1;
  };
}

/**
 * Filtered noise, for the sounds that want texture rather than pitch.
 *
 * The one-pole smoothing is what stops it being thin hiss: raw white noise sits mostly
 * where a phone speaker is weakest, so it needs a body before it carries.
 */
function noise(seconds, { gain = 0.5, smoothing = 0.55, seed = 1 } = {}) {
  const total = Math.round(RATE * seconds);
  const fade = Math.min(Math.round(RATE * 0.004), Math.floor(total / 2));
  const next = rng(seed);
  let last = 0;

  return Array.from({ length: total }, (_, i) => {
    last = last * smoothing + next() * (1 - smoothing);

    let envelope = 1;
    if (i < fade) envelope = i / fade;
    else if (i > total - fade) envelope = (total - i) / fade;

    return last * gain * envelope;
  });
}

/** Several tones held together. Close intervals beat against each other. */
function chord(freqs, seconds, { gain = 0.55 } = {}) {
  const parts = freqs.map((freq) => tone(freq, seconds, { gain: gain / freqs.length }));

  return parts[0].map((_, i) => parts.reduce((sum, part) => sum + part[i], 0));
}

const silence = (seconds) => new Array(Math.round(RATE * seconds)).fill(0);

/**
 * Flattens all the way down, not one level.
 *
 * A single-level flatten silently produces a file of a few dozen bytes when a sound is
 * built from nested groups, and the only symptom is silence on the device.
 */
const join = (...parts) => parts.flat(Infinity);

// Deliberately high and narrow. A transformer alarm competes with a room, not a quiet
// desk, and the frequencies that cut through are the ones a phone speaker can actually
// produce loudly: roughly 1 to 3 kHz.
const SOUNDS = {
  // Two quick rising notes. Reads as "look at me" without being alarming.
  chirp: join(
    tone(1200, 0.09, { harmonic: 0.3 }),
    silence(0.04),
    tone(1800, 0.12, { harmonic: 0.3 })
  ),

  // Alternating two-tone, the shape of an emergency vehicle. Unmistakably an alarm.
  alarm: join(
    ...[0, 1, 2].flatMap(() => [
      tone(1046, 0.18, { harmonic: 0.35 }),
      tone(1568, 0.18, { harmonic: 0.35 }),
    ])
  ),

  // Three flat beeps. The plainest possible "something happened".
  beep: join(
    tone(2000, 0.08),
    silence(0.07),
    tone(2000, 0.08),
    silence(0.07),
    tone(2000, 0.08)
  ),

  // A rising sweep, twice. Feels urgent because the pitch never settles.
  sweep: join(sweep(800, 2400, 0.32), silence(0.06), sweep(800, 2400, 0.32)),

  // Fast even pulses at one pitch. The most insistent of the five.
  pulse: join(
    ...Array.from({ length: 6 }, () => [tone(1600, 0.06, { harmonic: 0.4 }), silence(0.06)])
  ),

  // A slow wail up and back down, twice. The classic air-raid shape.
  siren: join(sweep(600, 1800, 0.55), sweep(1800, 600, 0.55)),

  // A pitch that will not sit still. Hard to tune out.
  warble: warble(1100, 1700, 11, 1.1),

  // One clean note that rings out. The gentlest of the set.
  ping: struck(1760, 0.85, { partials: [1, 2, 3], decay: 4 }),

  // Three ascending notes, the shape of a public-address chime before an announcement.
  tritone: join(
    struck(1046, 0.28, { partials: [1, 2], decay: 7 }),
    struck(1318, 0.28, { partials: [1, 2], decay: 7 }),
    struck(1568, 0.5, { partials: [1, 2], decay: 5 })
  ),

  // The same shape falling instead of rising. Reads as something going wrong.
  descend: join(
    struck(1568, 0.26, { partials: [1, 2], decay: 7 }),
    struck(1244, 0.26, { partials: [1, 2], decay: 7 }),
    struck(932, 0.55, { partials: [1, 2], decay: 4 })
  ),

  // A blunt two-note horn. The harshest of the set, and the hardest to ignore.
  klaxon: join(
    square(520, 0.26, { gain: 0.95 }),
    silence(0.05),
    square(390, 0.34, { gain: 0.95 }),
    silence(0.08),
    square(520, 0.26, { gain: 0.95 }),
    silence(0.05),
    square(390, 0.34, { gain: 0.95 })
  ),

  // Quick alternation between two close notes. Birdlike rather than mechanical.
  trill: join(
    ...Array.from({ length: 5 }, () => [tone(2093, 0.05), tone(2349, 0.05)]),
    silence(0.08),
    tone(2093, 0.14)
  ),

  // Very short ticks in a tight burst. Sounds like a machine, not a phone.
  strobe: join(
    ...Array.from({ length: 10 }, () => [tone(2400, 0.02, { harmonic: 0.5 }), silence(0.045)])
  ),

  // A struck bell, left to ring. Inharmonic partials are what stop it sounding
  // like a flute.
  bell: struck(880, 1.6, { partials: [1, 2.76, 5.4, 8.93], decay: 2.2, gain: 0.7 }),

  // Rises and then holds, so the tension never resolves. Good for a sustained fault.
  surge: join(sweep(700, 1900, 0.45), tone(1900, 0.5, { harmonic: 0.35 })),

  // One very short tick. The smallest sound here that is still audible.
  blip: tone(2600, 0.035, { harmonic: 0.4 }),

  // Two soft high clicks, the way a wall clock marks a second.
  tick: join(
    ...Array.from({ length: 6 }, () => [tone(3000, 0.014), silence(0.19)])
  ),

  // Descending pair, the shape of a doorbell.
  chime: join(
    struck(1318, 0.35, { partials: [1, 2.4], decay: 5 }),
    struck(1046, 0.75, { partials: [1, 2.4], decay: 3.5 })
  ),

  // Very high and brittle. Cuts through noise without being loud.
  glass: struck(2637, 0.7, { partials: [1, 2.4, 4.1], decay: 5, gain: 0.65 }),

  // A ping and its fading returns, like something answering from a distance.
  echo: join(
    struck(1760, 0.3, { decay: 8 }),
    silence(0.1),
    struck(1760, 0.3, { decay: 8, gain: 0.32 }),
    silence(0.12),
    struck(1760, 0.4, { decay: 8, gain: 0.16 })
  ),

  // A slow sonar sweep with the long gap that makes it read as searching.
  radar: join(
    struck(1200, 0.45, { partials: [1, 3], decay: 5 }),
    silence(0.35),
    struck(1200, 0.45, { partials: [1, 3], decay: 5 })
  ),

  // Four ascending steps. Feels like something climbing towards a limit.
  ladder: join(
    tone(880, 0.11, { harmonic: 0.3 }),
    tone(1108, 0.11, { harmonic: 0.3 }),
    tone(1318, 0.11, { harmonic: 0.3 }),
    tone(1568, 0.28, { harmonic: 0.3 })
  ),

  // The reverse of a sweep. Falling pitch reads as something dropping out.
  dive: join(sweep(2200, 600, 0.4), silence(0.06), sweep(2200, 600, 0.4)),

  // Alternating low and high at a walking pace. Steady rather than panicked.
  march: join(
    ...[0, 1, 2].flatMap(() => [
      tone(700, 0.14, { harmonic: 0.3 }),
      tone(1050, 0.14, { harmonic: 0.3 }),
    ])
  ),

  // Rising whoops in quick succession. Reads as approaching.
  whoop: join(
    sweep(500, 1600, 0.22),
    silence(0.04),
    sweep(500, 1600, 0.22),
    silence(0.04),
    sweep(500, 1600, 0.22)
  ),

  // A harsh low square, the sound of an answer being rejected.
  buzzer: join(square(180, 0.3, { gain: 0.95 }), silence(0.08), square(180, 0.45, { gain: 0.95 })),

  // Two tones a few hertz apart, beating against each other into a wobble.
  drone: chord([880, 887], 1.3),

  // Short bursts of noise. Texture rather than pitch, so it stands apart from the rest.
  spark: join(
    noise(0.05, { seed: 7 }),
    silence(0.06),
    noise(0.04, { seed: 19 }),
    silence(0.05),
    noise(0.07, { seed: 31 })
  ),

  // Quick uneven tones, like something talking fast.
  chatter: join(
    ...[1900, 2300, 1700, 2500, 2000, 2400].map((freq) => [tone(freq, 0.045), silence(0.03)])
  ),

  // A low double thud with the uneven gap of a real pulse.
  heartbeat: join(
    struck(180, 0.16, { partials: [1, 2], decay: 14, gain: 0.9 }),
    silence(0.09),
    struck(150, 0.22, { partials: [1, 2], decay: 12, gain: 0.75 }),
    silence(0.3),
    struck(180, 0.16, { partials: [1, 2], decay: 14, gain: 0.9 }),
    silence(0.09),
    struck(150, 0.22, { partials: [1, 2], decay: 12, gain: 0.75 })
  ),
};

/**
 * Repeats a motif, with a breath between passes, until it fills the sustain.
 *
 * The gap is what keeps it from turning into a drone: an alarm is recognisable by its
 * rhythm, and a motif butted straight against itself loses the shape it was written
 * with.
 */
function sustain(motif, seconds = SUSTAIN_SECONDS) {
  const total = Math.round(RATE * seconds);
  const gap = silence(motif.length / RATE > 1 ? 0.45 : 0.3);
  const out = [];

  while (out.length < total) {
    out.push(...motif);
    if (out.length < total) out.push(...gap);
  }

  // Trimmed to length, then faded out so the cut is not a click.
  out.length = total;
  const fade = Math.round(RATE * 0.05);
  for (let i = 0; i < fade; i += 1) {
    out[total - 1 - i] *= i / fade;
  }

  return out;
}

fs.mkdirSync(OUT, { recursive: true });

for (const [name, motif] of Object.entries(SOUNDS)) {
  const file = path.join(OUT, `${name}.wav`);
  const samples = sustain(motif);
  const buffer = wav(samples);
  fs.writeFileSync(file, buffer);
  console.log(
    `${name}.wav`.padEnd(12),
    `${(samples.length / RATE).toFixed(2)}s`.padEnd(7),
    `${Math.round(buffer.length / 1024)} KB`
  );
}

console.log(`\nWrote ${Object.keys(SOUNDS).length} sounds to assets/sounds/`);
