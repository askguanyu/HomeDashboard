import { getFedEvents, startFedMaintenance, type FedEvent } from './fed.js';
import { getDataEvents, startDataMaintenance } from './bls.js';

/**
 * The calendar's macro layer: FOMC dates, market-moving Fed appearances and
 * principal US data releases, merged into one dated list.
 *
 * Which officials' speeches qualify is an editorial call, so it lives here and
 * not in the scraper: data/fed-{year}.json keeps every speech the Fed publishes,
 * and this filter can change without re-fetching anything. Congressional
 * testimony and the Chair count on their own — both move markets whatever the
 * topic — plus any appearance whose title or venue points at macro policy.
 * Programme talks (payments and tokenisation, banking supervision, community
 * affairs, education, AI, climate) and greeting-card remarks stay hidden even
 * though they sit on the Fed's own calendar.
 */

export type MacroKind = 'fomc' | 'speech' | 'data';

export interface MacroEvent {
  date: string; // YYYY-MM-DD
  kind: MacroKind;
  label: string; // short chip text
  title: string; // tooltip
  who?: string; // speech: official slug (powell, waller, ...)
  press?: boolean; // fomc: press conference same day
}

/** Slug the Fed uses in /newsevents/speech/{slug}{date}.htm for the Chair. */
const CHAIR = 'powell';

/** Policy words and venues that make an official's appearance trade-relevant. */
const MAJOR =
  /(monetary polic|monetary report|economic report|inflation|deflation|price stabilit|economic outlook|economic activit|economic situation|economic condition|economic projection|economic forecast|the economy|labor market|labour market|unemployment|employment|payroll|job gain|job loss|wage|financial stability|interest rate|money market|liquidity|fomc|jackson hole|economic symposium|economic club|american economic association|business economics|council on foreign relations|group of thirty|brookings|chamber of commerce)/i;

/** Procedure, not content: these titles say nothing the market can trade on. */
const CEREMONY = /^(?:Speech|Testimony): (?:Opening|Welcoming|Welcome|Good morning|Brief|Prepared|Remarks|Commencement|Baccalaureate|Graduation|Keynote|Introduction|Acceptance|Praise|Citation|Recognition|Presentation|Tribute)/i;

function isMarketMoving(e: FedEvent): boolean {
  if (e.kind !== 'speech') return true; // FOMC rows always show
  // a substantive title outranks everything, including a ceremony wrapper
  // ("Remarks on 'Monetary Policy Transmission to Real Activity'")
  if (MAJOR.test(e.title)) return true;
  // older caches have no testimony flag; the scraper prefixes the title instead
  if (e.testimony || /^testimony:/i.test(e.title)) return true;
  // the Chair counts even for a topic-less appearance, but not for filler
  return e.who === CHAIR && !CEREMONY.test(e.title);
}

/** FOMC + speeches (filtered) + data releases, one list sorted by date. */
export async function getMacroEvents(root: string, year: number): Promise<{ year: number; events: MacroEvent[] }> {
  const [fed, data] = await Promise.all([getFedEvents(root, year), getDataEvents(root, year)]);
  const events: MacroEvent[] = [...fed.events.filter(isMarketMoving), ...data];
  events.sort((a, b) => a.date.localeCompare(b.date));
  return { year, events };
}

/** Startup + daily sweep for both sources; pages never hit the network path. */
export function startMacroMaintenance(root: string): void {
  startFedMaintenance(root);
  startDataMaintenance(root);
}
