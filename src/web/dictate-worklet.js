// @ts-check
// The microphone's samples, as they come, handed to the page in blocks (dictate.js makes the WAV there).
// Loaded as a file of the desk: the page's policy (script-src 'self') loads no worklet from a blob.

/** @typedef {{ port: MessagePort }} Processor */
const scope = /** @type {{ AudioWorkletProcessor: new () => Processor, registerProcessor: (name: string, processor: new () => Processor & { process: (inputs: Float32Array[][]) => boolean }) => void }} */ (
  /** @type {unknown} */ (globalThis)
);
/** About 85 ms at 48 kHz: few messages, and a level that moves smoothly. */
const BLOCK = 4096;

class Capture extends scope.AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
    // At the stop: the block begun goes too, then "flushed", after every block posted before it.
    this.port.onmessage = (/** @type {MessageEvent} */ e) => {
      if (e.data !== "flush") return;
      this.port.postMessage(this.block.slice(0, this.filled));
      this.filled = 0;
      this.port.postMessage("flushed");
    };
  }
  /** @param {Float32Array[][]} inputs */
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (let i = 0; i < samples.length; ) {
      const n = Math.min(samples.length - i, BLOCK - this.filled);
      this.block.set(samples.subarray(i, i + n), this.filled);
      this.filled += n;
      i += n;
      if (this.filled === BLOCK) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}
scope.registerProcessor("agent-desk-capture", Capture);
