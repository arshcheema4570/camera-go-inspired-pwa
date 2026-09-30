self.onmessage = (event) => {
  const { id, frames, mode } = event.data;
  const started = performance.now();
  try {
    const base = frames[0];
    const { width, height } = base;
    const output = new Uint8ClampedArray(base.data);
    const threshold = mode === "night" ? 42 : 30;
    for (let index = 0; index < output.length; index += 4) {
      let red = 0, green = 0, blue = 0, samples = 0;
      for (const frame of frames) {
        const difference = Math.abs(frame.data[index] - base.data[index]) + Math.abs(frame.data[index + 1] - base.data[index + 1]) + Math.abs(frame.data[index + 2] - base.data[index + 2]);
        if (difference < threshold) { red += frame.data[index]; green += frame.data[index + 1]; blue += frame.data[index + 2]; samples += 1; }
      }
      if (samples) { output[index] = red / samples; output[index + 1] = green / samples; output[index + 2] = blue / samples; }
    }
    const stride = width * 4;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * stride + x * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          const neighbor = (output[index - 4 + channel] + output[index + 4 + channel] + output[index - stride + channel] + output[index + stride + channel]) / 4;
          const sharpened = output[index + channel] + (output[index + channel] - neighbor) * 0.3;
          const contrasted = Math.max(0, (sharpened - 128) * 1.06 + 128) / 255;
          // Keep this curve numerically aligned with the live WebGL viewfinder.
          output[index + channel] = Math.max(0, Math.min(255, Math.pow(contrasted, 1.08) * 0.97 * 255));
        }
      }
    }
    self.postMessage({ id, width, height, data: output, elapsedMs: Math.round(performance.now() - started) }, [output.buffer]);
  } catch (error) { self.postMessage({ id, error: error.message || "Worker processing failed" }); }
};
