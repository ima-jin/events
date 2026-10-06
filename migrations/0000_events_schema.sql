CREATE SCHEMA IF NOT EXISTS "events";
--> statement-breakpoint
CREATE TABLE "events"."event_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"token" text NOT NULL,
	"label" text,
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "event_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "events"."events" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text,
	"creator_did" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"timezone" text,
	"location_type" text DEFAULT 'physical',
	"is_virtual" boolean DEFAULT false,
	"virtual_url" text,
	"venue" text,
	"address" text,
	"city" text,
	"country" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"event_type" text DEFAULT 'event' NOT NULL,
	"target_amount" integer,
	"deadline" timestamp with time zone,
	"access_mode" text DEFAULT 'public' NOT NULL,
	"image_url" text,
	"image_asset_id" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"registration_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"name_display_policy" text DEFAULT 'attendee_choice' NOT NULL,
	"chat_enabled" boolean DEFAULT true NOT NULL,
	"course_slug" text,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"emt_email" text,
	"pod_id" text,
	"lobby_conversation_id" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "events_did_unique" UNIQUE("did")
);
--> statement-breakpoint
CREATE TABLE "events"."orders" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"buyer_did" text,
	"ticket_type_id" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"amount_total" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"payment_method" text,
	"stripe_session_id" text,
	"payment_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"fair_settlement" jsonb,
	"purchased_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"buyer_email" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "events"."pledges" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"backer_did" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"stripe_setup_intent_id" text,
	"stripe_payment_method_id" text,
	"stripe_customer_id" text,
	"mjnx_escrow_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"charged_at" timestamp with time zone,
	"failure_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events"."ticket_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_type_id" text NOT NULL,
	"did" text NOT NULL,
	"position" integer NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now(),
	"notified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'waiting' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events"."ticket_transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"from_did" text NOT NULL,
	"to_did" text NOT NULL,
	"transferred_at" timestamp with time zone DEFAULT now(),
	"signature" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events"."ticket_types" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"quantity" integer,
	"sold" integer DEFAULT 0,
	"perks" jsonb DEFAULT '[]'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"requires_registration" boolean DEFAULT false NOT NULL,
	"registration_form_id" text,
	"max_per_order" integer,
	"access_code" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "events"."tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"ticket_type_id" text NOT NULL,
	"owner_did" text,
	"order_id" text,
	"original_owner_did" text,
	"purchased_at" timestamp with time zone,
	"price_paid" integer,
	"currency" text,
	"payment_id" text,
	"status" text DEFAULT 'available' NOT NULL,
	"held_by" text,
	"held_until" timestamp with time zone,
	"used_at" timestamp with time zone,
	"signature" text,
	"payment_method" text,
	"hold_expires_at" timestamp with time zone,
	"payment_confirmed_at" timestamp with time zone,
	"registration_status" text DEFAULT 'not_required' NOT NULL,
	"last_email_sent_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "events"."event_invites" ADD CONSTRAINT "event_invites_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events"."orders" ADD CONSTRAINT "orders_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events"."orders" ADD CONSTRAINT "orders_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "events"."ticket_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events"."pledges" ADD CONSTRAINT "pledges_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events"."ticket_queue" ADD CONSTRAINT "ticket_queue_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "events"."ticket_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events"."ticket_transfers" ADD CONSTRAINT "ticket_transfers_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "events"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events"."ticket_types" ADD CONSTRAINT "ticket_types_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events"."tickets" ADD CONSTRAINT "tickets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "events"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events"."tickets" ADD CONSTRAINT "tickets_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "events"."ticket_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events"."tickets" ADD CONSTRAINT "tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "events"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_events_creator" ON "events"."events" USING btree ("creator_did");--> statement-breakpoint
CREATE INDEX "idx_events_status" ON "events"."events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_events_starts" ON "events"."events" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "idx_events_pod_id" ON "events"."events" USING btree ("pod_id");--> statement-breakpoint
CREATE INDEX "idx_events_course_slug" ON "events"."events" USING btree ("course_slug");--> statement-breakpoint
CREATE INDEX "idx_orders_event" ON "events"."orders" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_orders_buyer" ON "events"."orders" USING btree ("buyer_did");--> statement-breakpoint
CREATE INDEX "idx_orders_stripe_session" ON "events"."orders" USING btree ("stripe_session_id");--> statement-breakpoint
CREATE INDEX "idx_orders_status" ON "events"."orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_pledges_event" ON "events"."pledges" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_pledges_backer" ON "events"."pledges" USING btree ("backer_did");--> statement-breakpoint
CREATE INDEX "idx_pledges_status" ON "events"."pledges" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ticket_queue_type" ON "events"."ticket_queue" USING btree ("ticket_type_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_queue_did" ON "events"."ticket_queue" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_ticket_queue_position" ON "events"."ticket_queue" USING btree ("position");--> statement-breakpoint
CREATE INDEX "idx_ticket_queue_status" ON "events"."ticket_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ticket_transfers_ticket" ON "events"."ticket_transfers" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_transfers_from" ON "events"."ticket_transfers" USING btree ("from_did");--> statement-breakpoint
CREATE INDEX "idx_ticket_transfers_to" ON "events"."ticket_transfers" USING btree ("to_did");--> statement-breakpoint
CREATE INDEX "idx_ticket_types_event" ON "events"."ticket_types" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_event" ON "events"."tickets" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_owner" ON "events"."tickets" USING btree ("owner_did");--> statement-breakpoint
CREATE INDEX "idx_tickets_status" ON "events"."tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tickets_held_by" ON "events"."tickets" USING btree ("held_by");--> statement-breakpoint
CREATE INDEX "idx_tickets_order" ON "events"."tickets" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_registration_status" ON "events"."tickets" USING btree ("registration_status");