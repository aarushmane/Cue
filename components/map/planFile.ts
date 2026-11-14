"use client";
// Reads an uploaded floor plan into a local object URL and its natural aspect ratio. PDFs: page 1 is rendered
// with pdf.js (loaded at runtime from cdnjs, the same version as the design prototype). Nothing is uploaded:
// POST /api/media is not connected, so the background stays on this device.

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

interface PdfJs {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (o: { data: ArrayBuffer }) => {
    promise: Promise<{
      getPage: (n: number) => Promise<{
        getViewport: (o: { scale: number }) => { width: number; height: number };
        render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
      }>;
    }>;
  };
}

export async function readPlanFile(f: File): Promise<{ url: string; aspect: number; kind: "image" | "pdf" }> {
  const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  if (isPdf) {
    const pdfjs = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ PDFJS)) as PdfJs;
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const doc = await pdfjs.getDocument({ data: await f.arrayBuffer() }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1.5 });
    const c = document.createElement("canvas");
    c.width = vp.width;
    c.height = vp.height;
    await page.render({ canvasContext: c.getContext("2d")!, viewport: vp }).promise;
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("render failed"))), "image/png"));
    return { url: URL.createObjectURL(blob), aspect: vp.width / vp.height, kind: "pdf" };
  }
  const url = URL.createObjectURL(f);
  const aspect = await new Promise<number>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i.naturalWidth / i.naturalHeight);
    i.onerror = rej;
    i.src = url;
  });
  return { url, aspect, kind: "image" };
}

export const isPdfName = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
