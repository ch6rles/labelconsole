// The pdf.js worker, bundled by the app so PDFs parse off the main thread.
// Loaded in a Worker, the module connects itself to the page that started it.
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
