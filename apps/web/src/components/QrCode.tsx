import QRCode from 'qrcode';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/** Renders text as a QR code on a canvas (always dark-on-white for scanners). */
export function QrCode({
  text,
  className,
  size = 320,
  label,
}: {
  text: string;
  className?: string;
  size?: number;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    void QRCode.toCanvas(ref.current, text, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: size,
      color: { dark: '#000000', light: '#ffffff' },
    });
  }, [text, size]);
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label}
      data-qr-text={text}
      className={cn('h-auto w-full max-w-[22rem] rounded-xl bg-white', className)}
    />
  );
}

/** PNG of the QR with a caption, for "save as image". */
export async function qrPng(text: string, caption: string): Promise<Blob> {
  const qr = document.createElement('canvas');
  await QRCode.toCanvas(qr, text, { errorCorrectionLevel: 'M', margin: 2, width: 720 });
  const out = document.createElement('canvas');
  out.width = 720;
  out.height = 720 + 96;
  const g = out.getContext('2d');
  if (!g) throw new Error('canvas unsupported');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(qr, 0, 0);
  g.fillStyle = '#111111';
  g.font = '600 32px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(caption.slice(0, 32), 360, 720 + 56, 680);
  return new Promise((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'),
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
