export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      agency_property_outcomes: {
        Row: {
          agency_id: string
          created_at: string
          days_on_market: number | null
          fee_generated: number | null
          final_sale_price: number | null
          id: number
          initial_asking_price: number | null
          mandate_status: string | null
          municipality: string | null
          neighborhood: string | null
          notes: string | null
          offers_count: number | null
          owner_objections: Json | null
          property_id: string | null
          property_type: string | null
          updated_at: string
          visits_count: number | null
        }
        Insert: {
          agency_id: string
          created_at?: string
          days_on_market?: number | null
          fee_generated?: number | null
          final_sale_price?: number | null
          id?: number
          initial_asking_price?: number | null
          mandate_status?: string | null
          municipality?: string | null
          neighborhood?: string | null
          notes?: string | null
          offers_count?: number | null
          owner_objections?: Json | null
          property_id?: string | null
          property_type?: string | null
          updated_at?: string
          visits_count?: number | null
        }
        Update: {
          agency_id?: string
          created_at?: string
          days_on_market?: number | null
          fee_generated?: number | null
          final_sale_price?: number | null
          id?: number
          initial_asking_price?: number | null
          mandate_status?: string | null
          municipality?: string | null
          neighborhood?: string | null
          notes?: string | null
          offers_count?: number | null
          owner_objections?: Json | null
          property_id?: string | null
          property_type?: string | null
          updated_at?: string
          visits_count?: number | null
        }
        Relationships: []
      }
      area_opportunity_scores: {
        Row: {
          components: Json
          computed_at: string
          data_basis: string | null
          id: number
          microzone: string | null
          municipality: string
          province: string
          quality: string
          region: string
          score: number
          temperature: string
        }
        Insert: {
          components?: Json
          computed_at?: string
          data_basis?: string | null
          id?: number
          microzone?: string | null
          municipality: string
          province: string
          quality?: string
          region?: string
          score: number
          temperature: string
        }
        Update: {
          components?: Json
          computed_at?: string
          data_basis?: string | null
          id?: number
          microzone?: string | null
          municipality?: string
          province?: string
          quality?: string
          region?: string
          score?: number
          temperature?: string
        }
        Relationships: []
      }
      auction_signals: {
        Row: {
          base_price_eur: number | null
          cap: string | null
          data_basis: string | null
          detected_at: string
          fingerprint: string
          id: number
          is_active: boolean
          lat: number | null
          lng: number | null
          minimum_offer_eur: number | null
          municipality: string | null
          payload: Json | null
          property_type: string | null
          province: string | null
          quality: string
          sale_date: string | null
          source_name: string
          source_url: string | null
          status: string | null
          updated_at: string
        }
        Insert: {
          base_price_eur?: number | null
          cap?: string | null
          data_basis?: string | null
          detected_at?: string
          fingerprint: string
          id?: number
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          minimum_offer_eur?: number | null
          municipality?: string | null
          payload?: Json | null
          property_type?: string | null
          province?: string | null
          quality?: string
          sale_date?: string | null
          source_name: string
          source_url?: string | null
          status?: string | null
          updated_at?: string
        }
        Update: {
          base_price_eur?: number | null
          cap?: string | null
          data_basis?: string | null
          detected_at?: string
          fingerprint?: string
          id?: number
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          minimum_offer_eur?: number | null
          municipality?: string | null
          payload?: Json | null
          property_type?: string | null
          province?: string | null
          quality?: string
          sale_date?: string | null
          source_name?: string
          source_url?: string | null
          status?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      billing_customers: {
        Row: {
          agency_id: string
          app_id: string
          created_at: string
          email: string | null
          id: number
          stripe_customer_id: string
          updated_at: string
        }
        Insert: {
          agency_id: string
          app_id?: string
          created_at?: string
          email?: string | null
          id?: number
          stripe_customer_id: string
          updated_at?: string
        }
        Update: {
          agency_id?: string
          app_id?: string
          created_at?: string
          email?: string | null
          id?: number
          stripe_customer_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      billing_entitlements: {
        Row: {
          allow_hyperlocal_signals: boolean
          allow_local_buzz: boolean
          allow_pdf_export: boolean
          allow_white_label: boolean
          app_id: string
          created_at: string
          id: number
          monthly_owner_reports: number | null
          monthly_piano_esclusiva: number | null
          monthly_radar: number | null
          monthly_scans: number | null
          plan_key: string
          team_seats: number | null
          updated_at: string
        }
        Insert: {
          allow_hyperlocal_signals?: boolean
          allow_local_buzz?: boolean
          allow_pdf_export?: boolean
          allow_white_label?: boolean
          app_id?: string
          created_at?: string
          id?: number
          monthly_owner_reports?: number | null
          monthly_piano_esclusiva?: number | null
          monthly_radar?: number | null
          monthly_scans?: number | null
          plan_key: string
          team_seats?: number | null
          updated_at?: string
        }
        Update: {
          allow_hyperlocal_signals?: boolean
          allow_local_buzz?: boolean
          allow_pdf_export?: boolean
          allow_white_label?: boolean
          app_id?: string
          created_at?: string
          id?: number
          monthly_owner_reports?: number | null
          monthly_piano_esclusiva?: number | null
          monthly_radar?: number | null
          monthly_scans?: number | null
          plan_key?: string
          team_seats?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      billing_subscriptions: {
        Row: {
          agency_id: string
          app_id: string
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          id: number
          plan_key: string | null
          price_id: string | null
          status: string
          stripe_customer_id: string
          stripe_subscription_id: string
          trial_end: string | null
          updated_at: string
        }
        Insert: {
          agency_id: string
          app_id?: string
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          id?: number
          plan_key?: string | null
          price_id?: string | null
          status: string
          stripe_customer_id: string
          stripe_subscription_id: string
          trial_end?: string | null
          updated_at?: string
        }
        Update: {
          agency_id?: string
          app_id?: string
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          id?: number
          plan_key?: string | null
          price_id?: string | null
          status?: string
          stripe_customer_id?: string
          stripe_subscription_id?: string
          trial_end?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      billing_usage: {
        Row: {
          agency_id: string
          app_id: string
          created_at: string
          hyperlocal_signals_used: number
          id: number
          owner_reports_used: number
          period_key: string
          piano_esclusiva_used: number
          radar_used: number
          scans_used: number
          updated_at: string
          zona_in_movimento_used: number
        }
        Insert: {
          agency_id: string
          app_id?: string
          created_at?: string
          hyperlocal_signals_used?: number
          id?: number
          owner_reports_used?: number
          period_key: string
          piano_esclusiva_used?: number
          radar_used?: number
          scans_used?: number
          updated_at?: string
          zona_in_movimento_used?: number
        }
        Update: {
          agency_id?: string
          app_id?: string
          created_at?: string
          hyperlocal_signals_used?: number
          id?: number
          owner_reports_used?: number
          period_key?: string
          piano_esclusiva_used?: number
          radar_used?: number
          scans_used?: number
          updated_at?: string
          zona_in_movimento_used?: number
        }
        Relationships: []
      }
      civiko_data_quality: {
        Row: {
          id: number
          last_check_at: string
          municipalities_covered: number | null
          notes: string | null
          provinces_covered: string[] | null
          region: string
          rows_demo: number | null
          rows_partial: number | null
          rows_real: number | null
          rows_total: number | null
          table_name: string
        }
        Insert: {
          id?: number
          last_check_at?: string
          municipalities_covered?: number | null
          notes?: string | null
          provinces_covered?: string[] | null
          region?: string
          rows_demo?: number | null
          rows_partial?: number | null
          rows_real?: number | null
          rows_total?: number | null
          table_name: string
        }
        Update: {
          id?: number
          last_check_at?: string
          municipalities_covered?: number | null
          notes?: string | null
          provinces_covered?: string[] | null
          region?: string
          rows_demo?: number | null
          rows_partial?: number | null
          rows_real?: number | null
          rows_total?: number | null
          table_name?: string
        }
        Relationships: []
      }
      classificazione_sismica: {
        Row: {
          codice_istat: string
          comune: string
          id: number
          zona_sismica: number
        }
        Insert: {
          codice_istat: string
          comune: string
          id?: number
          zona_sismica: number
        }
        Update: {
          codice_istat?: string
          comune?: string
          id?: number
          zona_sismica?: number
        }
        Relationships: []
      }
      data_sources: {
        Row: {
          allowed_use: string | null
          coverage_area: string
          created_at: string
          freshness_score: number | null
          id: number
          ingestion_status: string
          last_run_at: string | null
          notes: string | null
          priority: number
          reliability_score: number | null
          requires_key: boolean
          source_name: string
          source_type: string
          updated_at: string
        }
        Insert: {
          allowed_use?: string | null
          coverage_area?: string
          created_at?: string
          freshness_score?: number | null
          id?: number
          ingestion_status?: string
          last_run_at?: string | null
          notes?: string | null
          priority?: number
          reliability_score?: number | null
          requires_key?: boolean
          source_name: string
          source_type: string
          updated_at?: string
        }
        Update: {
          allowed_use?: string | null
          coverage_area?: string
          created_at?: string
          freshness_score?: number | null
          id?: number
          ingestion_status?: string
          last_run_at?: string | null
          notes?: string | null
          priority?: number
          reliability_score?: number | null
          requires_key?: boolean
          source_name?: string
          source_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      ingestion_runs: {
        Row: {
          completed_at: string | null
          duration_ms: number | null
          errors: Json | null
          id: number
          job_name: string
          report: Json | null
          rows_in: number | null
          rows_out: number | null
          source_name: string | null
          started_at: string
          status: string
          warnings: Json | null
        }
        Insert: {
          completed_at?: string | null
          duration_ms?: number | null
          errors?: Json | null
          id?: number
          job_name: string
          report?: Json | null
          rows_in?: number | null
          rows_out?: number | null
          source_name?: string | null
          started_at?: string
          status?: string
          warnings?: Json | null
        }
        Update: {
          completed_at?: string | null
          duration_ms?: number | null
          errors?: Json | null
          id?: number
          job_name?: string
          report?: Json | null
          rows_in?: number | null
          rows_out?: number | null
          source_name?: string | null
          started_at?: string
          status?: string
          warnings?: Json | null
        }
        Relationships: []
      }
      ispra_rischio: {
        Row: {
          codice_istat: string
          comune: string
          frana_p1_perc: number | null
          frana_p2_perc: number | null
          frana_p3_perc: number | null
          frana_p4_perc: number | null
          id: number
          idro_p1_perc: number | null
          idro_p2_perc: number | null
          idro_p3_perc: number | null
          pop_frana_p3p4: number | null
          pop_idro_p1: number | null
          pop_idro_p2: number | null
          pop_idro_p3: number | null
          superficie_kmq: number | null
        }
        Insert: {
          codice_istat: string
          comune: string
          frana_p1_perc?: number | null
          frana_p2_perc?: number | null
          frana_p3_perc?: number | null
          frana_p4_perc?: number | null
          id?: number
          idro_p1_perc?: number | null
          idro_p2_perc?: number | null
          idro_p3_perc?: number | null
          pop_frana_p3p4?: number | null
          pop_idro_p1?: number | null
          pop_idro_p2?: number | null
          pop_idro_p3?: number | null
          superficie_kmq?: number | null
        }
        Update: {
          codice_istat?: string
          comune?: string
          frana_p1_perc?: number | null
          frana_p2_perc?: number | null
          frana_p3_perc?: number | null
          frana_p4_perc?: number | null
          id?: number
          idro_p1_perc?: number | null
          idro_p2_perc?: number | null
          idro_p3_perc?: number | null
          pop_frana_p3p4?: number | null
          pop_idro_p1?: number | null
          pop_idro_p2?: number | null
          pop_idro_p3?: number | null
          superficie_kmq?: number | null
        }
        Relationships: []
      }
      istat_comuni: {
        Row: {
          anno: number | null
          codice_istat: string
          comune: string
          eta_media: number | null
          femmine: number | null
          id: number
          indice_vecchiaia: number | null
          maschi: number | null
          percentuale_75_84: number | null
          percentuale_over65: number | null
          percentuale_over85: number | null
          percentuale_under18: number | null
          percentuale_under35: number | null
          popolazione: number | null
          provincia: string | null
          regione: string | null
        }
        Insert: {
          anno?: number | null
          codice_istat: string
          comune: string
          eta_media?: number | null
          femmine?: number | null
          id?: number
          indice_vecchiaia?: number | null
          maschi?: number | null
          percentuale_75_84?: number | null
          percentuale_over65?: number | null
          percentuale_over85?: number | null
          percentuale_under18?: number | null
          percentuale_under35?: number | null
          popolazione?: number | null
          provincia?: string | null
          regione?: string | null
        }
        Update: {
          anno?: number | null
          codice_istat?: string
          comune?: string
          eta_media?: number | null
          femmine?: number | null
          id?: number
          indice_vecchiaia?: number | null
          maschi?: number | null
          percentuale_75_84?: number | null
          percentuale_over65?: number | null
          percentuale_over85?: number | null
          percentuale_under18?: number | null
          percentuale_under35?: number | null
          popolazione?: number | null
          provincia?: string | null
          regione?: string | null
        }
        Relationships: []
      }
      listing_bridge_jobs: {
        Row: {
          created_at: string
          delivered_at: string | null
          error_message: string | null
          id: string
          listing_id: string
          payload: Json
          retry_count: number
          run_id: string
          schema_version: string
          sottra_payload: Json | null
          sottra_response: Json | null
          source_app: string
          source_environment: string | null
          status: string
          trace_id: string
          updated_at: string
          warnings: string[] | null
        }
        Insert: {
          created_at?: string
          delivered_at?: string | null
          error_message?: string | null
          id?: string
          listing_id: string
          payload: Json
          retry_count?: number
          run_id: string
          schema_version?: string
          sottra_payload?: Json | null
          sottra_response?: Json | null
          source_app?: string
          source_environment?: string | null
          status?: string
          trace_id: string
          updated_at?: string
          warnings?: string[] | null
        }
        Update: {
          created_at?: string
          delivered_at?: string | null
          error_message?: string | null
          id?: string
          listing_id?: string
          payload?: Json
          retry_count?: number
          run_id?: string
          schema_version?: string
          sottra_payload?: Json | null
          sottra_response?: Json | null
          source_app?: string
          source_environment?: string | null
          status?: string
          trace_id?: string
          updated_at?: string
          warnings?: string[] | null
        }
        Relationships: []
      }
      listing_identity: {
        Row: {
          agencies_seen: string[]
          first_seen_at: string
          id: number
          identity_hash: string
          last_seen_at: string
          lat_rounded: number | null
          listing_ids_seen: string[]
          lng_rounded: number | null
          municipality: string | null
          observation_count: number
          property_type: string | null
          province: string | null
          rooms: number | null
          sources_seen: string[]
          surface_sqm: number | null
        }
        Insert: {
          agencies_seen?: string[]
          first_seen_at?: string
          id?: number
          identity_hash: string
          last_seen_at?: string
          lat_rounded?: number | null
          listing_ids_seen?: string[]
          lng_rounded?: number | null
          municipality?: string | null
          observation_count?: number
          property_type?: string | null
          province?: string | null
          rooms?: number | null
          sources_seen?: string[]
          surface_sqm?: number | null
        }
        Update: {
          agencies_seen?: string[]
          first_seen_at?: string
          id?: number
          identity_hash?: string
          last_seen_at?: string
          lat_rounded?: number | null
          listing_ids_seen?: string[]
          lng_rounded?: number | null
          municipality?: string | null
          observation_count?: number
          property_type?: string | null
          province?: string | null
          rooms?: number | null
          sources_seen?: string[]
          surface_sqm?: number | null
        }
        Relationships: []
      }
      listing_price_snapshots: {
        Row: {
          agency_name: string | null
          captured_at: string
          created_at: string
          first_seen_at: string | null
          id: number
          identity_hash: string | null
          lat: number | null
          listing_id: string
          lng: number | null
          municipality: string | null
          price_eur: number | null
          property_type: string | null
          province: string | null
          raw_address: string | null
          raw_title: string | null
          rooms: number | null
          source: string
          surface_sqm: number | null
          url: string
        }
        Insert: {
          agency_name?: string | null
          captured_at?: string
          created_at?: string
          first_seen_at?: string | null
          id?: number
          identity_hash?: string | null
          lat?: number | null
          listing_id: string
          lng?: number | null
          municipality?: string | null
          price_eur?: number | null
          property_type?: string | null
          province?: string | null
          raw_address?: string | null
          raw_title?: string | null
          rooms?: number | null
          source: string
          surface_sqm?: number | null
          url: string
        }
        Update: {
          agency_name?: string | null
          captured_at?: string
          created_at?: string
          first_seen_at?: string | null
          id?: number
          identity_hash?: string | null
          lat?: number | null
          listing_id?: string
          lng?: number | null
          municipality?: string | null
          price_eur?: number | null
          property_type?: string | null
          province?: string | null
          raw_address?: string | null
          raw_title?: string | null
          rooms?: number | null
          source?: string
          surface_sqm?: number | null
          url?: string
        }
        Relationships: []
      }
      local_signals: {
        Row: {
          category: string | null
          commercial_use: string | null
          confidence: string
          created_at: string
          detected_at: string
          evidence_url: string | null
          expires_at: string | null
          id: number
          is_active: boolean
          lat: number | null
          lng: number | null
          location_text: string | null
          municipality: string | null
          neighborhood: string | null
          published_at: string | null
          radius_meters: number | null
          signal_tone: string
          source_id: number | null
          source_level: number
          summary: string | null
          title: string
          updated_at: string
          use_in_report: boolean
        }
        Insert: {
          category?: string | null
          commercial_use?: string | null
          confidence?: string
          created_at?: string
          detected_at?: string
          evidence_url?: string | null
          expires_at?: string | null
          id?: number
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          location_text?: string | null
          municipality?: string | null
          neighborhood?: string | null
          published_at?: string | null
          radius_meters?: number | null
          signal_tone?: string
          source_id?: number | null
          source_level?: number
          summary?: string | null
          title: string
          updated_at?: string
          use_in_report?: boolean
        }
        Update: {
          category?: string | null
          commercial_use?: string | null
          confidence?: string
          created_at?: string
          detected_at?: string
          evidence_url?: string | null
          expires_at?: string | null
          id?: number
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          location_text?: string | null
          municipality?: string | null
          neighborhood?: string | null
          published_at?: string | null
          radius_meters?: number | null
          signal_tone?: string
          source_id?: number | null
          source_level?: number
          summary?: string | null
          title?: string
          updated_at?: string
          use_in_report?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "local_signals_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "local_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      local_sources: {
        Row: {
          allowed_usage: string | null
          created_at: string
          id: number
          is_active: boolean
          last_checked_at: string | null
          level: number
          municipality: string | null
          name: string
          refresh_frequency: string | null
          reliability_score: number | null
          source_owner: string | null
          type: string
          updated_at: string
          url: string | null
        }
        Insert: {
          allowed_usage?: string | null
          created_at?: string
          id?: number
          is_active?: boolean
          last_checked_at?: string | null
          level: number
          municipality?: string | null
          name: string
          refresh_frequency?: string | null
          reliability_score?: number | null
          source_owner?: string | null
          type: string
          updated_at?: string
          url?: string | null
        }
        Update: {
          allowed_usage?: string | null
          created_at?: string
          id?: number
          is_active?: boolean
          last_checked_at?: string | null
          level?: number
          municipality?: string | null
          name?: string
          refresh_frequency?: string | null
          reliability_score?: number | null
          source_owner?: string | null
          type?: string
          updated_at?: string
          url?: string | null
        }
        Relationships: []
      }
      market_anomalies: {
        Row: {
          anomaly_type: string
          confidence: string
          detected_at: string
          expires_at: string | null
          id: number
          identity_hash: string
          is_active: boolean
          municipality: string | null
          payload: Json
          province: string | null
        }
        Insert: {
          anomaly_type: string
          confidence?: string
          detected_at?: string
          expires_at?: string | null
          id?: number
          identity_hash: string
          is_active?: boolean
          municipality?: string | null
          payload?: Json
          province?: string | null
        }
        Update: {
          anomaly_type?: string
          confidence?: string
          detected_at?: string
          expires_at?: string | null
          id?: number
          identity_hash?: string
          is_active?: boolean
          municipality?: string | null
          payload?: Json
          province?: string | null
        }
        Relationships: []
      }
      mim_schools: {
        Row: {
          cap: string | null
          codice_istat: string | null
          codice_meccanografico: string
          comune: string
          created_at: string | null
          denominazione: string
          grado: string
          id: number
          indirizzo: string | null
          lat: number | null
          lng: number | null
          provincia: string
          regione: string | null
          tipologia: string | null
        }
        Insert: {
          cap?: string | null
          codice_istat?: string | null
          codice_meccanografico: string
          comune: string
          created_at?: string | null
          denominazione: string
          grado: string
          id?: never
          indirizzo?: string | null
          lat?: number | null
          lng?: number | null
          provincia: string
          regione?: string | null
          tipologia?: string | null
        }
        Update: {
          cap?: string | null
          codice_istat?: string | null
          codice_meccanografico?: string
          comune?: string
          created_at?: string | null
          denominazione?: string
          grado?: string
          id?: never
          indirizzo?: string | null
          lat?: number | null
          lng?: number | null
          provincia?: string
          regione?: string | null
          tipologia?: string | null
        }
        Relationships: []
      }
      motivated_sellers: {
        Row: {
          days_online: number
          detected_at: string
          drops_count: number
          fatigue_label: string
          fatigue_score: number
          first_seen_at: string
          id: number
          identity_hash: string
          initial_price_eur: number | null
          is_active: boolean
          last_price_eur: number | null
          listing_id: string | null
          municipality: string | null
          payload: Json
          province: string | null
          source: string | null
          total_drop_pct: number | null
          url: string | null
        }
        Insert: {
          days_online?: number
          detected_at?: string
          drops_count?: number
          fatigue_label: string
          fatigue_score?: number
          first_seen_at: string
          id?: number
          identity_hash: string
          initial_price_eur?: number | null
          is_active?: boolean
          last_price_eur?: number | null
          listing_id?: string | null
          municipality?: string | null
          payload?: Json
          province?: string | null
          source?: string | null
          total_drop_pct?: number | null
          url?: string | null
        }
        Update: {
          days_online?: number
          detected_at?: string
          drops_count?: number
          fatigue_label?: string
          fatigue_score?: number
          first_seen_at?: string
          id?: number
          identity_hash?: string
          initial_price_eur?: number | null
          is_active?: boolean
          last_price_eur?: number | null
          listing_id?: string | null
          municipality?: string | null
          payload?: Json
          province?: string | null
          source?: string | null
          total_drop_pct?: number | null
          url?: string | null
        }
        Relationships: []
      }
      obituaries_seen: {
        Row: {
          cap: string | null
          captured_at: string
          death_date: string | null
          fingerprint: string
          id: number
          lat: number | null
          lng: number | null
          municipality: string
          omi_link_zona: string | null
          omi_tipologia: string | null
          omi_zona_descr: string | null
          province: string | null
          source_id: number | null
          source_url: string | null
          surname: string
        }
        Insert: {
          cap?: string | null
          captured_at?: string
          death_date?: string | null
          fingerprint: string
          id?: number
          lat?: number | null
          lng?: number | null
          municipality: string
          omi_link_zona?: string | null
          omi_tipologia?: string | null
          omi_zona_descr?: string | null
          province?: string | null
          source_id?: number | null
          source_url?: string | null
          surname: string
        }
        Update: {
          cap?: string | null
          captured_at?: string
          death_date?: string | null
          fingerprint?: string
          id?: number
          lat?: number | null
          lng?: number | null
          municipality?: string
          omi_link_zona?: string | null
          omi_tipologia?: string | null
          omi_zona_descr?: string | null
          province?: string | null
          source_id?: number | null
          source_url?: string | null
          surname?: string
        }
        Relationships: []
      }
      obituaries_sources: {
        Row: {
          base_url: string
          created_at: string
          id: number
          is_active: boolean
          last_used_at: string | null
          name: string
          region: string | null
          reliability_score: number | null
          search_url_template: string
          source_type: string
        }
        Insert: {
          base_url: string
          created_at?: string
          id?: number
          is_active?: boolean
          last_used_at?: string | null
          name: string
          region?: string | null
          reliability_score?: number | null
          search_url_template: string
          source_type?: string
        }
        Update: {
          base_url?: string
          created_at?: string
          id?: number
          is_active?: boolean
          last_used_at?: string | null
          name?: string
          region?: string | null
          reliability_score?: number | null
          search_url_template?: string
          source_type?: string
        }
        Relationships: []
      }
      omi_import_jobs: {
        Row: {
          batch_size: number
          clear_first: boolean
          completed_at: string | null
          comune_istat_fallback: string | null
          current_offset: number
          has_more: boolean
          id: number
          last_error: string | null
          semestre: string
          started_at: string
          status: string
          storage_path: string
          total_errors: number
          total_files_processed: number
          total_files_seen: number
          total_geometries_imported: number
          updated_at: string
        }
        Insert: {
          batch_size?: number
          clear_first?: boolean
          completed_at?: string | null
          comune_istat_fallback?: string | null
          current_offset?: number
          has_more?: boolean
          id?: never
          last_error?: string | null
          semestre?: string
          started_at?: string
          status?: string
          storage_path: string
          total_errors?: number
          total_files_processed?: number
          total_files_seen?: number
          total_geometries_imported?: number
          updated_at?: string
        }
        Update: {
          batch_size?: number
          clear_first?: boolean
          completed_at?: string | null
          comune_istat_fallback?: string | null
          current_offset?: number
          has_more?: boolean
          id?: never
          last_error?: string | null
          semestre?: string
          started_at?: string
          status?: string
          storage_path?: string
          total_errors?: number
          total_files_processed?: number
          total_files_seen?: number
          total_geometries_imported?: number
          updated_at?: string
        }
        Relationships: []
      }
      omi_import_log: {
        Row: {
          comuni: string[] | null
          created_at: string
          duration_ms: number | null
          errors: Json | null
          features_imported: number
          features_read: number
          features_skipped: number
          file_type: string
          id: number
          semestre: string | null
          smoke_test_details: Json | null
          smoke_test_passed: boolean | null
          status: string
          storage_path: string
        }
        Insert: {
          comuni?: string[] | null
          created_at?: string
          duration_ms?: number | null
          errors?: Json | null
          features_imported?: number
          features_read?: number
          features_skipped?: number
          file_type?: string
          id?: never
          semestre?: string | null
          smoke_test_details?: Json | null
          smoke_test_passed?: boolean | null
          status?: string
          storage_path: string
        }
        Update: {
          comuni?: string[] | null
          created_at?: string
          duration_ms?: number | null
          errors?: Json | null
          features_imported?: number
          features_read?: number
          features_skipped?: number
          file_type?: string
          id?: never
          semestre?: string | null
          smoke_test_details?: Json | null
          smoke_test_passed?: boolean | null
          status?: string
          storage_path?: string
        }
        Relationships: []
      }
      omi_valori: {
        Row: {
          area_territoriale: string | null
          cod_tip: number | null
          compr_max: number | null
          compr_min: number | null
          comune_amm: string | null
          comune_catastale: string | null
          comune_descrizione: string
          comune_istat: string
          created_at: string | null
          descr_tipologia: string
          fascia: string | null
          id: number
          link_zona: string
          loc_max: number | null
          loc_min: number | null
          provincia: string
          regione: string | null
          semestre: string | null
          sezione: string | null
          stato: string | null
          stato_prev: string | null
          sup_nl_compr: string | null
          sup_nl_loc: string | null
          zona: string
        }
        Insert: {
          area_territoriale?: string | null
          cod_tip?: number | null
          compr_max?: number | null
          compr_min?: number | null
          comune_amm?: string | null
          comune_catastale?: string | null
          comune_descrizione: string
          comune_istat: string
          created_at?: string | null
          descr_tipologia: string
          fascia?: string | null
          id?: number
          link_zona: string
          loc_max?: number | null
          loc_min?: number | null
          provincia: string
          regione?: string | null
          semestre?: string | null
          sezione?: string | null
          stato?: string | null
          stato_prev?: string | null
          sup_nl_compr?: string | null
          sup_nl_loc?: string | null
          zona: string
        }
        Update: {
          area_territoriale?: string | null
          cod_tip?: number | null
          compr_max?: number | null
          compr_min?: number | null
          comune_amm?: string | null
          comune_catastale?: string | null
          comune_descrizione?: string
          comune_istat?: string
          created_at?: string | null
          descr_tipologia?: string
          fascia?: string | null
          id?: number
          link_zona?: string
          loc_max?: number | null
          loc_min?: number | null
          provincia?: string
          regione?: string | null
          semestre?: string | null
          sezione?: string | null
          stato?: string | null
          stato_prev?: string | null
          sup_nl_compr?: string | null
          sup_nl_loc?: string | null
          zona?: string
        }
        Relationships: []
      }
      omi_zone: {
        Row: {
          area_territoriale: string | null
          cod_tip_prev: number | null
          comune_amm: string | null
          comune_catastale: string | null
          comune_descrizione: string
          comune_istat: string
          created_at: string | null
          descr_tip_prev: string | null
          fascia: string | null
          id: number
          link_zona: string
          microzona: number | null
          provincia: string
          regione: string | null
          semestre: string | null
          sezione: string | null
          stato_prev: string | null
          zona: string
          zona_descr: string | null
        }
        Insert: {
          area_territoriale?: string | null
          cod_tip_prev?: number | null
          comune_amm?: string | null
          comune_catastale?: string | null
          comune_descrizione: string
          comune_istat: string
          created_at?: string | null
          descr_tip_prev?: string | null
          fascia?: string | null
          id?: number
          link_zona: string
          microzona?: number | null
          provincia: string
          regione?: string | null
          semestre?: string | null
          sezione?: string | null
          stato_prev?: string | null
          zona: string
          zona_descr?: string | null
        }
        Update: {
          area_territoriale?: string | null
          cod_tip_prev?: number | null
          comune_amm?: string | null
          comune_catastale?: string | null
          comune_descrizione?: string
          comune_istat?: string
          created_at?: string | null
          descr_tip_prev?: string | null
          fascia?: string | null
          id?: number
          link_zona?: string
          microzona?: number | null
          provincia?: string
          regione?: string | null
          semestre?: string | null
          sezione?: string | null
          stato_prev?: string | null
          zona?: string
          zona_descr?: string | null
        }
        Relationships: []
      }
      omi_zone_geometry: {
        Row: {
          comune_descrizione: string
          comune_istat: string
          created_at: string | null
          geom: unknown
          id: number
          link_zona: string
          provincia: string
          semestre: string | null
          zona: string
          zona_descr: string | null
        }
        Insert: {
          comune_descrizione: string
          comune_istat: string
          created_at?: string | null
          geom: unknown
          id?: never
          link_zona: string
          provincia: string
          semestre?: string | null
          zona: string
          zona_descr?: string | null
        }
        Update: {
          comune_descrizione?: string
          comune_istat?: string
          created_at?: string | null
          geom?: unknown
          id?: never
          link_zona?: string
          provincia?: string
          semestre?: string | null
          zona?: string
          zona_descr?: string | null
        }
        Relationships: []
      }
      owner_objection_patterns: {
        Row: {
          agency_id: string
          created_at: string
          id: number
          municipality: string | null
          neighborhood: string | null
          objection_text: string | null
          objection_type: string
          source: string
          suggested_response: string | null
          updated_at: string
        }
        Insert: {
          agency_id: string
          created_at?: string
          id?: number
          municipality?: string | null
          neighborhood?: string | null
          objection_text?: string | null
          objection_type: string
          source?: string
          suggested_response?: string | null
          updated_at?: string
        }
        Update: {
          agency_id?: string
          created_at?: string
          id?: number
          municipality?: string | null
          neighborhood?: string | null
          objection_text?: string | null
          objection_type?: string
          source?: string
          suggested_response?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      price_resistance_index: {
        Row: {
          avg_asking_price_eur: number | null
          avg_gap_pct: number | null
          avg_omi_compr_max_eur: number | null
          computed_at: string
          id: number
          methodology_note: string
          province: string
          region: string
          resistance_label: string | null
          sample_size: number
        }
        Insert: {
          avg_asking_price_eur?: number | null
          avg_gap_pct?: number | null
          avg_omi_compr_max_eur?: number | null
          computed_at?: string
          id?: number
          methodology_note: string
          province: string
          region?: string
          resistance_label?: string | null
          sample_size: number
        }
        Update: {
          avg_asking_price_eur?: number | null
          avg_gap_pct?: number | null
          avg_omi_compr_max_eur?: number | null
          computed_at?: string
          id?: number
          methodology_note?: string
          province?: string
          region?: string
          resistance_label?: string | null
          sample_size?: number
        }
        Relationships: []
      }
      property_id_registry: {
        Row: {
          created_at: string
          id: number
          last_seen_at: string
          lat_scaled: number
          lng_scaled: number
          opaque_id: string
        }
        Insert: {
          created_at?: string
          id?: number
          last_seen_at?: string
          lat_scaled: number
          lng_scaled: number
          opaque_id: string
        }
        Update: {
          created_at?: string
          id?: number
          last_seen_at?: string
          lat_scaled?: number
          lng_scaled?: number
          opaque_id?: string
        }
        Relationships: []
      }
      property_signal_matches: {
        Row: {
          created_at: string
          distance_meters: number | null
          id: number
          match_reason: string | null
          property_id: string
          recommended_use: string | null
          relevance_score: number | null
          signal_id: number
          visible_in_owner_report: boolean
        }
        Insert: {
          created_at?: string
          distance_meters?: number | null
          id?: number
          match_reason?: string | null
          property_id: string
          recommended_use?: string | null
          relevance_score?: number | null
          signal_id: number
          visible_in_owner_report?: boolean
        }
        Update: {
          created_at?: string
          distance_meters?: number | null
          id?: number
          match_reason?: string | null
          property_id?: string
          recommended_use?: string | null
          relevance_score?: number | null
          signal_id?: number
          visible_in_owner_report?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "property_signal_matches_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "local_signals"
            referencedColumns: ["id"]
          },
        ]
      }
      radar_run_log: {
        Row: {
          agency_id: string | null
          completed_at: string | null
          duration_ms: number | null
          error_message: string | null
          id: number
          module: string
          municipality: string | null
          region: string
          results_count: number
          started_at: string
          status: string
          warnings: Json | null
        }
        Insert: {
          agency_id?: string | null
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          id?: number
          module: string
          municipality?: string | null
          region?: string
          results_count?: number
          started_at?: string
          status: string
          warnings?: Json | null
        }
        Update: {
          agency_id?: string | null
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          id?: number
          module?: string
          municipality?: string | null
          region?: string
          results_count?: number
          started_at?: string
          status?: string
          warnings?: Json | null
        }
        Relationships: []
      }
      radar_signals: {
        Row: {
          agency_id: string | null
          confidence: string
          description: string | null
          detected_at: string
          evidence_url: string | null
          expires_at: string | null
          fingerprint: string
          id: number
          is_active: boolean
          lat: number | null
          lng: number | null
          municipality: string | null
          payload: Json | null
          province: string | null
          signal_type: string
          source: string | null
          title: string
          urgency: string
        }
        Insert: {
          agency_id?: string | null
          confidence?: string
          description?: string | null
          detected_at?: string
          evidence_url?: string | null
          expires_at?: string | null
          fingerprint: string
          id?: number
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          municipality?: string | null
          payload?: Json | null
          province?: string | null
          signal_type: string
          source?: string | null
          title: string
          urgency?: string
        }
        Update: {
          agency_id?: string | null
          confidence?: string
          description?: string | null
          detected_at?: string
          evidence_url?: string | null
          expires_at?: string | null
          fingerprint?: string
          id?: number
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          municipality?: string | null
          payload?: Json | null
          province?: string | null
          signal_type?: string
          source?: string | null
          title?: string
          urgency?: string
        }
        Relationships: []
      }
      source_documents: {
        Row: {
          classification: string | null
          comune: string | null
          confidence_score: number | null
          content_hash: string | null
          created_at: string
          data_basis: string | null
          doc_type: string | null
          extracted_entities: Json | null
          fetched_at: string
          freshness_score: number | null
          id: number
          import_reason: string | null
          importability: boolean | null
          markdown: string | null
          metadata: Json | null
          provincia: string | null
          published_at: string | null
          quality: string | null
          raw_hash: string | null
          relevance_score: number | null
          source_name: string
          source_type: string | null
          source_url: string | null
          text_excerpt: string | null
          title: string | null
          url: string | null
        }
        Insert: {
          classification?: string | null
          comune?: string | null
          confidence_score?: number | null
          content_hash?: string | null
          created_at?: string
          data_basis?: string | null
          doc_type?: string | null
          extracted_entities?: Json | null
          fetched_at?: string
          freshness_score?: number | null
          id?: number
          import_reason?: string | null
          importability?: boolean | null
          markdown?: string | null
          metadata?: Json | null
          provincia?: string | null
          published_at?: string | null
          quality?: string | null
          raw_hash?: string | null
          relevance_score?: number | null
          source_name: string
          source_type?: string | null
          source_url?: string | null
          text_excerpt?: string | null
          title?: string | null
          url?: string | null
        }
        Update: {
          classification?: string | null
          comune?: string | null
          confidence_score?: number | null
          content_hash?: string | null
          created_at?: string
          data_basis?: string | null
          doc_type?: string | null
          extracted_entities?: Json | null
          fetched_at?: string
          freshness_score?: number | null
          id?: number
          import_reason?: string | null
          importability?: boolean | null
          markdown?: string | null
          metadata?: Json | null
          provincia?: string | null
          published_at?: string | null
          quality?: string | null
          raw_hash?: string | null
          relevance_score?: number | null
          source_name?: string
          source_type?: string | null
          source_url?: string | null
          text_excerpt?: string | null
          title?: string | null
          url?: string | null
        }
        Relationships: []
      }
      source_fetch_logs: {
        Row: {
          duration_ms: number | null
          error: string | null
          fetched_at: string
          id: number
          ok: boolean | null
          source_name: string
          status_code: number | null
          url: string | null
        }
        Insert: {
          duration_ms?: number | null
          error?: string | null
          fetched_at?: string
          id?: number
          ok?: boolean | null
          source_name: string
          status_code?: number | null
          url?: string | null
        }
        Update: {
          duration_ms?: number | null
          error?: string | null
          fetched_at?: string
          id?: number
          ok?: boolean | null
          source_name?: string
          status_code?: number | null
          url?: string | null
        }
        Relationships: []
      }
      succession_heatmap_cap: {
        Row: {
          cap: string
          computed_at: string
          id: number
          indice_vecchiaia_avg: number | null
          municipality_main: string | null
          obituaries_90d: number
          payload: Json
          pct_residential_omi: number | null
          probability_label: string
          probability_score: number
          province: string | null
          region: string
        }
        Insert: {
          cap: string
          computed_at?: string
          id?: number
          indice_vecchiaia_avg?: number | null
          municipality_main?: string | null
          obituaries_90d?: number
          payload?: Json
          pct_residential_omi?: number | null
          probability_label: string
          probability_score: number
          province?: string | null
          region?: string
        }
        Update: {
          cap?: string
          computed_at?: string
          id?: number
          indice_vecchiaia_avg?: number | null
          municipality_main?: string | null
          obituaries_90d?: number
          payload?: Json
          pct_residential_omi?: number | null
          probability_label?: string
          probability_score?: number
          province?: string | null
          region?: string
        }
        Relationships: []
      }
      territorial_signals: {
        Row: {
          data_basis: string | null
          description: string | null
          detected_at: string
          fingerprint: string
          id: number
          is_active: boolean
          lat: number | null
          lng: number | null
          municipality: string | null
          payload: Json | null
          province: string | null
          quality: string
          signal_type: string
          source_name: string
          title: string | null
        }
        Insert: {
          data_basis?: string | null
          description?: string | null
          detected_at?: string
          fingerprint: string
          id?: number
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          municipality?: string | null
          payload?: Json | null
          province?: string | null
          quality?: string
          signal_type: string
          source_name: string
          title?: string | null
        }
        Update: {
          data_basis?: string | null
          description?: string | null
          detected_at?: string
          fingerprint?: string
          id?: number
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          municipality?: string | null
          payload?: Json | null
          province?: string | null
          quality?: string
          signal_type?: string
          source_name?: string
          title?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      clear_omi_geometry: { Args: never; Returns: undefined }
      insert_omi_geometry: {
        Args: {
          p_comune_descrizione: string
          p_comune_istat: string
          p_geojson: string
          p_link_zona: string
          p_provincia: string
          p_semestre?: string
          p_zona: string
          p_zona_descr: string
        }
        Returns: number
      }
      omi_zone_by_point: {
        Args: { p_lat: number; p_lng: number }
        Returns: {
          comune_descrizione: string
          comune_istat: string
          link_zona: string
          provincia: string
          zona: string
          zona_descr: string
        }[]
      }
      property_registry_lookup: {
        Args: { p_opaque_id: string }
        Returns: {
          lat_scaled: number
          lng_scaled: number
        }[]
      }
      property_registry_upsert: {
        Args: {
          p_lat_scaled: number
          p_lng_scaled: number
          p_opaque_id: string
        }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
