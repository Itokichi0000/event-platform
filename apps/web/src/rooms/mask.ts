/**
 * Deterministic mask avatar and name from a per-event public key, so everyone in the room sees
 * the same mask for a participant without any profile data. Pure functions, no external assets.
 */
const ADJ_JA = [
  'しずかな',
  'まっすぐな',
  'ねむい',
  'ひかる',
  'すばやい',
  'まるい',
  'あおい',
  'あかい',
  'ちいさな',
  'おおきな',
  'やさしい',
  'ふしぎな',
  'かしこい',
  'げんきな',
  'のんびりした',
  'きらきらの',
];
const ANIMAL_JA = [
  'キツネ',
  'タヌキ',
  'フクロウ',
  'カワウソ',
  'ウサギ',
  'ネコ',
  'イヌ',
  'クマ',
  'リス',
  'シカ',
  'ペンギン',
  'カメ',
  'ハリネズミ',
  'ラッコ',
  'オオカミ',
  'モモンガ',
];
const ADJ_EN = [
  'Quiet',
  'Brave',
  'Sleepy',
  'Shiny',
  'Swift',
  'Round',
  'Blue',
  'Red',
  'Tiny',
  'Giant',
  'Gentle',
  'Curious',
  'Clever',
  'Lively',
  'Lazy',
  'Sparkly',
];
const ANIMAL_EN = [
  'Fox',
  'Raccoon',
  'Owl',
  'Otter',
  'Rabbit',
  'Cat',
  'Dog',
  'Bear',
  'Squirrel',
  'Deer',
  'Penguin',
  'Turtle',
  'Hedgehog',
  'Sea Otter',
  'Wolf',
  'Flying Squirrel',
];

/** Byte i of the key (0 if the key is shorter). */
function byteAt(pubkey: string, i: number): number {
  return parseInt(pubkey.slice(i * 2, i * 2 + 2), 16) || 0;
}

function pick(list: readonly string[], n: number): string {
  return list[n % list.length] ?? '';
}

export function maskName(pubkey: string, lang: 'ja' | 'en'): string {
  const adj = pick(lang === 'ja' ? ADJ_JA : ADJ_EN, byteAt(pubkey, 0));
  const animal = pick(lang === 'ja' ? ANIMAL_JA : ANIMAL_EN, byteAt(pubkey, 1));
  const tag = ((byteAt(pubkey, 2) << 8) | byteAt(pubkey, 3)) % 1000;
  return lang === 'ja' ? `${adj}${animal} #${tag}` : `${adj} ${animal} #${tag}`;
}

export interface MaskSpec {
  hue: number;
  accentHue: number;
  shape: number;
  eyes: number;
  pattern: number;
}

export function maskSpec(pubkey: string): MaskSpec {
  return {
    hue: Math.round((byteAt(pubkey, 4) / 255) * 360),
    accentHue: Math.round((byteAt(pubkey, 5) / 255) * 360),
    shape: byteAt(pubkey, 6) % 4,
    eyes: byteAt(pubkey, 7) % 3,
    pattern: byteAt(pubkey, 8) % 3,
  };
}
