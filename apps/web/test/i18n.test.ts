import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ja } from '../src/i18n/ja';

/** Every key path with the kind of value (string / function arity / array length). */
function shape(v: unknown, path = ''): string[] {
  if (typeof v === 'string') return [`${path}:string`];
  if (typeof v === 'function') return [`${path}:fn${v.length}`];
  if (Array.isArray(v))
    return [`${path}:array${v.length}`, ...v.flatMap((x, i) => shape(x, `${path}[${i}]`))];
  return Object.entries(v as object).flatMap(([k, x]) => shape(x, path ? `${path}.${k}` : k));
}

describe('dictionaries', () => {
  it('English and Japanese have exactly the same keys', () => {
    expect(shape(en).sort()).toEqual(shape(ja).sort());
  });

  it('no empty strings', () => {
    const strings = (v: unknown): string[] =>
      typeof v === 'string'
        ? [v]
        : typeof v === 'object' && v
          ? Object.values(v).flatMap(strings)
          : [];
    for (const s of [...strings(ja), ...strings(en)]) expect(s.trim()).not.toBe('');
  });
});
