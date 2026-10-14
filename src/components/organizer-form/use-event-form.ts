'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { initialDetails, newTier, tierDraft, validateForm } from './model';
import { saveForm, type SaveProgress } from './persistence';
import type { EventFormProps, FormDetails, TierDraft } from './types';

function initialState(props: Readonly<EventFormProps>) {
  try {
    return { details: initialDetails(props), invalid: false };
  } catch {
    return { details: initialDetails({ mode: 'create' }), invalid: true };
  }
}

export function useEventForm(props: Readonly<EventFormProps>) {
  const router = useRouter();
  const [initial] = useState(() => initialState(props));
  const [details, setDetails] = useState(initial.details);
  const [tiers, setTiers] = useState(() => {
    if (props.mode === 'edit') {
      return [...(props.existingTickets || [])].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)).map(tierDraft);
    }
    return [{ ...newTier(), name: 'General Admission' }];
  });
  const [saving, setSaving] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const progress = useRef<SaveProgress>({ eventId: props.event?.id, tierIds: new Map(), uncertain: false });
  const loadFailed = Boolean(props.loadError) || initial.invalid || (props.mode === 'edit' && !props.event);
  function update<K extends keyof FormDetails>(key: K, value: FormDetails[K]) {
    setDetails((current) => ({ ...current, [key]: value }));
  }
  function updateTier(next: TierDraft) {
    setTiers((current) => current.map((tier) => tier.key === next.key ? next : tier));
  }
  function moveTier(key: string, direction: number) {
    setTiers((current) => {
      const index = current.findIndex((tier) => tier.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const moved = [...current];
      [moved[index], moved[target]] = [moved[target], moved[index]];
      return moved;
    });
  }
  function removeTier(key: string) {
    setTiers((current) => current.filter((tier) => tier.key !== key || Boolean(tier.id) || progress.current.tierIds.has(key)));
  }
  async function submit() {
    if (locked.current || uploadBusy || loadFailed) return;
    const validation = validateForm(details, tiers);
    setError(validation);
    if (validation) return;
    locked.current = true;
    setSaving(true);
    try {
      const id = await saveForm(details, tiers, progress.current);
      router.push(`/e/${encodeURIComponent(id)}`);
    } catch {
      const message = progress.current.uncertain
        ? 'The save result is uncertain. Check the organizer dashboard before trying again; retry is disabled to prevent duplicates.'
        : 'Unable to save. Check your permissions and fields, then retry.';
      setError(message);
    } finally {
      locked.current = false;
      setSaving(false);
      // Confirmed tier IDs become existing tiers immediately, including after partial failure.
      setTiers((current) => current.map((tier) => ({ ...tier, id: tier.id || progress.current.tierIds.get(tier.key) })));
    }
  }
  return {
    details, tiers, saving, uploadBusy, error, loadFailed, uncertain: progress.current.uncertain,
    update, updateTier, moveTier, removeTier, submit, setUploadBusy,
    addTier: () => setTiers((current) => [...current, newTier(current[0]?.currency)]),
    cancel: () => router.push(props.event ? `/e/${encodeURIComponent(props.event.id)}` : '/dashboard'),
    reportFailure: () => setError('Unable to save. Check your permissions and fields, then retry.'),
  };
}
