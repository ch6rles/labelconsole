import type { DistributorEvidence } from '../schema';

/**
 * Distributor inference. No DSP publishes the distributor, so we collect
 * evidence, each with a weight, and combine per distributor:
 *   1. a licensed provider's distributor field (strongest)
 *   2. label name and P/C lines matched against known distributor strings
 *   3. the UPC's GS1 company prefix, learned from this label's confirmed releases
 *   4. MusicBrainz label relationships
 * Scores combine as independent signals: 1 - Π(1 - wᵢ).
 */
export type Alias = { distributor: string; pattern: string; weight: number };
export type Hint = { kind: 'upc_prefix' | 'label_string'; value: string; distributor: string; confirmations: number };

export type DistributorInput = {
  labelName?: string | null;
  pLine?: string | null;
  cLine?: string | null;
  upc?: string | null;
  licensedDistributor?: string | null;
  mbLabels?: string[];
};

const norm = (s: string) => s.toLowerCase().replace(/[℗©]/g, ' ').replace(/\s+/g, ' ').trim();

export function inferDistributor(input: DistributorInput, aliases: Alias[], hints: Hint[]) {
  const evidence: DistributorEvidence[] = [];

  if (input.licensedDistributor) evidence.push({ source: 'licensed provider', signal: 'distributor field', value: input.licensedDistributor, weight: 0.95, distributor: input.licensedDistributor });

  const texts: Array<[string, string | null | undefined]> = [
    ['label', input.labelName],
    ['P-line', input.pLine],
    ['C-line', input.cLine],
  ];
  for (const [signal, raw] of texts) {
    if (!raw) continue;
    const text = norm(raw);
    const best = new Map<string, Alias>();
    for (const a of aliases) {
      const pat = norm(a.pattern);
      // Whole-word match so "believe" does not match "unbelievers".
      if (new RegExp(`(^|[^a-z0-9])${pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text)) {
        const cur = best.get(a.distributor);
        if (!cur || a.weight > cur.weight) best.set(a.distributor, a);
      }
    }
    for (const a of best.values()) evidence.push({ source: 'catalogue text', signal, value: raw, weight: Number(a.weight), distributor: a.distributor });
    if (signal === 'label') {
      for (const h of hints.filter((x) => x.kind === 'label_string' && norm(x.value) === text)) {
        evidence.push({ source: 'confirmed by this label', signal: 'label string', value: raw, weight: Math.min(0.9, 0.6 + 0.1 * Math.min(h.confirmations, 3)), distributor: h.distributor });
      }
    }
  }

  if (input.upc) {
    const gtin = input.upc.padStart(13, '0');
    for (let len = 10; len >= 6; len--) {
      const prefix = gtin.slice(0, len);
      const matches = hints.filter((h) => h.kind === 'upc_prefix' && h.value === prefix);
      if (matches.length) {
        for (const h of matches) evidence.push({ source: 'confirmed by this label', signal: `UPC prefix ${prefix}`, value: input.upc, weight: Math.min(0.9, 0.5 + 0.1 * Math.min(h.confirmations, 4)), distributor: h.distributor });
        break; // longest prefix wins
      }
    }
  }

  for (const label of input.mbLabels ?? []) {
    const text = norm(label);
    for (const a of aliases) if (text.includes(norm(a.pattern))) evidence.push({ source: 'MusicBrainz', signal: 'label relationship', value: label, weight: Number(a.weight) * 0.6, distributor: a.distributor });
  }

  const scores = new Map<string, number>();
  for (const e of evidence) scores.set(e.distributor, 1 - (1 - (scores.get(e.distributor) ?? 0)) * (1 - e.weight));
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return { name: null, confidence: 0, evidence };
  const [top, second] = ranked;
  const confidence = Math.max(0, Math.min(0.99, top[1] - (second ? second[1] * 0.5 : 0)));
  return { name: top[0], confidence: Math.round(confidence * 1000) / 1000, evidence: evidence.sort((a, b) => b.weight - a.weight) };
}

/** What to learn when a person confirms a distributor for a release. */
export function hintsToLearn(input: { upc?: string | null; labelName?: string | null }, distributor: string): Array<Pick<Hint, 'kind' | 'value' | 'distributor'>> {
  const out: Array<Pick<Hint, 'kind' | 'value' | 'distributor'>> = [];
  if (input.labelName) out.push({ kind: 'label_string', value: input.labelName.trim(), distributor });
  if (input.upc) {
    const gtin = input.upc.padStart(13, '0');
    for (const len of [7, 8, 9]) out.push({ kind: 'upc_prefix', value: gtin.slice(0, len), distributor });
  }
  return out;
}
