import type { Term } from '@/components/analysis/explain';

const TIME_WEIGHTED =
  'Each reading counts for the time until the next one (at most 60 seconds), so a gap in readings is not counted as load.';

export const ENERGY_TERMS: Term[] = [
  {
    term: 'Energy used (kWh)',
    meaning:
      'The meter keeps a running total of energy. VITAL adds up how much that total went up between readings. If the meter was reset, that drop is skipped.',
    formula: String.raw`E = \sum \max\left(0,\ E_i - E_{i-1}\right)`,
  },
  {
    term: 'Estimated cost',
    meaning: 'Energy used times your electricity rate. It leaves out fixed charges and taxes on a real bill.',
    formula: String.raw`\text{Cost} = E \times \text{rate}`,
  },
  {
    term: 'Peak load (VA)',
    meaning: 'The highest apparent power read in the range: voltage times current.',
    formula: String.raw`S = V \times I`,
  },
  {
    term: 'Over the limit',
    meaning: `Time the load was at or above the alarm level. ${TIME_WEIGHTED}`,
    formula: String.raw`t_{\text{over}} = \sum_{S_i \ge S_{\text{alarm}}} \Delta t_i`,
  },
  {
    term: 'Electricity rate',
    meaning: 'What you pay per kWh, in pesos. Change it with Edit; every cost on these pages uses it.',
  },
];

export const PEAK_HOURS_TERMS: Term[] = [
  {
    term: 'A square',
    meaning: 'One hour of one weekday, in Philippine time, combining every matching day in the range.',
  },
  {
    term: 'Average VA',
    meaning: `The average apparent power during that hour. ${TIME_WEIGHTED}`,
    formula: String.raw`\bar{S} = \dfrac{\sum S_i\,\Delta t_i}{\sum \Delta t_i}`,
  },
  {
    term: 'Shade',
    meaning: 'Darker squares had a higher average load, ranked against the other hours, so one unusual hour does not wash out the rest.',
  },
  {
    term: 'Red dot',
    meaning: 'The load was at or above the alarm level for some of that hour.',
  },
  {
    term: 'Busiest hour and day',
    meaning: 'The hour of the day and the weekday with the highest average VA.',
  },
];

export const POWER_QUALITY_TERMS: Term[] = [
  {
    term: 'Nominal voltage',
    meaning: 'The voltage the supply is meant to be. Change it with Edit if yours differs.',
  },
  {
    term: 'Normal band',
    meaning: 'From 90% to 110% of the nominal voltage.',
    formula: String.raw`0.9\,V_{\text{nom}} \le V \le 1.1\,V_{\text{nom}}`,
  },
  {
    term: 'Sag',
    meaning: 'The voltage dropped below 90% of nominal, usually when a heavy load starts or the supply is weak. Lights dim and motors struggle.',
    formula: String.raw`V < 0.9\,V_{\text{nom}}`,
  },
  {
    term: 'Swell',
    meaning: 'The voltage rose above 110% of nominal, often when a big load switches off. It stresses insulation and electronics.',
    formula: String.raw`V > 1.1\,V_{\text{nom}}`,
  },
  {
    term: 'Event',
    meaning: 'One unbroken run of sag or swell readings. The voltage shown is the worst point of the run, the duration how long it lasted.',
  },
  {
    term: 'Power factor',
    meaning:
      'How much of the current does useful work: real power over apparent power. 1.00 is ideal, under 0.85 is low. Averaged only while the load is on (10 W or more).',
    formula: String.raw`\mathrm{PF} = \dfrac{P}{S} = \cos\varphi`,
  },
  {
    term: 'Correction (kvar)',
    meaning: 'The reactive power a capacitor must supply to lift the power factor to 0.95 at the average load.',
    formula: String.raw`Q = P\left(\tan\varphi_1 - \tan\varphi_2\right),\quad \varphi = \arccos(\mathrm{PF})`,
  },
  {
    term: 'Capacitor (µF)',
    meaning: 'The capacitor that supplies that reactive power at the nominal voltage and the measured frequency.',
    formula: String.raw`C = \dfrac{Q}{2\pi f V^{2}}`,
  },
];

export const AGING_TERMS: Term[] = [
  {
    term: 'Aging rate',
    meaning:
      'How fast the insulation ages compared with normal, from the IEEE C57.91 standard. 1 × is normal aging at a 110 °C hot spot; it roughly doubles for every 7 °C hotter.',
    formula: String.raw`F_{AA} = \exp\left(\dfrac{15000}{383} - \dfrac{15000}{\theta + 273}\right)`,
  },
  {
    term: 'Equivalent aging',
    meaning: 'How long the transformer would have to run at the normal rate to wear its insulation as much as it did in this range.',
    formula: String.raw`t_{\text{eq}} = \sum F_{AA,i}\,\Delta t_i`,
  },
  {
    term: 'Life used',
    meaning: 'Equivalent aging as a share of the 180,000 hours of normal life the standard assumes.',
    formula: String.raw`\text{Life used} = \dfrac{t_{\text{eq}}}{180\,000\ \text{h}} \times 100\%`,
  },
  {
    term: 'Why it is an estimate',
    meaning:
      'The standard uses the hottest point inside the winding. The probe measures the outside of the transformer, which is cooler, so the real rate is somewhat higher.',
  },
];

export const REPORT_TERMS: Term[] = [
  {
    term: 'PDF',
    meaning: 'The summary for the range: energy and cost, power quality, aging, each day, every alert and how fast people answered.',
  },
  {
    term: 'CSV',
    meaning: 'Every reading in the range, one row each, for Excel or Google Sheets.',
  },
  {
    term: 'Typical response',
    meaning: 'The median time from an alert to its acknowledgement: half of the alerts were answered faster, half slower.',
  },
  {
    term: 'Sensor, Simulated, All',
    meaning: 'Which readings to use: the board, the simulator, or both.',
  },
];

export const AUDIT_TERMS: Term[] = [
  {
    term: 'What is recorded',
    meaning:
      'Every change to the protection settings, relay commands, user accounts and people’s own profiles, with who did it and when. Passwords are never recorded, only that one changed.',
  },
  {
    term: 'Filters',
    meaning: 'Settings, Relay, Users and Account each show one kind of change.',
  },
  {
    term: 'Older changes',
    meaning: 'The log starts on October 9, 2026, when it was added. Nothing before then was recorded.',
  },
];
