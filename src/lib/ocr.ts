
// Reads the text out of a pasted/uploaded payment-confirmation screenshot
// (bank app or WhatsApp forward) entirely in the browser — no server call,
// no API key, no account. Runs Tesseract's WASM engine as a Web Worker.
export async function extractTextFromImage(file: File | Blob): Promise<string> {
  // Tesseract's WASM bundle is the single heaviest dependency in the app and
  // is only needed on this one screen — load it when the user actually
  // uploads a screenshot, not on every page view.
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng');
  try {
    const { data } = await worker.recognize(file);
    return data.text;
  } finally {
    await worker.terminate();
  }
}
