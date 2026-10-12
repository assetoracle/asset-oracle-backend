export function meanTickFromCumulatives(before: bigint, after: bigint, windowSeconds: number): number {
  if (!Number.isInteger(windowSeconds) || windowSeconds <= 0) {
    throw new Error("TWAP window must be a positive integer");
  }
  const delta = after - before;
  let meanTick = delta / BigInt(windowSeconds);
  if (delta < 0n && delta % BigInt(windowSeconds) !== 0n) meanTick -= 1n;
  const tick = Number(meanTick);
  if (!Number.isSafeInteger(tick) || tick < -887272 || tick > 887272) {
    throw new Error("Pool returned an invalid TWAP tick");
  }
  return tick;
}

export function priceAtTick(tick: number, token0Decimals: number, token1Decimals: number): number {
  if (
    !Number.isFinite(tick) || tick < -887272 || tick > 887272 ||
    !Number.isInteger(token0Decimals) || token0Decimals < 0 || token0Decimals > 36 ||
    !Number.isInteger(token1Decimals) || token1Decimals < 0 || token1Decimals > 36
  ) throw new Error("Invalid tick or token decimals");
  const price = Math.pow(1.0001, tick) * Math.pow(10, token0Decimals - token1Decimals);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid calculated pool price");
  return price;
}
