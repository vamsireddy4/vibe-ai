// Twilio sends 8 kHz G.711 mu-law; Muse needs 16 kHz PCM16 little-endian.

function muLawToPcm(byte: number): number {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const magnitude = ((u & 0x0f) << 3) + 0x84;
  const sample = (magnitude << exponent) - 0x84;
  return u & 0x80 ? -sample : sample;
}

/** mu-law 8 kHz -> PCM16 16 kHz (linear interpolation between samples). */
export function mulaw8kToPcm16k(mulaw: Buffer): Buffer {
  const out = Buffer.alloc(mulaw.length * 4);
  for (let i = 0; i < mulaw.length; i++) {
    const a = muLawToPcm(mulaw[i]);
    const b = i + 1 < mulaw.length ? muLawToPcm(mulaw[i + 1]) : a;
    out.writeInt16LE(a, i * 4);
    out.writeInt16LE((a + b) >> 1, i * 4 + 2);
  }
  return out;
}

/** A clip of PCM16 audio placed `at` bytes into the recording. */
export type Clip = { at: number; pcm: Buffer };

/** Mix clips (caller + agent, PCM16 mono) into one track, clipping at the int16 range. */
export function mixPcm16(clips: Clip[]): Buffer {
  const end = clips.reduce((m, c) => Math.max(m, c.at + c.pcm.length), 0) & ~1;
  const out = Buffer.alloc(end);
  for (const { at, pcm } of clips) {
    for (let i = 0; i + 1 < pcm.length && at + i + 1 < end; i += 2) {
      const s = out.readInt16LE(at + i) + pcm.readInt16LE(i);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), at + i);
    }
  }
  return out;
}

/** PCM16 mono -> WAV file bytes. */
export function wav(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
