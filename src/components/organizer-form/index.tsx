'use client';

import { DetailsFields } from './details-fields';
import { TierFields } from './tier-fields';
import { useEventForm } from './use-event-form';
import type { EventFormProps } from './types';

export type { EventFormProps, EventFormEvent, EventFormTier, JsonValue } from './types';
export { FairAttribution, type FairAttributionProps } from './fair-attribution';
export type { FairAttributionManifest } from './fair-manifest';

export function EventForm(props: Readonly<EventFormProps>) {
  const form = useEventForm(props);
  if (form.loadFailed) return <p role="alert">Unable to load event details. Return to the organizer dashboard and try again.</p>;
  let submitLabel = props.mode === 'edit' ? 'Save changes' : 'Create event';
  if (form.saving) submitLabel = 'Saving…';
  return (
    <form noValidate onSubmit={(event) => { event.preventDefault(); form.submit().catch(form.reportFailure); }} className="space-y-6">
      <fieldset disabled={form.saving || form.uncertain} className="space-y-6">
        <DetailsFields details={form.details} update={form.update} onUploadBusy={form.setUploadBusy} />
        <section className="space-y-4 rounded-xl border border-gray-200 p-6 dark:border-gray-700">
          <h2 className="text-xl font-semibold">Ticket tiers</h2>
          <button type="button" onClick={form.addTier}>Add tier</button>
          {form.tiers.map((tier, index) => (
            <TierFields key={tier.key} tier={tier} first={index === 0} last={index === form.tiers.length - 1}
              removable={!tier.id && form.tiers.length > 1} update={form.updateTier}
              move={(direction) => form.moveTier(tier.key, direction)} remove={() => form.removeTier(tier.key)} />
          ))}
        </section>
      </fieldset>
      {form.error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-red-700">{form.error}</p>}
      <div className="flex gap-4">
        <button type="button" onClick={form.cancel} disabled={form.saving}>Cancel</button>
        <button type="submit" disabled={form.saving || form.uploadBusy || form.uncertain}
          className="rounded-lg bg-orange-500 px-6 py-3 font-semibold text-white disabled:opacity-50">{submitLabel}</button>
      </div>
    </form>
  );
}

export default EventForm;
