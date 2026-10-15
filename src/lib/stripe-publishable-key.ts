/** Public account selector only; never accept a secret/restricted Stripe key here. */
export function isStripePublishableKey(value: unknown): value is string {
  return typeof value === 'string' && /^pk_(?:test|live)_[A-Za-z0-9]+$/.test(value);
}
