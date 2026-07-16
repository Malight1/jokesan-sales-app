import { createWorker } from 'tesseract.js';

// Reads the text out of a pasted/uploaded payment-confirmation screenshot
// (bank app or WhatsApp forward) entirely in the browser — no server call,
// no API key, no account. Runs Tesseract's WASM engine as a Web Worker.
export async function extractTextFromImage(file: File | Blob): Promise<string> {
  const worker = await createWorker('eng');
  try {
    const { data } = await worker.recognize(file);
    return data.text;
  } finally {
    await worker.terminate();
  }
}
