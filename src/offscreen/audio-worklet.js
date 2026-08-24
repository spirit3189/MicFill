class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(4096);
    this.offset = 0;
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') this.flush();
    };
  }

  flush() {
    if (this.offset > 0) {
      const samples = this.chunk.slice(0, this.offset);
      this.port.postMessage({ type: 'chunk', samples }, [samples.buffer]);
      this.offset = 0;
    }
    this.port.postMessage({ type: 'flushed', sampleRate });
  }

  process(inputs, outputs) {
    for (const channel of outputs[0] ?? []) channel.fill(0);
    const input = inputs[0];
    if (!input?.[0]) return true;

    for (let frame = 0; frame < input[0].length; frame += 1) {
      let mono = 0;
      for (const channel of input) mono += channel[frame] ?? 0;
      this.chunk[this.offset] = mono / input.length;
      this.offset += 1;
      if (this.offset === this.chunk.length) {
        const samples = this.chunk;
        this.port.postMessage({ type: 'chunk', samples }, [samples.buffer]);
        this.chunk = new Float32Array(4096);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('smart-dictation-pcm', PcmRecorderProcessor);
