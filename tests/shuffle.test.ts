import { describe, it, expect } from 'vitest';
import { seededShuffle } from '../lib/shuffle';

describe('seededShuffle', () => {
  it('produces deterministic output for the same seed', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const res1 = seededShuffle(items, 'T01:r1:1');
    const res2 = seededShuffle(items, 'T01:r1:1');
    expect(res1).toEqual(res2);
  });

  it('produces different orders for different team seeds', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const res1 = seededShuffle(items, 'T01:r1:1');
    const res2 = seededShuffle(items, 'T02:r1:1');
    expect(res1).not.toEqual(res2);
  });
});
