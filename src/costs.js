// Conservative billing rates in RMB fen. Bounds include request framing and the full FC timeout.
// Reconcile rates with the provider account before enabling real calls in a new region.
export const scriptCost = (inputTokens, outputTokens) =>
  Math.max(1, Math.ceil((inputTokens * 2000 + outputTokens * 8000) / 1_000_000));
export const renderCost = (voiceBytes, seconds) =>
  Math.max(1, Math.ceil((voiceBytes * 200) / 10000 + ((seconds + 30) * 12) / 60 + 3));
export const voiceUnits = (plan) =>
  plan.scenes.reduce((total, s) => total + new TextEncoder().encode(s.narration).length, 0);
export function costSettlement(db, key, cost, usage) {
  return db
    .prepare('UPDATE costs SET settled_fen=?,usage=? WHERE id=? AND settled_fen IS NULL')
    .bind(cost, JSON.stringify(usage), key);
}
