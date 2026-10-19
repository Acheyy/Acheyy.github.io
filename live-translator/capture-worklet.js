// AudioWorklet: microphone at the context's rate (48 kHz on iPhones, 44.1 kHz on some Macs, 8-24 kHz with a
// Bluetooth headset) -> mono 16 kHz Float32, posted to the main thread in frames of 320 samples (20 ms), the unit
// the VAD works on. Plain JavaScript: Vite copies public/ as is and the worklet scope cannot import modules.
//
// Downsampling: an 8th-order Butterworth low-pass at 0.45 x the target rate (four biquads) against aliasing, then
// linear interpolation at the fractional source positions, so any input rate works, not only multiples of 16 kHz.
// Upsampling (input below 16 kHz) only interpolates.

/** RBJ cookbook low-pass biquad, direct form I. */
function lowpass(cutoff, rate, q) {
  const w0 = (2 * Math.PI * cutoff) / rate
  const alpha = Math.sin(w0) / (2 * q)
  const cos = Math.cos(w0)
  const a0 = 1 + alpha
  const b0 = (1 - cos) / 2 / a0
  const b1 = (1 - cos) / a0
  const a1 = (-2 * cos) / a0
  const a2 = (1 - alpha) / a0
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  return (x) => {
    const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    return y
  }
}

class Capture16k extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const { targetRate = 16000, frameSamples = 320 } = options?.processorOptions ?? {}
    // `sampleRate` is the AudioWorkletGlobalScope's context rate.
    this.step = sampleRate / targetRate
    const cutoff = 0.45 * targetRate
    // Butterworth pole-pair Qs for order 8.
    this.filters = sampleRate > targetRate ? [0.5098, 0.6013, 0.9, 2.5629].map((q) => lowpass(cutoff, sampleRate, q)) : []
    this.frameSamples = frameSamples
    this.frame = new Float32Array(frameSamples)
    this.filled = 0
    // Next output position in input samples, relative to the current block; -1 is the previous block's last sample.
    this.position = 0
    this.previous = 0
    this.block = new Float32Array(128)
  }

  process(inputs) {
    const channels = inputs[0]
    if (!channels || channels.length === 0 || channels[0].length === 0) return true
    const n = channels[0].length
    if (this.block.length < n) this.block = new Float32Array(n)
    const x = this.block
    for (let i = 0; i < n; i++) {
      let s = 0
      for (let c = 0; c < channels.length; c++) s += channels[c][i]
      s /= channels.length
      for (const f of this.filters) s = f(s)
      x[i] = s
    }
    while (this.position <= n - 1) {
      const i = Math.floor(this.position)
      const frac = this.position - i
      const a = i < 0 ? this.previous : x[i]
      // position <= n - 1, so x[i + 1] exists whenever frac > 0.
      const b = frac > 0 ? x[i + 1] : a
      this.push(a + (b - a) * frac)
      this.position += this.step
    }
    this.position -= n
    this.previous = x[n - 1]
    return true
  }

  push(sample) {
    this.frame[this.filled++] = sample
    if (this.filled === this.frameSamples) {
      this.port.postMessage(this.frame, [this.frame.buffer])
      this.frame = new Float32Array(this.frameSamples)
      this.filled = 0
    }
  }
}

registerProcessor('capture-16k', Capture16k)
