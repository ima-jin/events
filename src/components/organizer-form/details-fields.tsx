import { Field, INPUT_CLASS } from './field';
import { ImageUpload } from './image-upload';
import type { FormDetails, LocationType } from './types';

interface DetailsProps {
  details: FormDetails;
  update: <K extends keyof FormDetails>(key: K, value: FormDetails[K]) => void;
  onUploadBusy: (busy: boolean) => void;
}

export function DetailsFields({ details, update, onUploadBusy }: Readonly<DetailsProps>) {
  return (
    <section className="space-y-4 rounded-xl border border-gray-200 p-6 dark:border-gray-700">
      <h2 className="text-xl font-semibold">Event details</h2>
      <Field label="Event title" value={details.title} onChange={(value) => update('title', value)} />
      <Field label="Tagline" value={details.tagline} onChange={(value) => update('tagline', value)} />
      <Field label="Description" value={details.description} onChange={(value) => update('description', value)} multiline />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Start date and time" type="datetime-local" value={details.startsAt} onChange={(value) => update('startsAt', value)} />
        <Field label="End date and time" type="datetime-local" value={details.endsAt} onChange={(value) => update('endsAt', value)} />
      </div>
      <Field label="Timezone (IANA)" value={details.timezone} onChange={(value) => update('timezone', value)} />
      <p className="text-sm text-gray-500">Dates and times use this timezone, for example UTC or America/Toronto.</p>
      <label className="block"><span>Location type</span>
        <select className={INPUT_CLASS} value={details.locationType} onChange={(event) => update('locationType', event.target.value as LocationType)}>
          <option value="physical">Physical</option><option value="virtual">Virtual</option><option value="hybrid">Hybrid</option>
        </select>
      </label>
      {details.locationType !== 'physical' && <Field label="Virtual URL" type="url" value={details.virtualUrl} onChange={(value) => update('virtualUrl', value)} />}
      {details.locationType !== 'virtual' && (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Venue" value={details.venue} onChange={(value) => update('venue', value)} />
          <Field label="Address" value={details.address} onChange={(value) => update('address', value)} />
          <Field label="City" value={details.city} onChange={(value) => update('city', value)} />
          <Field label="Country" value={details.country} onChange={(value) => update('country', value)} />
        </div>
      )}
      <Field label="Cover image URL" value={details.imageUrl} onChange={(value) => update('imageUrl', value)} />
      <ImageUpload onUpload={(url) => update('imageUrl', url)} onBusy={onUploadBusy} />
      <Field label="Linked course slug" value={details.courseSlug} onChange={(value) => update('courseSlug', value)} />
      <label className="block"><span>Status</span>
        <select className={INPUT_CLASS} value={details.status} onChange={(event) => update('status', event.target.value)}>
          {['draft', 'published', 'paused', 'cancelled', 'completed'].map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
      </label>
      <label className="block"><span>Access control</span>
        <select className={INPUT_CLASS} value={details.accessMode} onChange={(event) => update('accessMode', event.target.value as FormDetails['accessMode'])}>
          <option value="public">Public</option><option value="invite_only">Invite only</option>
        </select>
      </label>
      <label className="block">
        <input type="checkbox" checked={details.emtEnabled} onChange={(event) => update('emtEnabled', event.target.checked)} />
        <span>Accept e-Transfer payments</span>
      </label>
      {details.emtEnabled && <Field label="Payment email" type="email" value={details.emtEmail} onChange={(value) => update('emtEmail', value)} />}
    </section>
  );
}
