import { maskSpec } from './mask';

const SHAPES = [
  'M6 26c0-6 6-10 13-10 5 0 9 2 13 6 4-4 8-6 13-6 7 0 13 4 13 10 0 11-7 20-16 20-5 0-8-3-10-7-2 4-5 7-10 7-9 0-16-9-16-20z',
  'M8 20c8-6 40-6 48 0 2 14-6 26-16 26-4 0-6-2-8-5-2 3-4 5-8 5-10 0-18-12-16-26z',
  'M4 30c0-12 12-16 28-16s28 4 28 16c0 8-8 14-16 14-6 0-9-3-12-6-3 3-6 6-12 6-8 0-16-6-16-14z',
  'M10 18l22-4 22 4c4 12 0 26-12 28-5 1-8-2-10-5-2 3-5 6-10 5-12-2-16-16-12-28z',
];

/** Deterministic SVG mask for a per-event public key. */
export function MaskAvatar({ pubkey, size = 36 }: { pubkey: string; size?: number }) {
  const s = maskSpec(pubkey);
  const fill = `oklch(0.72 0.15 ${s.hue})`;
  const accent = `oklch(0.55 0.17 ${s.accentHue})`;
  const eye = (cx: number) =>
    s.eyes === 0 ? (
      <ellipse cx={cx} cy={30} rx={6} ry={4} fill="#09090b" />
    ) : s.eyes === 1 ? (
      <circle cx={cx} cy={30} r={4.5} fill="#09090b" />
    ) : (
      <path
        d={`M${cx - 6} 31q6-6 12 0`}
        stroke="#09090b"
        strokeWidth={3}
        fill="none"
        strokeLinecap="round"
      />
    );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden
      className="shrink-0 rounded-full bg-muted"
    >
      <path d={SHAPES[s.shape]} fill={fill} />
      {s.pattern === 1 && (
        <path d="M14 22h36" stroke={accent} strokeWidth={3} strokeLinecap="round" />
      )}
      {s.pattern === 2 && <circle cx={32} cy={22} r={3} fill={accent} />}
      {eye(21)}
      {eye(43)}
    </svg>
  );
}
