'use client';

const STEP_BUTTON = 'px-3 py-1.5 text-lg font-bold transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-30';

interface QuantityStepperProps {
  /** Tier name, used for the accessible labels. */
  label: string;
  quantity: number;
  max: number;
  onChange: (quantity: number) => void;
}

export function QuantityStepper({ label, quantity, max, onChange }: Readonly<QuantityStepperProps>) {
  return (
    <fieldset aria-label={`Quantity for ${label}`} className="m-0 flex items-center overflow-hidden rounded-lg border border-gray-600 p-0">
      <button type="button" aria-label={`Remove one ${label}`} className={STEP_BUTTON} disabled={quantity <= 0} onClick={() => onChange(quantity - 1)}>
        −
      </button>
      <output aria-live="polite" className="min-w-[2.5rem] border-x border-gray-600 px-3 py-1.5 text-center text-sm font-semibold">
        {quantity}
      </output>
      <button type="button" aria-label={`Add one ${label}`} className={STEP_BUTTON} disabled={quantity >= max} onClick={() => onChange(quantity + 1)}>
        +
      </button>
    </fieldset>
  );
}
