/* Compose a QR code PNG with the item's name drawn in a header band on top, so
   a copied/downloaded/exported QR always identifies itself. Shared by the QR
   panel (QrPanel) and the batch QR export modal. */

const HEADER_MIN = 36;
const HEADER_FACTOR = 0.12;
const HORIZONTAL_PADDING = 16;

function headerHeightFor(size: number): number {
  return Math.max(HEADER_MIN, Math.round(size * HEADER_FACTOR));
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

function drawNamedQr(ctx: CanvasRenderingContext2D, img: HTMLImageElement, size: number, name: string): void {
  const header = name ? headerHeightFor(size) : 0;
  const width = size;
  const height = size + header;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  if (name) {
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(header * 0.5)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    const maxWidth = width - HORIZONTAL_PADDING;
    ctx.fillText(fitText(ctx, name, maxWidth), width / 2, header / 2, maxWidth);
  }
  ctx.drawImage(img, 0, header, size, size);
}

function loadSvgImage(svgEl: SVGSVGElement): Promise<HTMLImageElement | null> {
  const svgData = new XMLSerializer().serializeToString(svgEl);
  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  return new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

export function qrPngBlob(svgEl: SVGSVGElement | null, name: string, size: number): Promise<Blob | null> {
  if (!svgEl) return Promise.resolve(null);
  return (async () => {
    const img = await loadSvgImage(svgEl);
    if (!img) return null;
    const canvas = document.createElement('canvas');
    const header = name ? headerHeightFor(size) : 0;
    canvas.width = size;
    canvas.height = size + header;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    drawNamedQr(ctx, img, size, name);
    return new Promise<Blob | null>((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
  })();
}

export function qrPngDataUrl(svgEl: SVGSVGElement | null, name: string, size: number): Promise<string> {
  if (!svgEl) return Promise.resolve('');
  return (async () => {
    const img = await loadSvgImage(svgEl);
    if (!img) return '';
    const canvas = document.createElement('canvas');
    const header = name ? headerHeightFor(size) : 0;
    canvas.width = size;
    canvas.height = size + header;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    drawNamedQr(ctx, img, size, name);
    return canvas.toDataURL('image/png');
  })();
}
