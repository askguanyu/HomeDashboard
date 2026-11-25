/**
 * Shared HTML text helpers for the scraped sources (fed.ts, bls.ts). Both read
 * plain government pages with no DOM parser, so entity decoding is the one piece
 * worth not copy-pasting twice.
 */

/** Numeric + the handful of named entities these pages actually use. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}
