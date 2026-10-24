import { toNumber } from "./expression.js";

// Random value generation for `random` steps. Ported from the reference RandomValueGenerator: int is uniform over
// [min, max), float is uniform over [min, max], weighted picks by a weight field, and beta uses the same two
// approximations (alpha = 1 and symmetric averages). Every draw is crypto-random.

// Uniform draw in [0, 1).
export function unitRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

export function randomInt(min: number, max: number): number {
  const lo = Math.floor(min);
  const hi = Math.floor(max);
  if (lo >= hi) return lo;
  return lo + Math.floor(unitRandom() * (hi - lo));
}

export function randomFloat(min: number, max: number): number {
  return min + unitRandom() * (max - min);
}

// Picks one item by weight. Items that are not objects, or lack the weight field, weigh 1. Only positive weights are
// eligible; if no weight is positive the pick is uniform.
export function weightedSelect(items: readonly unknown[], weightField: string): unknown {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  const weights = items.map((item) => weightOf(item, weightField));
  const total = weights.reduce((sum, weight) => sum + (weight > 0 ? weight : 0), 0);
  if (total <= 0) return items[Math.floor(unitRandom() * items.length)];
  const roll = unitRandom() * total;
  let cumulative = 0;
  for (const [index, weight] of weights.entries()) {
    if (weight <= 0) continue;
    cumulative += weight;
    if (roll < cumulative) return items[index];
  }
  return items[items.length - 1];
}

function weightOf(item: unknown, weightField: string): number {
  if (item !== null && typeof item === "object" && !Array.isArray(item) && Object.prototype.hasOwnProperty.call(item, weightField)) {
    return toNumber(Reflect.get(item, weightField));
  }
  return 1;
}

export function betaSample(alpha: number, beta: number, min: number, max: number): number {
  if (Math.abs(alpha - 1) < 1e-9) return max - (max - min) * Math.pow(unitRandom(), 1 / beta);
  if (Math.abs(alpha - beta) < 1e-9) return betaSymmetric(alpha, min, max);
  return betaSymmetric(Math.ceil((alpha + beta) / 2), min, max);
}

// Average of round(alpha) uniform draws, at least one. The reference rounds half to even.
function betaSymmetric(alpha: number, min: number, max: number): number {
  const n = Math.max(1, roundHalfToEven(alpha));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += unitRandom();
  return min + (sum / n) * (max - min);
}

function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}
