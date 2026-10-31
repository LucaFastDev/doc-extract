// pdf.js's worker module ships no types. Importing it sets globalThis.pdfjsWorker, which pdf.js
// then runs on the main thread (src/app/(app)/documents/[id]/document-viewer.tsx).
declare module 'pdfjs-dist/build/pdf.worker.min.mjs'
