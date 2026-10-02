import { describe, expect, it } from 'vitest';
import { clip, compact } from './tools';

describe('clip', () => {
  it('cuts long text without leaving half an emoji', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('abcdef', 3)).toBe('abc');
    // "🤲" is two UTF-16 units; cutting between them would leave invalid Unicode.
    const cut = clip('wifi 🤲 eSIM', 6);
    expect(cut).toBe('wifi ');
    expect(() => encodeURIComponent(cut)).not.toThrow();
    expect(clip('🤲🤲', 2)).toBe('🤲');
  });
  it('keeps compact previews valid Unicode', () => {
    const big = compact({ caption: '😀'.repeat(10) }, 16) as { preview: string };
    expect(() => encodeURIComponent(big.preview)).not.toThrow();
  });
});
