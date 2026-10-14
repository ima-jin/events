'use client';

import { useState } from 'react';
import { withBasePath } from '@/lib/base-path';
import { CohostManager } from './cohost-manager';
import { EventStatusControls } from './event-status-controls';
import { GuestList } from './guest-list';
import { formatMoney, PANEL_CLASS } from './organizer-data';
import { SalesTab } from './sales-tab';
import { EventOverviewStats } from './event-overview-stats';

export interface OrganizerTierSummary {
  id: string;
  name: string;
  price: number;
  currency: string;
  quantity: number | null;
  sold: number;
}

export interface OrganizerDashboardProps {
  eventId: string;
  title: string;
  status: string;
  creatorDid: string;
  isCreator: boolean;
  tiers?: readonly OrganizerTierSummary[];
  startsAt?: string;
}

const TABS = ['Overview', 'Guests', 'Sales', 'Managers'] as const;
type OrganizerTab = typeof TABS[number];

export function OrganizerDashboard({ eventId, title, status, creatorDid, isCreator, tiers = [], startsAt }: Readonly<OrganizerDashboardProps>) {
  const [tab, setTab] = useState<OrganizerTab>('Overview');
  return <div className="space-y-6">
    <header><h1 className="text-3xl font-bold">{title}</h1><p>Organizer dashboard</p></header>
    <EventStatusControls key={`${eventId}:${status}`} eventId={eventId} currentStatus={status} isCreator={isCreator} />
    <div role="tablist" aria-label="Organizer sections" className="flex flex-wrap gap-3 border-b border-gray-200 pb-3 dark:border-gray-700">
      {TABS.map((name) => <button type="button" key={name} role="tab" id={`organizer-tab-${name}`} aria-selected={tab === name} aria-controls={`organizer-panel-${name}`} onClick={() => setTab(name)} className={tab === name ? 'font-semibold text-orange-600' : 'text-gray-500'}>{name}</button>)}
    </div>
    <div role="tabpanel" id={`organizer-panel-${tab}`} aria-labelledby={`organizer-tab-${tab}`}>
      {tab === 'Overview' && <section className={PANEL_CLASS}>
        <h2 className="mb-4 text-xl font-semibold">Event Overview</h2>
        <EventOverviewStats eventId={eventId} startsAt={startsAt} />
        <div className="mb-4 flex gap-4"><a className="text-orange-600 underline" href={withBasePath(`/e/${encodeURIComponent(eventId)}`)}>View Event</a><a className="text-orange-600 underline" href={withBasePath(`/e/${encodeURIComponent(eventId)}/edit`)}>Edit Event</a></div>
        <h3 className="mb-3 font-semibold">Ticket Tiers</h3>
        {tiers.length === 0 && <p>No ticket tiers configured.</p>}
        <ul className="grid gap-3 md:grid-cols-2">{tiers.map((tier) => <li key={tier.id} className="rounded border border-gray-200 p-3 dark:border-gray-700">
          <h4 className="font-semibold">{tier.name}</h4><p>{tier.sold} / {tier.quantity ?? 'Unlimited'} sold</p><p>{formatMoney(tier.price, tier.currency)} each</p>
        </li>)}</ul>
      </section>}
      {tab === 'Guests' && <GuestList eventId={eventId} isCreator={isCreator} />}
      {tab === 'Sales' && <SalesTab eventId={eventId} />}
      {tab === 'Managers' && <CohostManager eventId={eventId} creatorDid={creatorDid} isCreator={isCreator} />}
    </div>
  </div>;
}
