import { Field, INPUT_CLASS } from './field';
import type { TierDraft } from './types';

interface TierProps {
  tier: TierDraft;
  first: boolean;
  last: boolean;
  removable: boolean;
  update: (tier: TierDraft) => void;
  move: (direction: number) => void;
  remove: () => void;
}

export function TierFields({ tier, first, last, removable, update, move, remove }: Readonly<TierProps>) {
  function change<K extends keyof TierDraft>(key: K, value: TierDraft[K]) {
    update({ ...tier, [key]: value });
  }
  return (
    <fieldset className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <legend>Ticket tier: {tier.name || 'New tier'}</legend>
      <div className="flex gap-3">
        <button type="button" disabled={first} onClick={() => move(-1)}>Move up</button>
        <button type="button" disabled={last} onClick={() => move(1)}>Move down</button>
        {removable && <button type="button" onClick={remove}>Remove new tier</button>}
      </div>
      <Field label="Tier name" value={tier.name} onChange={(value) => change('name', value)} />
      <Field label="Price" type="number" min={0} step="0.01" value={tier.price} onChange={(value) => change('price', value)} />
      <label className="block"><span>Currency</span>
        <select className={INPUT_CLASS} value={tier.currency} onChange={(event) => change('currency', event.target.value)}>
          <option value="CAD">CAD</option><option value="USD">USD</option>
        </select>
      </label>
      <Field label="Quantity (blank means unlimited)" type="number" min={tier.sold} step="1" value={tier.quantity} onChange={(value) => change('quantity', value)} />
      <p>Sold: {tier.sold}</p>
      <Field label="Tier description" value={tier.description} onChange={(value) => change('description', value)} />
      <Field label="Perks (one per line)" value={tier.perks} onChange={(value) => change('perks', value)} multiline />
      <p className="text-sm text-gray-500">After sales, prices can only decrease; currency cannot change; perks can only be added.</p>
      <label className="block">
        <input type="checkbox" checked={tier.requiresRegistration} onChange={(event) => change('requiresRegistration', event.target.checked)} />
        <span>Requires registration</span>
      </label>
      {tier.requiresRegistration && (
        <>
          <Field label="Registration form ID" value={tier.registrationFormId} onChange={(value) => change('registrationFormId', value)} />
          <p className="text-sm text-gray-500">Enter the form ID from your registration service. Form discovery is not available here.</p>
        </>
      )}
      <Field label="Access code (optional)" value={tier.accessCode} onChange={(value) => change('accessCode', value)} />
    </fieldset>
  );
}
