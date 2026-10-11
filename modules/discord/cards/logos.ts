/**
 * Websites of known distributors, for the logo on the distributor card. The
 * image is the site's own icon, served by Google's public favicon service
 * (a fixed host, so nothing a user typed is ever fetched).
 */
const DOMAINS: Record<string, string> = {
  awal: 'awal.com',
  'absolute label services': 'absolutelabelservices.com',
  amuse: 'amuse.io',
  believe: 'believe.com',
  'cd baby': 'cdbaby.com',
  'create music group': 'createmusicgroup.com',
  distrokid: 'distrokid.com',
  'ditto music': 'dittomusic.com',
  empire: 'empi.re',
  emubands: 'emubands.com',
  fuga: 'fuga.com',
  ingrooves: 'ingrooves.com',
  level: 'level.app',
  onerpm: 'onerpm.com',
  routenote: 'routenote.com',
  spinnup: 'spinnup.com',
  stem: 'stem.is',
  symphonic: 'symphonic.com',
  'the orchard': 'theorchard.com',
  'too lost': 'toolost.com',
  tunecore: 'tunecore.com',
  unitedmasters: 'unitedmasters.com',
  'virgin music group': 'virginmusic.com',
  vydia: 'vydia.com',
  'supply chain music': 'supplychainmusic.com',
  'zvonko digital': 'zvonkodigital.com',
  'sony music': 'sonymusic.com',
  'universal music': 'universalmusic.com',
  'warner music': 'wmg.com',
  'warner': 'wmg.com',
  'universal': 'universalmusic.com',
  'sony': 'sonymusic.com',
};

export function distributorLogo(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name.toLowerCase().replace(/\s+/g, ' ').trim();
  const domain = DOMAINS[key] ?? Object.entries(DOMAINS).find(([k]) => key.startsWith(`${k} `))?.[1];
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : null;
}
