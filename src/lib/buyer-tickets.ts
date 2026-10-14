/** Allowlisted receipt projection. Settlement amounts are in major currency units. */
export interface FairSettlement {
  version?: string;
  settledAt: string;
  totalAmount: number;
  netAmount?: number;
  currency: string;
  fees?: {
    role: string;
    name: string;
    rateBps: number;
    fixedCents: number;
    amount: number;
    estimated?: boolean;
  }[];
  chain: { did: string; amount: number; role: string }[];
}

export interface BuyerTicket {
  id: string;
  status: string;
  usedAt: string | null;
  registrationStatus: string;
  pricePaid: number | null;
  currency: string | null;
  ticketType: {
    name: string;
    description: string | null;
    perks: string[];
    registrationFormId: string | null;
  } | null;
}

export interface BuyerOrder {
  id: string;
  isLegacy: boolean;
  quantity: number;
  /** Cents, scoped to the tickets currently owned by this caller. */
  totalAmount: number | null;
  currency: string | null;
  purchasedAt: string | null;
  ticketTypeName: string;
  fairSettlement: FairSettlement | null;
  tickets: BuyerTicket[];
}
