import { describe, expect, it } from 'vitest';
import { describeCron, usd, usdShort } from './shared';

describe('describeCron', () => {
  it('names presets and common shapes', () => {
    expect(describeCron('0 9 * * *')).toBe('Daily at 09:00');
    expect(describeCron('30 8 * * *')).toBe('Daily at 08:30');
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 09:00');
    expect(describeCron('0 18 * * 5')).toBe('Fridays at 18:00');
    expect(describeCron('15 7 2 * *')).toBe('Monthly on the 2nd at 07:15');
    expect(describeCron('0 */3 * * *')).toBe('Every 3 hours');
  });
  it('leaves anything else as written', () => {
    expect(describeCron('5 4 * 1 *')).toBe('5 4 * 1 *');
    expect(describeCron('*/5 * * * *')).toBe('*/5 * * * *');
  });
});

describe('money labels', () => {
  it('formats run costs', () => {
    expect(usd(0)).toBe('$0');
    expect(usd(0.004)).toBe('<$0.01');
    expect(usd('0.47')).toBe('$0.47');
    expect(usd(14.2)).toBe('$14');
  });
  it('keeps chart labels short', () => {
    expect(usdShort(0)).toBe('');
    expect(usdShort(0.004)).toBe('1¢');
    expect(usdShort(0.62)).toBe('62¢');
    expect(usdShort(2.26)).toBe('$2.3');
  });
});
