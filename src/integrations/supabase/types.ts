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
      agencies: {
        Row: {
          billing_email: string | null
          created_at: string
          id: string
          name: string
          plan: string | null
          slug: string | null
          status: string
          updated_at: string
        }
        Insert: {
          billing_email?: string | null
          created_at?: string
          id?: string
          name: string
          plan?: string | null
          slug?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          billing_email?: string | null
          created_at?: string
          id?: string
          name?: string
          plan?: string | null
          slug?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      agency_memberships: {
        Row: {
          agency_id: string
          created_at: string
          id: string
          role: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          agency_id: string
          created_at?: string
          id?: string
          role?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          agency_id?: string
          created_at?: string
          id?: string
          role?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agency_memberships_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_operating_areas: {
        Row: {
          agency_id: string | null
          comuni: string[]
          created_at: string
          created_by: string | null
          focus: string[]
          id: string
          is_active: boolean
          is_default: boolean
          label: string | null
          microzones: string[]
          province: string[]
          quartieri: string[]
          radius_km: number | null
          updated_at: string
          user_id: string | null
          workspace_id: string | null
        }
        Insert: {
          agency_id?: string | null
          comuni?: string[]
          created_at?: string
          created_by?: string | null
          focus?: string[]
          id?: string
          is_active?: boolean
          is_default?: boolean
          label?: string | null
          microzones?: string[]
          province?: string[]
          quartieri?: string[]
          radius_km?: number | null
          updated_at?: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          agency_id?: string | null
          comuni?: string[]
          created_at?: string
          created_by?: string | null
          focus?: string[]
          id?: string
          is_active?: boolean
          is_default?: boolean
          label?: string | null
          microzones?: string[]
          province?: string[]
          quartieri?: string[]
          radius_km?: number | null
          updated_at?: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Relationships: []
      }
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
      agency_signal_preferences: {
        Row: {
          agency_id: string | null
          created_at: string
          created_by: string | null
          exclude_auctions: boolean
          exclude_signal_types: string[]
          id: string
          include_green_risk_sentiment: boolean
          include_mobility: boolean
          include_public_alienations: boolean
          include_sensitive_turnover: boolean
          include_sensitive_turnover_aggregated: boolean
          include_services: boolean
          include_signal_types: string[]
          include_tourism: boolean
          include_urban_planning: boolean
          min_confidence: number
          operating_area_id: string | null
          updated_at: string
          user_id: string | null
          workspace_id: string | null
        }
        Insert: {
          agency_id?: string | null
          created_at?: string
          created_by?: string | null
          exclude_auctions?: boolean
          exclude_signal_types?: string[]
          id?: string
          include_green_risk_sentiment?: boolean
          include_mobility?: boolean
          include_public_alienations?: boolean
          include_sensitive_turnover?: boolean
          include_sensitive_turnover_aggregated?: boolean
          include_services?: boolean
          include_signal_types?: string[]
          include_tourism?: boolean
          include_urban_planning?: boolean
          min_confidence?: number
          operating_area_id?: string | null
          updated_at?: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          agency_id?: string | null
          created_at?: string
          created_by?: string | null
          exclude_auctions?: boolean
          exclude_signal_types?: string[]
          id?: string
          include_green_risk_sentiment?: boolean
          include_mobility?: boolean
          include_public_alienations?: boolean
          include_sensitive_turnover?: boolean
          include_sensitive_turnover_aggregated?: boolean
          include_services?: boolean
          include_signal_types?: string[]
          include_tourism?: boolean
          include_urban_planning?: boolean
          min_confidence?: number
          operating_area_id?: string | null
          updated_at?: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agency_signal_preferences_operating_area_id_fkey"
            columns: ["operating_area_id"]
            isOneToOne: false
            referencedRelation: "agency_operating_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      api_credit_thresholds: {
        Row: {
          block_threshold_eur: number
          critical_threshold_eur: number
          id: string
          notes: string | null
          provider: string
          recommended_topup_eur: number
          updated_at: string
          updated_by: string | null
          warning_threshold_eur: number
        }
        Insert: {
          block_threshold_eur?: number
          critical_threshold_eur?: number
          id?: string
          notes?: string | null
          provider: string
          recommended_topup_eur?: number
          updated_at?: string
          updated_by?: string | null
          warning_threshold_eur?: number
        }
        Update: {
          block_threshold_eur?: number
          critical_threshold_eur?: number
          id?: string
          notes?: string | null
          provider?: string
          recommended_topup_eur?: number
          updated_at?: string
          updated_by?: string | null
          warning_threshold_eur?: number
        }
        Relationships: []
      }
      area_opportunity_scores: {
        Row: {
          area_label: string | null
          area_type: string | null
          components: Json
          computed_at: string
          data_basis: string | null
          derivazione: string | null
          id: number
          lat: number | null
          lng: number | null
          microzone: string | null
          municipality: string
          property_types: string[] | null
          province: string
          quality: string
          region: string
          score: number | null
          temperature: string | null
          updated_at: string
        }
        Insert: {
          area_label?: string | null
          area_type?: string | null
          components?: Json
          computed_at?: string
          data_basis?: string | null
          derivazione?: string | null
          id?: number
          lat?: number | null
          lng?: number | null
          microzone?: string | null
          municipality: string
          property_types?: string[] | null
          province: string
          quality?: string
          region?: string
          score?: number | null
          temperature?: string | null
          updated_at?: string
        }
        Update: {
          area_label?: string | null
          area_type?: string | null
          components?: Json
          computed_at?: string
          data_basis?: string | null
          derivazione?: string | null
          id?: number
          lat?: number | null
          lng?: number | null
          microzone?: string | null
          municipality?: string
          property_types?: string[] | null
          province?: string
          quality?: string
          region?: string
          score?: number | null
          temperature?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      auction_discovery_candidates: {
        Row: {
          asset_type: string | null
          auction_date: string | null
          base_price: number | null
          comune: string | null
          confidence_score: number
          created_at: string
          data_basis: string[]
          fingerprint: string
          id: number
          lot_number: string | null
          minimum_offer: number | null
          payload: Json
          pdf_url: string | null
          privacy_redacted: boolean
          procedure_number: string | null
          provincia: string | null
          quality: string
          reject_reason: string | null
          run_id: string
          source_name: string
          source_url: string | null
          status: string
          title: string | null
          tribunal: string | null
        }
        Insert: {
          asset_type?: string | null
          auction_date?: string | null
          base_price?: number | null
          comune?: string | null
          confidence_score?: number
          created_at?: string
          data_basis?: string[]
          fingerprint: string
          id?: number
          lot_number?: string | null
          minimum_offer?: number | null
          payload?: Json
          pdf_url?: string | null
          privacy_redacted?: boolean
          procedure_number?: string | null
          provincia?: string | null
          quality?: string
          reject_reason?: string | null
          run_id: string
          source_name: string
          source_url?: string | null
          status?: string
          title?: string | null
          tribunal?: string | null
        }
        Update: {
          asset_type?: string | null
          auction_date?: string | null
          base_price?: number | null
          comune?: string | null
          confidence_score?: number
          created_at?: string
          data_basis?: string[]
          fingerprint?: string
          id?: number
          lot_number?: string | null
          minimum_offer?: number | null
          payload?: Json
          pdf_url?: string | null
          privacy_redacted?: boolean
          procedure_number?: string | null
          provincia?: string | null
          quality?: string
          reject_reason?: string | null
          run_id?: string
          source_name?: string
          source_url?: string | null
          status?: string
          title?: string | null
          tribunal?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "auction_discovery_candidates_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "auction_discovery_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      auction_discovery_runs: {
        Row: {
          apify_run_ids: Json
          candidates_count: number
          created_at: string
          created_by: string | null
          errors: Json
          finished_at: string | null
          id: string
          importable_count: number
          needs_review_count: number
          params: Json
          report: Json
          sources: Json
          started_at: string
          status: string
          warnings: Json
        }
        Insert: {
          apify_run_ids?: Json
          candidates_count?: number
          created_at?: string
          created_by?: string | null
          errors?: Json
          finished_at?: string | null
          id?: string
          importable_count?: number
          needs_review_count?: number
          params?: Json
          report?: Json
          sources?: Json
          started_at?: string
          status?: string
          warnings?: Json
        }
        Update: {
          apify_run_ids?: Json
          candidates_count?: number
          created_at?: string
          created_by?: string | null
          errors?: Json
          finished_at?: string | null
          id?: string
          importable_count?: number
          needs_review_count?: number
          params?: Json
          report?: Json
          sources?: Json
          started_at?: string
          status?: string
          warnings?: Json
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
      civiko_data_sources: {
        Row: {
          base_url: string | null
          category: string
          code: string
          coverage: string | null
          created_at: string
          description: string | null
          display_order: number
          env_var: string | null
          estimated_cost_eur: number | null
          id: string
          is_active: boolean
          label: string
          notes: string | null
          provider: string | null
          requires_premium_consent: boolean
          status: string
          updated_at: string
        }
        Insert: {
          base_url?: string | null
          category: string
          code: string
          coverage?: string | null
          created_at?: string
          description?: string | null
          display_order?: number
          env_var?: string | null
          estimated_cost_eur?: number | null
          id?: string
          is_active?: boolean
          label: string
          notes?: string | null
          provider?: string | null
          requires_premium_consent?: boolean
          status: string
          updated_at?: string
        }
        Update: {
          base_url?: string | null
          category?: string
          code?: string
          coverage?: string | null
          created_at?: string
          description?: string | null
          display_order?: number
          env_var?: string | null
          estimated_cost_eur?: number | null
          id?: string
          is_active?: boolean
          label?: string
          notes?: string | null
          provider?: string | null
          requires_premium_consent?: boolean
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      civiko_signal_policy: {
        Row: {
          created_at: string
          forbidden_phrases: string[]
          id: number
          notes: string | null
          retention_policy: string
          sensitivity_level: string
          signal_type: string
          updated_at: string
          usable_for_scoring: boolean
          visible_to_agency: boolean
          visible_to_owner: boolean
        }
        Insert: {
          created_at?: string
          forbidden_phrases?: string[]
          id?: number
          notes?: string | null
          retention_policy?: string
          sensitivity_level: string
          signal_type: string
          updated_at?: string
          usable_for_scoring?: boolean
          visible_to_agency?: boolean
          visible_to_owner?: boolean
        }
        Update: {
          created_at?: string
          forbidden_phrases?: string[]
          id?: number
          notes?: string | null
          retention_policy?: string
          sensitivity_level?: string
          signal_type?: string
          updated_at?: string
          usable_for_scoring?: boolean
          visible_to_agency?: boolean
          visible_to_owner?: boolean
        }
        Relationships: []
      }
      civiko_signals_classified: {
        Row: {
          allowed_commercial_phrase: string | null
          collected_at: string
          confidence_level: string
          created_at: string
          forbidden_phrases: string[]
          id: number
          payload: Json
          retention_policy: string
          sensitivity_level: string
          signal_id: string
          signal_type: string
          source_name_internal: string
          updated_at: string
          usable_for_scoring: boolean
          visible_to_agency: boolean
          visible_to_owner: boolean
        }
        Insert: {
          allowed_commercial_phrase?: string | null
          collected_at?: string
          confidence_level?: string
          created_at?: string
          forbidden_phrases?: string[]
          id?: number
          payload?: Json
          retention_policy?: string
          sensitivity_level: string
          signal_id: string
          signal_type: string
          source_name_internal: string
          updated_at?: string
          usable_for_scoring?: boolean
          visible_to_agency?: boolean
          visible_to_owner?: boolean
        }
        Update: {
          allowed_commercial_phrase?: string | null
          collected_at?: string
          confidence_level?: string
          created_at?: string
          forbidden_phrases?: string[]
          id?: number
          payload?: Json
          retention_policy?: string
          sensitivity_level?: string
          signal_id?: string
          signal_type?: string
          source_name_internal?: string
          updated_at?: string
          usable_for_scoring?: boolean
          visible_to_agency?: boolean
          visible_to_owner?: boolean
        }
        Relationships: []
      }
      civiko_source_ingestion_runs: {
        Row: {
          created_at: string
          debug_id: string | null
          duration_ms: number | null
          error_code: string | null
          error_message: string | null
          finished_at: string | null
          id: string
          metadata: Json
          rows_ingested: number | null
          source_code: string
          started_at: string
          status: string
        }
        Insert: {
          created_at?: string
          debug_id?: string | null
          duration_ms?: number | null
          error_code?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          metadata?: Json
          rows_ingested?: number | null
          source_code: string
          started_at?: string
          status: string
        }
        Update: {
          created_at?: string
          debug_id?: string | null
          duration_ms?: number | null
          error_code?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          metadata?: Json
          rows_ingested?: number | null
          source_code?: string
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "civiko_source_ingestion_runs_source_code_fkey"
            columns: ["source_code"]
            isOneToOne: false
            referencedRelation: "civiko_data_sources"
            referencedColumns: ["code"]
          },
        ]
      }
      civiko_source_registry: {
        Row: {
          access_type: string
          activation_mode: string | null
          compliance_level: string
          created_at: string
          freshness_days: number | null
          id: string
          implementation_status: string
          last_error: string | null
          last_success_at: string | null
          notes: string | null
          record_count: number
          refresh_frequency: string | null
          source_code: string
          source_name: string
          source_url: string | null
          updated_at: string
        }
        Insert: {
          access_type: string
          activation_mode?: string | null
          compliance_level: string
          created_at?: string
          freshness_days?: number | null
          id?: string
          implementation_status: string
          last_error?: string | null
          last_success_at?: string | null
          notes?: string | null
          record_count?: number
          refresh_frequency?: string | null
          source_code: string
          source_name: string
          source_url?: string | null
          updated_at?: string
        }
        Update: {
          access_type?: string
          activation_mode?: string | null
          compliance_level?: string
          created_at?: string
          freshness_days?: number | null
          id?: string
          implementation_status?: string
          last_error?: string | null
          last_success_at?: string | null
          notes?: string | null
          record_count?: number
          refresh_frequency?: string | null
          source_code?: string
          source_name?: string
          source_url?: string | null
          updated_at?: string
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
      crawl_watchlist: {
        Row: {
          allowed_use: string | null
          comuni: string[]
          created_at: string
          id: number
          last_crawled_at: string | null
          next_crawl_at: string | null
          notes: string | null
          province: string[]
          source_name: string
          source_type: string
          source_url: string
          status: string
          updated_at: string
          watch_frequency: string
        }
        Insert: {
          allowed_use?: string | null
          comuni?: string[]
          created_at?: string
          id?: number
          last_crawled_at?: string | null
          next_crawl_at?: string | null
          notes?: string | null
          province?: string[]
          source_name: string
          source_type: string
          source_url: string
          status?: string
          updated_at?: string
          watch_frequency?: string
        }
        Update: {
          allowed_use?: string | null
          comuni?: string[]
          created_at?: string
          id?: number
          last_crawled_at?: string | null
          next_crawl_at?: string | null
          notes?: string | null
          province?: string[]
          source_name?: string
          source_type?: string
          source_url?: string
          status?: string
          updated_at?: string
          watch_frequency?: string
        }
        Relationships: []
      }
      data_sources: {
        Row: {
          allowed_paths: string[]
          allowed_use: string | null
          base_url: string | null
          comuni: string[]
          coverage_area: string
          created_at: string
          excluded_paths: string[]
          expected_entities: string[]
          format_expected: string | null
          freshness_score: number | null
          id: number
          ingestion_method: string | null
          ingestion_status: string
          last_run_at: string | null
          notes: string | null
          priority: number
          province: string[]
          quality_default: string
          reliability_score: number | null
          requires_key: boolean
          source_name: string
          source_type: string
          updated_at: string
        }
        Insert: {
          allowed_paths?: string[]
          allowed_use?: string | null
          base_url?: string | null
          comuni?: string[]
          coverage_area?: string
          created_at?: string
          excluded_paths?: string[]
          expected_entities?: string[]
          format_expected?: string | null
          freshness_score?: number | null
          id?: number
          ingestion_method?: string | null
          ingestion_status?: string
          last_run_at?: string | null
          notes?: string | null
          priority?: number
          province?: string[]
          quality_default?: string
          reliability_score?: number | null
          requires_key?: boolean
          source_name: string
          source_type: string
          updated_at?: string
        }
        Update: {
          allowed_paths?: string[]
          allowed_use?: string | null
          base_url?: string | null
          comuni?: string[]
          coverage_area?: string
          created_at?: string
          excluded_paths?: string[]
          expected_entities?: string[]
          format_expected?: string | null
          freshness_score?: number | null
          id?: number
          ingestion_method?: string | null
          ingestion_status?: string
          last_run_at?: string | null
          notes?: string | null
          priority?: number
          province?: string[]
          quality_default?: string
          reliability_score?: number | null
          requires_key?: boolean
          source_name?: string
          source_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      early_offmarket_signal_candidates: {
        Row: {
          agent_action: string | null
          ai_summary: string | null
          amount_text: string | null
          asset_type: string | null
          commercial_value_score: number
          comune: string | null
          confidence_score: number | null
          created_at: string
          data_basis: string | null
          deadline_text: string | null
          fingerprint: string
          id: string
          import_recommendation: string | null
          investor_pitch: string | null
          location_detail: string | null
          needs_review: boolean
          owner_pitch: string | null
          payload: Json | null
          possible_agent_action: string | null
          priority_score: number
          privacy_safe: boolean
          promoted_at: string | null
          promoted_to: string | null
          provincia: string | null
          publication_date: string | null
          quality: string | null
          real_estate_relevance_score: number
          reject_reason: string | null
          rejection_reason: string | null
          review_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          run_id: string | null
          signal_type: string
          source_name: string | null
          source_url: string
          status: string
          summary: string | null
          timing: string | null
          title: string
          why_it_matters: string | null
        }
        Insert: {
          agent_action?: string | null
          ai_summary?: string | null
          amount_text?: string | null
          asset_type?: string | null
          commercial_value_score?: number
          comune?: string | null
          confidence_score?: number | null
          created_at?: string
          data_basis?: string | null
          deadline_text?: string | null
          fingerprint: string
          id?: string
          import_recommendation?: string | null
          investor_pitch?: string | null
          location_detail?: string | null
          needs_review?: boolean
          owner_pitch?: string | null
          payload?: Json | null
          possible_agent_action?: string | null
          priority_score?: number
          privacy_safe?: boolean
          promoted_at?: string | null
          promoted_to?: string | null
          provincia?: string | null
          publication_date?: string | null
          quality?: string | null
          real_estate_relevance_score?: number
          reject_reason?: string | null
          rejection_reason?: string | null
          review_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          run_id?: string | null
          signal_type: string
          source_name?: string | null
          source_url: string
          status?: string
          summary?: string | null
          timing?: string | null
          title: string
          why_it_matters?: string | null
        }
        Update: {
          agent_action?: string | null
          ai_summary?: string | null
          amount_text?: string | null
          asset_type?: string | null
          commercial_value_score?: number
          comune?: string | null
          confidence_score?: number | null
          created_at?: string
          data_basis?: string | null
          deadline_text?: string | null
          fingerprint?: string
          id?: string
          import_recommendation?: string | null
          investor_pitch?: string | null
          location_detail?: string | null
          needs_review?: boolean
          owner_pitch?: string | null
          payload?: Json | null
          possible_agent_action?: string | null
          priority_score?: number
          privacy_safe?: boolean
          promoted_at?: string | null
          promoted_to?: string | null
          provincia?: string | null
          publication_date?: string | null
          quality?: string | null
          real_estate_relevance_score?: number
          reject_reason?: string | null
          rejection_reason?: string | null
          review_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          run_id?: string | null
          signal_type?: string
          source_name?: string | null
          source_url?: string
          status?: string
          summary?: string | null
          timing?: string | null
          title?: string
          why_it_matters?: string | null
        }
        Relationships: []
      }
      early_warning_opportunities: {
        Row: {
          area_label: string | null
          comune: string
          confidence: string
          detected_at: string
          early_acquisition_score: number
          evidence_count: number
          explanation: string | null
          fingerprint: string
          id: number
          identity_hash: string | null
          is_active: boolean
          microzona: string | null
          payload: Json
          primary_signal_type: string
          privacy_safe: boolean
          property_type: string | null
          provincia: string | null
          recommended_action: string | null
          region: string
          secondary_signals: Json
          signal_types: string[]
          source_names: string[]
          source_urls: string[]
          sources_count: number
          title: string
          updated_at: string
          warnings: string[]
        }
        Insert: {
          area_label?: string | null
          comune: string
          confidence?: string
          detected_at?: string
          early_acquisition_score?: number
          evidence_count?: number
          explanation?: string | null
          fingerprint: string
          id?: number
          identity_hash?: string | null
          is_active?: boolean
          microzona?: string | null
          payload?: Json
          primary_signal_type: string
          privacy_safe?: boolean
          property_type?: string | null
          provincia?: string | null
          recommended_action?: string | null
          region?: string
          secondary_signals?: Json
          signal_types?: string[]
          source_names?: string[]
          source_urls?: string[]
          sources_count?: number
          title: string
          updated_at?: string
          warnings?: string[]
        }
        Update: {
          area_label?: string | null
          comune?: string
          confidence?: string
          detected_at?: string
          early_acquisition_score?: number
          evidence_count?: number
          explanation?: string | null
          fingerprint?: string
          id?: number
          identity_hash?: string | null
          is_active?: boolean
          microzona?: string | null
          payload?: Json
          primary_signal_type?: string
          privacy_safe?: boolean
          property_type?: string | null
          provincia?: string | null
          recommended_action?: string | null
          region?: string
          secondary_signals?: Json
          signal_types?: string[]
          source_names?: string[]
          source_urls?: string[]
          sources_count?: number
          title?: string
          updated_at?: string
          warnings?: string[]
        }
        Relationships: []
      }
      estate_turnover_zones: {
        Row: {
          agency_private_only: boolean
          agent_action: string
          area_label: string
          category: string | null
          computed_at: string
          comune: string
          confidence_score: number
          data_basis: string[]
          fingerprint: string
          id: number
          is_active: boolean
          microzona: string | null
          missing_factors: Json
          positive_factors: Json
          provincia: string
          quality: string
          reason: string
          region: string
          requires_review: boolean
          retention_days: number | null
          score: number
          script: string
          source_urls: string[]
          standard_radar_visible: boolean
          temperature: string
          updated_at: string
        }
        Insert: {
          agency_private_only?: boolean
          agent_action: string
          area_label: string
          category?: string | null
          computed_at?: string
          comune: string
          confidence_score?: number
          data_basis?: string[]
          fingerprint: string
          id?: number
          is_active?: boolean
          microzona?: string | null
          missing_factors?: Json
          positive_factors?: Json
          provincia: string
          quality?: string
          reason: string
          region?: string
          requires_review?: boolean
          retention_days?: number | null
          score: number
          script: string
          source_urls?: string[]
          standard_radar_visible?: boolean
          temperature: string
          updated_at?: string
        }
        Update: {
          agency_private_only?: boolean
          agent_action?: string
          area_label?: string
          category?: string | null
          computed_at?: string
          comune?: string
          confidence_score?: number
          data_basis?: string[]
          fingerprint?: string
          id?: number
          is_active?: boolean
          microzona?: string | null
          missing_factors?: Json
          positive_factors?: Json
          provincia?: string
          quality?: string
          reason?: string
          region?: string
          requires_review?: boolean
          retention_days?: number | null
          score?: number
          script?: string
          source_urls?: string[]
          standard_radar_visible?: boolean
          temperature?: string
          updated_at?: string
        }
        Relationships: []
      }
      evidence_source_registry: {
        Row: {
          created_at: string
          default_anticipatory: string
          default_geo_level: string
          default_weight: number
          id: number
          notes: string | null
          priority_rank: number
          privacy_class: string
          source_name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          default_anticipatory?: string
          default_geo_level: string
          default_weight?: number
          id?: number
          notes?: string | null
          priority_rank?: number
          privacy_class?: string
          source_name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          default_anticipatory?: string
          default_geo_level?: string
          default_weight?: number
          id?: number
          notes?: string | null
          priority_rank?: number
          privacy_class?: string
          source_name?: string
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
      inheritance_pressure_signals: {
        Row: {
          agency_private_only: boolean
          area_label: string
          area_type: string
          category: string | null
          computed_at: string
          comune: string
          confidence_score: number
          data_basis: string[]
          fingerprint: string
          id: number
          indicators: Json
          is_active: boolean
          lat: number | null
          lng: number | null
          provincia: string
          quality: string
          region: string
          requires_review: boolean
          retention_days: number | null
          score: number
          signal_basis: string[]
          source_names: string[]
          source_urls: string[]
          standard_radar_visible: boolean
          updated_at: string
        }
        Insert: {
          agency_private_only?: boolean
          area_label: string
          area_type: string
          category?: string | null
          computed_at?: string
          comune: string
          confidence_score?: number
          data_basis?: string[]
          fingerprint: string
          id?: number
          indicators?: Json
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          provincia: string
          quality?: string
          region?: string
          requires_review?: boolean
          retention_days?: number | null
          score: number
          signal_basis?: string[]
          source_names?: string[]
          source_urls?: string[]
          standard_radar_visible?: boolean
          updated_at?: string
        }
        Update: {
          agency_private_only?: boolean
          area_label?: string
          area_type?: string
          category?: string | null
          computed_at?: string
          comune?: string
          confidence_score?: number
          data_basis?: string[]
          fingerprint?: string
          id?: number
          indicators?: Json
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          provincia?: string
          quality?: string
          region?: string
          requires_review?: boolean
          retention_days?: number | null
          score?: number
          signal_basis?: string[]
          source_names?: string[]
          source_urls?: string[]
          standard_radar_visible?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      inheritance_safe_source_documents: {
        Row: {
          classification: string
          comune: string | null
          contains_personal_data: boolean
          extracted_aggregate_indicators: Json
          fetched_at: string
          hash: string
          id: number
          imported_as_aggregate: boolean
          provincia: string | null
          rejected_reason: string | null
          source_name: string
          source_url: string
        }
        Insert: {
          classification: string
          comune?: string | null
          contains_personal_data?: boolean
          extracted_aggregate_indicators?: Json
          fetched_at?: string
          hash: string
          id?: number
          imported_as_aggregate?: boolean
          provincia?: string | null
          rejected_reason?: string | null
          source_name: string
          source_url: string
        }
        Update: {
          classification?: string
          comune?: string | null
          contains_personal_data?: boolean
          extracted_aggregate_indicators?: Json
          fetched_at?: string
          hash?: string
          id?: number
          imported_as_aggregate?: boolean
          provincia?: string | null
          rejected_reason?: string | null
          source_name?: string
          source_url?: string
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
      istat_apr4_mobility: {
        Row: {
          cancellati: number | null
          comune: string
          comune_istat: string
          id: string
          imported_at: string
          iscritti: number | null
          saldo_migratorio: number | null
          source_url: string | null
          transfer_rate: number | null
          year: number
        }
        Insert: {
          cancellati?: number | null
          comune: string
          comune_istat: string
          id?: string
          imported_at?: string
          iscritti?: number | null
          saldo_migratorio?: number | null
          source_url?: string | null
          transfer_rate?: number | null
          year: number
        }
        Update: {
          cancellati?: number | null
          comune?: string
          comune_istat?: string
          id?: string
          imported_at?: string
          iscritti?: number | null
          saldo_migratorio?: number | null
          source_url?: string | null
          transfer_rate?: number | null
          year?: number
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
      istat_separations_padova: {
        Row: {
          comune: string
          comune_istat: string
          divorce_rate: number | null
          divorces_count: number | null
          id: string
          imported_at: string
          marriages_count: number | null
          separation_rate: number | null
          separations_count: number | null
          source_url: string | null
          year: number
        }
        Insert: {
          comune: string
          comune_istat: string
          divorce_rate?: number | null
          divorces_count?: number | null
          id?: string
          imported_at?: string
          marriages_count?: number | null
          separation_rate?: number | null
          separations_count?: number | null
          source_url?: string | null
          year: number
        }
        Update: {
          comune?: string
          comune_istat?: string
          divorce_rate?: number | null
          divorces_count?: number | null
          id?: string
          imported_at?: string
          marriages_count?: number | null
          separation_rate?: number | null
          separations_count?: number | null
          source_url?: string | null
          year?: number
        }
        Relationships: []
      }
      legal_life_event_signals: {
        Row: {
          area_or_microzone: string | null
          confidence: string
          contains_personal_data: boolean
          created_at: string
          dedupe_key: string
          detected_at: string
          event_date: string | null
          explanation: string | null
          id: number
          is_active: boolean
          legal_basis_note: string | null
          municipality: string
          payload_minimized: Json
          pii_redacted: boolean
          privacy_safe: boolean
          property_hint: string | null
          province: string | null
          region: string
          signal_type: string
          source_name: string
          source_url: string | null
          updated_at: string
        }
        Insert: {
          area_or_microzone?: string | null
          confidence?: string
          contains_personal_data?: boolean
          created_at?: string
          dedupe_key: string
          detected_at?: string
          event_date?: string | null
          explanation?: string | null
          id?: number
          is_active?: boolean
          legal_basis_note?: string | null
          municipality: string
          payload_minimized?: Json
          pii_redacted?: boolean
          privacy_safe?: boolean
          property_hint?: string | null
          province?: string | null
          region?: string
          signal_type: string
          source_name: string
          source_url?: string | null
          updated_at?: string
        }
        Update: {
          area_or_microzone?: string | null
          confidence?: string
          contains_personal_data?: boolean
          created_at?: string
          dedupe_key?: string
          detected_at?: string
          event_date?: string | null
          explanation?: string | null
          id?: number
          is_active?: boolean
          legal_basis_note?: string | null
          municipality?: string
          payload_minimized?: Json
          pii_redacted?: boolean
          privacy_safe?: boolean
          property_hint?: string | null
          province?: string | null
          region?: string
          signal_type?: string
          source_name?: string
          source_url?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      legal_property_signals: {
        Row: {
          area_label: string | null
          base_price_eur: number | null
          comune: string | null
          confidence_score: number
          court_or_authority: string | null
          data_basis: string[]
          estimated_asset_type: string | null
          extracted_entities: Json
          fetched_at: string
          fingerprint: string
          id: number
          is_active: boolean
          lat: number | null
          lng: number | null
          minimum_bid_eur: number | null
          payload: Json
          privacy_redacted: boolean
          procedure_date: string | null
          property_type: string | null
          provincia: string | null
          quality: string
          sale_date: string | null
          signal_type: string
          source_document_id: number | null
          source_name: string
          source_url: string | null
          status: string | null
          updated_at: string
        }
        Insert: {
          area_label?: string | null
          base_price_eur?: number | null
          comune?: string | null
          confidence_score?: number
          court_or_authority?: string | null
          data_basis?: string[]
          estimated_asset_type?: string | null
          extracted_entities?: Json
          fetched_at?: string
          fingerprint: string
          id?: number
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          minimum_bid_eur?: number | null
          payload?: Json
          privacy_redacted?: boolean
          procedure_date?: string | null
          property_type?: string | null
          provincia?: string | null
          quality?: string
          sale_date?: string | null
          signal_type: string
          source_document_id?: number | null
          source_name: string
          source_url?: string | null
          status?: string | null
          updated_at?: string
        }
        Update: {
          area_label?: string | null
          base_price_eur?: number | null
          comune?: string | null
          confidence_score?: number
          court_or_authority?: string | null
          data_basis?: string[]
          estimated_asset_type?: string | null
          extracted_entities?: Json
          fetched_at?: string
          fingerprint?: string
          id?: number
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          minimum_bid_eur?: number | null
          payload?: Json
          privacy_redacted?: boolean
          procedure_date?: string | null
          property_type?: string | null
          provincia?: string | null
          quality?: string
          sale_date?: string | null
          signal_type?: string
          source_document_id?: number | null
          source_name?: string
          source_url?: string | null
          status?: string | null
          updated_at?: string
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
      listing_velocity_signals: {
        Row: {
          comune: string | null
          confidence_score: number
          created_at: string
          data_basis: string[]
          days_online: number | null
          detected_at: string
          first_seen_at: string | null
          fresh_listing: boolean
          hours_since_first_seen: number | null
          id: number
          is_active: boolean
          last_seen_at: string | null
          lat: number | null
          listing_hash: string
          lng: number | null
          payload: Json
          previous_price_eur: number | null
          price_drop_percent: number | null
          price_eur: number | null
          price_per_mq: number | null
          property_type: string | null
          provincia: string | null
          quality: string
          repost_detected: boolean
          source_name: string
          source_url: string | null
          stale_listing: boolean
          surface_mq: number | null
          updated_at: string
          velocity_type: string
        }
        Insert: {
          comune?: string | null
          confidence_score?: number
          created_at?: string
          data_basis?: string[]
          days_online?: number | null
          detected_at?: string
          first_seen_at?: string | null
          fresh_listing?: boolean
          hours_since_first_seen?: number | null
          id?: number
          is_active?: boolean
          last_seen_at?: string | null
          lat?: number | null
          listing_hash: string
          lng?: number | null
          payload?: Json
          previous_price_eur?: number | null
          price_drop_percent?: number | null
          price_eur?: number | null
          price_per_mq?: number | null
          property_type?: string | null
          provincia?: string | null
          quality?: string
          repost_detected?: boolean
          source_name: string
          source_url?: string | null
          stale_listing?: boolean
          surface_mq?: number | null
          updated_at?: string
          velocity_type?: string
        }
        Update: {
          comune?: string | null
          confidence_score?: number
          created_at?: string
          data_basis?: string[]
          days_online?: number | null
          detected_at?: string
          first_seen_at?: string | null
          fresh_listing?: boolean
          hours_since_first_seen?: number | null
          id?: number
          is_active?: boolean
          last_seen_at?: string | null
          lat?: number | null
          listing_hash?: string
          lng?: number | null
          payload?: Json
          previous_price_eur?: number | null
          price_drop_percent?: number | null
          price_eur?: number | null
          price_per_mq?: number | null
          property_type?: string | null
          provincia?: string | null
          quality?: string
          repost_detected?: boolean
          source_name?: string
          source_url?: string | null
          stale_listing?: boolean
          surface_mq?: number | null
          updated_at?: string
          velocity_type?: string
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
      luxu_assets: {
        Row: {
          active: boolean | null
          category: string
          city: string | null
          convergent_signal: boolean | null
          country: string | null
          dossier_available: boolean | null
          extraction_confidence: string | null
          first_seen_at: string
          hero_image_url: string | null
          id: string
          last_scan_run_id: string | null
          last_seen_at: string
          location_confidence: string | null
          merge_count: number | null
          merged_sources: Json | null
          missing_fields: string[] | null
          opportunity: string | null
          price_confidence: string | null
          price_eur: number | null
          price_max_eur: number | null
          price_min_eur: number | null
          priority: string
          region: string | null
          risk: string | null
          score: number
          source_category: string
          source_label: string
          source_url: string | null
          surface_sqm: number | null
          times_seen: number | null
          title: string
          why_now: string | null
        }
        Insert: {
          active?: boolean | null
          category: string
          city?: string | null
          convergent_signal?: boolean | null
          country?: string | null
          dossier_available?: boolean | null
          extraction_confidence?: string | null
          first_seen_at?: string
          hero_image_url?: string | null
          id: string
          last_scan_run_id?: string | null
          last_seen_at?: string
          location_confidence?: string | null
          merge_count?: number | null
          merged_sources?: Json | null
          missing_fields?: string[] | null
          opportunity?: string | null
          price_confidence?: string | null
          price_eur?: number | null
          price_max_eur?: number | null
          price_min_eur?: number | null
          priority?: string
          region?: string | null
          risk?: string | null
          score?: number
          source_category: string
          source_label: string
          source_url?: string | null
          surface_sqm?: number | null
          times_seen?: number | null
          title: string
          why_now?: string | null
        }
        Update: {
          active?: boolean | null
          category?: string
          city?: string | null
          convergent_signal?: boolean | null
          country?: string | null
          dossier_available?: boolean | null
          extraction_confidence?: string | null
          first_seen_at?: string
          hero_image_url?: string | null
          id?: string
          last_scan_run_id?: string | null
          last_seen_at?: string
          location_confidence?: string | null
          merge_count?: number | null
          merged_sources?: Json | null
          missing_fields?: string[] | null
          opportunity?: string | null
          price_confidence?: string | null
          price_eur?: number | null
          price_max_eur?: number | null
          price_min_eur?: number | null
          priority?: string
          region?: string | null
          risk?: string | null
          score?: number
          source_category?: string
          source_label?: string
          source_url?: string | null
          surface_sqm?: number | null
          times_seen?: number | null
          title?: string
          why_now?: string | null
        }
        Relationships: []
      }
      luxuradar_assets: {
        Row: {
          category: string
          city: string | null
          country: string
          created_at: string
          dedupe_key: string
          dossier_available: boolean
          hero_image_url: string | null
          id: string
          opportunity: string | null
          price_eur: number | null
          price_max_eur: number | null
          price_min_eur: number | null
          priority: string
          raw_data: Json
          region: string | null
          risk: string | null
          scan_run_id: string | null
          score: number
          source_category: string
          source_label: string
          source_url: string | null
          surface_sqm: number | null
          title: string
          updated_at: string
          why_now: string | null
        }
        Insert: {
          category: string
          city?: string | null
          country?: string
          created_at?: string
          dedupe_key: string
          dossier_available?: boolean
          hero_image_url?: string | null
          id?: string
          opportunity?: string | null
          price_eur?: number | null
          price_max_eur?: number | null
          price_min_eur?: number | null
          priority?: string
          raw_data?: Json
          region?: string | null
          risk?: string | null
          scan_run_id?: string | null
          score?: number
          source_category: string
          source_label: string
          source_url?: string | null
          surface_sqm?: number | null
          title: string
          updated_at?: string
          why_now?: string | null
        }
        Update: {
          category?: string
          city?: string | null
          country?: string
          created_at?: string
          dedupe_key?: string
          dossier_available?: boolean
          hero_image_url?: string | null
          id?: string
          opportunity?: string | null
          price_eur?: number | null
          price_max_eur?: number | null
          price_min_eur?: number | null
          priority?: string
          raw_data?: Json
          region?: string | null
          risk?: string | null
          scan_run_id?: string | null
          score?: number
          source_category?: string
          source_label?: string
          source_url?: string | null
          surface_sqm?: number | null
          title?: string
          updated_at?: string
          why_now?: string | null
        }
        Relationships: []
      }
      luxuradar_scan_runs: {
        Row: {
          assets_found: number
          assets_new: number
          created_at: string
          error: string | null
          filters: Json
          finished_at: string | null
          id: string
          sources_used: string[]
          started_at: string
          status: string
        }
        Insert: {
          assets_found?: number
          assets_new?: number
          created_at?: string
          error?: string | null
          filters?: Json
          finished_at?: string | null
          id?: string
          sources_used?: string[]
          started_at?: string
          status?: string
        }
        Update: {
          assets_found?: number
          assets_new?: number
          created_at?: string
          error?: string | null
          filters?: Json
          finished_at?: string | null
          id?: string
          sources_used?: string[]
          started_at?: string
          status?: string
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
      market_benchmark_padova: {
        Row: {
          area_name: string
          avg_price_eur_mq: number | null
          id: string
          imported_at: string
          max_price_eur_mq: number | null
          min_price_eur_mq: number | null
          period: string
          rent_eur_mq_month: number | null
          source_name: string
          source_url: string | null
        }
        Insert: {
          area_name: string
          avg_price_eur_mq?: number | null
          id?: string
          imported_at?: string
          max_price_eur_mq?: number | null
          min_price_eur_mq?: number | null
          period: string
          rent_eur_mq_month?: number | null
          source_name: string
          source_url?: string | null
        }
        Update: {
          area_name?: string
          avg_price_eur_mq?: number | null
          id?: string
          imported_at?: string
          max_price_eur_mq?: number | null
          min_price_eur_mq?: number | null
          period?: string
          rent_eur_mq_month?: number | null
          source_name?: string
          source_url?: string | null
        }
        Relationships: []
      }
      microzona_dossier: {
        Row: {
          asset_osservati: Json
          created_at: string
          created_by: string | null
          id: string
          microzona_id: string
          note_interne: string | null
          opportunita_candidate: Json
          segnali_territoriali: Json
          servizi_prossimita: Json
          stato: string
          versione: string
        }
        Insert: {
          asset_osservati?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          microzona_id: string
          note_interne?: string | null
          opportunita_candidate?: Json
          segnali_territoriali?: Json
          servizi_prossimita?: Json
          stato: string
          versione?: string
        }
        Update: {
          asset_osservati?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          microzona_id?: string
          note_interne?: string | null
          opportunita_candidate?: Json
          segnali_territoriali?: Json
          servizi_prossimita?: Json
          stato?: string
          versione?: string
        }
        Relationships: []
      }
      microzone_sentiment: {
        Row: {
          air_quality_score: number | null
          area_label: string | null
          area_type: string | null
          computed_at: string
          comune: string
          confidence_score: number
          data_basis: string[]
          environment_score: number | null
          family_fit_score: number | null
          fingerprint: string
          green_score: number | null
          id: number
          investor_fit_score: number | null
          is_active: boolean
          lat: number | null
          lng: number | null
          nightlife_pressure_score: number | null
          noise_score: number | null
          parking_score: number | null
          provincia: string
          quality: string
          safety_proxy_score: number | null
          school_access_score: number | null
          sentiment_score_total: number | null
          services_score: number | null
          source_refs: Json
          student_fit_score: number | null
          tourism_pressure_score: number | null
          transit_access_score: number | null
          updated_at: string
          urban_decay_risk_score: number | null
        }
        Insert: {
          air_quality_score?: number | null
          area_label?: string | null
          area_type?: string | null
          computed_at?: string
          comune: string
          confidence_score?: number
          data_basis?: string[]
          environment_score?: number | null
          family_fit_score?: number | null
          fingerprint: string
          green_score?: number | null
          id?: number
          investor_fit_score?: number | null
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          nightlife_pressure_score?: number | null
          noise_score?: number | null
          parking_score?: number | null
          provincia: string
          quality?: string
          safety_proxy_score?: number | null
          school_access_score?: number | null
          sentiment_score_total?: number | null
          services_score?: number | null
          source_refs?: Json
          student_fit_score?: number | null
          tourism_pressure_score?: number | null
          transit_access_score?: number | null
          updated_at?: string
          urban_decay_risk_score?: number | null
        }
        Update: {
          air_quality_score?: number | null
          area_label?: string | null
          area_type?: string | null
          computed_at?: string
          comune?: string
          confidence_score?: number
          data_basis?: string[]
          environment_score?: number | null
          family_fit_score?: number | null
          fingerprint?: string
          green_score?: number | null
          id?: number
          investor_fit_score?: number | null
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          nightlife_pressure_score?: number | null
          noise_score?: number | null
          parking_score?: number | null
          provincia?: string
          quality?: string
          safety_proxy_score?: number | null
          school_access_score?: number | null
          sentiment_score_total?: number | null
          services_score?: number | null
          source_refs?: Json
          student_fit_score?: number | null
          tourism_pressure_score?: number | null
          transit_access_score?: number | null
          updated_at?: string
          urban_decay_risk_score?: number | null
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
      normalized_opportunities: {
        Row: {
          address_text: string | null
          ask_price: number | null
          category: string | null
          completeness_score: number
          created_at: string
          dedupe_key: string | null
          external_ref: string | null
          first_seen_at: string
          freshness_days: number
          id: string
          last_seen_at: string
          latitude: number | null
          longitude: number | null
          microzone: string | null
          municipality: string | null
          possible_duplicate: boolean
          priority_score: number
          property_type: string | null
          raw_id: string | null
          scoring_reason: string | null
          source_name: string
          source_url: string | null
          surface_mq: number | null
          tags: string[]
          title: string
          updated_at: string
        }
        Insert: {
          address_text?: string | null
          ask_price?: number | null
          category?: string | null
          completeness_score?: number
          created_at?: string
          dedupe_key?: string | null
          external_ref?: string | null
          first_seen_at?: string
          freshness_days?: number
          id?: string
          last_seen_at?: string
          latitude?: number | null
          longitude?: number | null
          microzone?: string | null
          municipality?: string | null
          possible_duplicate?: boolean
          priority_score?: number
          property_type?: string | null
          raw_id?: string | null
          scoring_reason?: string | null
          source_name: string
          source_url?: string | null
          surface_mq?: number | null
          tags?: string[]
          title: string
          updated_at?: string
        }
        Update: {
          address_text?: string | null
          ask_price?: number | null
          category?: string | null
          completeness_score?: number
          created_at?: string
          dedupe_key?: string | null
          external_ref?: string | null
          first_seen_at?: string
          freshness_days?: number
          id?: string
          last_seen_at?: string
          latitude?: number | null
          longitude?: number | null
          microzone?: string | null
          municipality?: string | null
          possible_duplicate?: boolean
          priority_score?: number
          property_type?: string | null
          raw_id?: string | null
          scoring_reason?: string | null
          source_name?: string
          source_url?: string | null
          surface_mq?: number | null
          tags?: string[]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "normalized_opportunities_raw_id_fkey"
            columns: ["raw_id"]
            isOneToOne: false
            referencedRelation: "raw_sources_ingest"
            referencedColumns: ["id"]
          },
        ]
      }
      obituaries_aggregate_padova: {
        Row: {
          area_code: string
          area_type: string
          bucket_count: number
          id: number
          imported_at: string
          source_url: string | null
          window_days: number
          window_end: string
          window_start: string
        }
        Insert: {
          area_code: string
          area_type: string
          bucket_count: number
          id?: number
          imported_at?: string
          source_url?: string | null
          window_days: number
          window_end: string
          window_start: string
        }
        Update: {
          area_code?: string
          area_type?: string
          bucket_count?: number
          id?: number
          imported_at?: string
          source_url?: string | null
          window_days?: number
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      obituaries_seen: {
        Row: {
          agency_private_only: boolean
          cap: string | null
          captured_at: string
          category: string | null
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
          requires_review: boolean
          retention_days: number | null
          source_id: number | null
          source_url: string | null
          standard_radar_visible: boolean
          surname: string
        }
        Insert: {
          agency_private_only?: boolean
          cap?: string | null
          captured_at?: string
          category?: string | null
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
          requires_review?: boolean
          retention_days?: number | null
          source_id?: number | null
          source_url?: string | null
          standard_radar_visible?: boolean
          surname: string
        }
        Update: {
          agency_private_only?: boolean
          cap?: string | null
          captured_at?: string
          category?: string | null
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
          requires_review?: boolean
          retention_days?: number | null
          source_id?: number | null
          source_url?: string | null
          standard_radar_visible?: boolean
          surname?: string
        }
        Relationships: []
      }
      obituaries_sources: {
        Row: {
          agency_private_only: boolean
          base_url: string
          category: string | null
          created_at: string
          id: number
          is_active: boolean
          last_used_at: string | null
          name: string
          region: string | null
          reliability_score: number | null
          requires_review: boolean
          retention_days: number | null
          search_url_template: string
          source_type: string
          standard_radar_visible: boolean
        }
        Insert: {
          agency_private_only?: boolean
          base_url: string
          category?: string | null
          created_at?: string
          id?: number
          is_active?: boolean
          last_used_at?: string | null
          name: string
          region?: string | null
          reliability_score?: number | null
          requires_review?: boolean
          retention_days?: number | null
          search_url_template: string
          source_type?: string
          standard_radar_visible?: boolean
        }
        Update: {
          agency_private_only?: boolean
          base_url?: string
          category?: string | null
          created_at?: string
          id?: number
          is_active?: boolean
          last_used_at?: string | null
          name?: string
          region?: string | null
          reliability_score?: number | null
          requires_review?: boolean
          retention_days?: number | null
          search_url_template?: string
          source_type?: string
          standard_radar_visible?: boolean
        }
        Relationships: []
      }
      offmarket_opportunity_scores: {
        Row: {
          acquisition_priority_score: number
          area_label: string
          area_type: string
          computed_at: string
          comune: string
          confidence_score: number
          data_basis: Json
          exclusive_pitch_score: number
          family_attractiveness_score: number
          fingerprint: string
          id: number
          investor_attractiveness_score: number
          is_active: boolean
          microzone_heat_score: number
          missing_factors: Json
          negative_factors: Json
          off_market_potential_score: number
          owner_education_score: number
          positive_factors: Json
          provincia: string
          quality: string
          recommended_actions: Json
          region: string
          scripts: Json
          source_refs: Json
          updated_at: string
          valuation_campaign_score: number
        }
        Insert: {
          acquisition_priority_score?: number
          area_label: string
          area_type?: string
          computed_at?: string
          comune: string
          confidence_score?: number
          data_basis?: Json
          exclusive_pitch_score?: number
          family_attractiveness_score?: number
          fingerprint: string
          id?: number
          investor_attractiveness_score?: number
          is_active?: boolean
          microzone_heat_score?: number
          missing_factors?: Json
          negative_factors?: Json
          off_market_potential_score?: number
          owner_education_score?: number
          positive_factors?: Json
          provincia: string
          quality?: string
          recommended_actions?: Json
          region?: string
          scripts?: Json
          source_refs?: Json
          updated_at?: string
          valuation_campaign_score?: number
        }
        Update: {
          acquisition_priority_score?: number
          area_label?: string
          area_type?: string
          computed_at?: string
          comune?: string
          confidence_score?: number
          data_basis?: Json
          exclusive_pitch_score?: number
          family_attractiveness_score?: number
          fingerprint?: string
          id?: number
          investor_attractiveness_score?: number
          is_active?: boolean
          microzone_heat_score?: number
          missing_factors?: Json
          negative_factors?: Json
          off_market_potential_score?: number
          owner_education_score?: number
          positive_factors?: Json
          provincia?: string
          quality?: string
          recommended_actions?: Json
          region?: string
          scripts?: Json
          source_refs?: Json
          updated_at?: string
          valuation_campaign_score?: number
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
      openapi_it_cache: {
        Row: {
          cache_key: string
          contract: string | null
          created_at: string
          endpoint: string
          expires_at: string
          fetched_at: string
          id: string
          lat_scaled: number | null
          lng_scaled: number | null
          normalized_address: string | null
          property_type: string | null
          request_params: Json
          response_payload: Json
        }
        Insert: {
          cache_key: string
          contract?: string | null
          created_at?: string
          endpoint: string
          expires_at: string
          fetched_at?: string
          id?: string
          lat_scaled?: number | null
          lng_scaled?: number | null
          normalized_address?: string | null
          property_type?: string | null
          request_params?: Json
          response_payload: Json
        }
        Update: {
          cache_key?: string
          contract?: string | null
          created_at?: string
          endpoint?: string
          expires_at?: string
          fetched_at?: string
          id?: string
          lat_scaled?: number | null
          lng_scaled?: number | null
          normalized_address?: string | null
          property_type?: string | null
          request_params?: Json
          response_payload?: Json
        }
        Relationships: []
      }
      openapi_it_call_log: {
        Row: {
          agency_id: string | null
          cache_hit: boolean
          created_at: string
          debug_id: string | null
          dossier_id: string | null
          duration_ms: number | null
          endpoint: string
          environment: string
          error_code: string | null
          estimated_cost_eur: number
          http_status: number | null
          id: string
          real_cost_eur: number
          status: string
          user_id: string | null
        }
        Insert: {
          agency_id?: string | null
          cache_hit?: boolean
          created_at?: string
          debug_id?: string | null
          dossier_id?: string | null
          duration_ms?: number | null
          endpoint: string
          environment?: string
          error_code?: string | null
          estimated_cost_eur?: number
          http_status?: number | null
          id?: string
          real_cost_eur?: number
          status: string
          user_id?: string | null
        }
        Update: {
          agency_id?: string | null
          cache_hit?: boolean
          created_at?: string
          debug_id?: string | null
          dossier_id?: string | null
          duration_ms?: number | null
          endpoint?: string
          environment?: string
          error_code?: string | null
          estimated_cost_eur?: number
          http_status?: number | null
          id?: string
          real_cost_eur?: number
          status?: string
          user_id?: string | null
        }
        Relationships: []
      }
      opportunity_evidence: {
        Row: {
          anticipatory_or_confirmation: string
          area_match: Json
          collected_at: string
          fingerprint: string
          freshness_days: number | null
          geo_level: string
          id: number
          opportunity_id: number
          opportunity_table: string
          privacy_safe: boolean
          reason_for_weight: string
          score_weight: number
          signal_type: string
          source_name: string
          source_unverified: boolean
          source_url: string
        }
        Insert: {
          anticipatory_or_confirmation: string
          area_match?: Json
          collected_at?: string
          fingerprint: string
          freshness_days?: number | null
          geo_level: string
          id?: number
          opportunity_id: number
          opportunity_table?: string
          privacy_safe?: boolean
          reason_for_weight: string
          score_weight?: number
          signal_type: string
          source_name: string
          source_unverified?: boolean
          source_url: string
        }
        Update: {
          anticipatory_or_confirmation?: string
          area_match?: Json
          collected_at?: string
          fingerprint?: string
          freshness_days?: number | null
          geo_level?: string
          id?: number
          opportunity_id?: number
          opportunity_table?: string
          privacy_safe?: boolean
          reason_for_weight?: string
          score_weight?: number
          signal_type?: string
          source_name?: string
          source_unverified?: boolean
          source_url?: string
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
      padova_civici: {
        Row: {
          cap: string | null
          civic_number: string
          civic_suffix: string | null
          comune: string
          fingerprint: string
          id: number
          ingested_at: string
          lat: number | null
          license: string | null
          lng: number | null
          microzona: string | null
          omi_zone: string | null
          provincia: string
          quality: string
          quartiere: string | null
          raw: Json
          source_name: string
          source_url: string
          street_name: string
          street_name_normalized: string
          updated_at: string
        }
        Insert: {
          cap?: string | null
          civic_number: string
          civic_suffix?: string | null
          comune?: string
          fingerprint: string
          id?: number
          ingested_at?: string
          lat?: number | null
          license?: string | null
          lng?: number | null
          microzona?: string | null
          omi_zone?: string | null
          provincia?: string
          quality?: string
          quartiere?: string | null
          raw?: Json
          source_name: string
          source_url: string
          street_name: string
          street_name_normalized: string
          updated_at?: string
        }
        Update: {
          cap?: string | null
          civic_number?: string
          civic_suffix?: string | null
          comune?: string
          fingerprint?: string
          id?: number
          ingested_at?: string
          lat?: number | null
          license?: string | null
          lng?: number | null
          microzona?: string | null
          omi_zone?: string | null
          provincia?: string
          quality?: string
          quartiere?: string | null
          raw?: Json
          source_name?: string
          source_url?: string
          street_name?: string
          street_name_normalized?: string
          updated_at?: string
        }
        Relationships: []
      }
      padova_elderly_population: {
        Row: {
          area_code: string | null
          area_name: string
          id: string
          imported_at: string
          over_65_count: number | null
          over_75_count: number | null
          over_75_rate: number | null
          source_url: string | null
          total_population: number | null
          year: number
        }
        Insert: {
          area_code?: string | null
          area_name: string
          id?: string
          imported_at?: string
          over_65_count?: number | null
          over_75_count?: number | null
          over_75_rate?: number | null
          source_url?: string | null
          total_population?: number | null
          year: number
        }
        Update: {
          area_code?: string | null
          area_name?: string
          id?: string
          imported_at?: string
          over_65_count?: number | null
          over_75_count?: number | null
          over_75_rate?: number | null
          source_url?: string | null
          total_population?: number | null
          year?: number
        }
        Relationships: []
      }
      padova_zone_radar_queue: {
        Row: {
          attempts: number
          created_at: string
          duration_ms: number | null
          finished_at: string | null
          id: number
          last_error: string | null
          municipality: string
          omi_zone_id: string | null
          priority: number
          province: string
          run_id: string
          started_at: string | null
          status: string
          summary: Json
          updated_at: string
          zone_name: string
          zone_type: string | null
        }
        Insert: {
          attempts?: number
          created_at?: string
          duration_ms?: number | null
          finished_at?: string | null
          id?: number
          last_error?: string | null
          municipality?: string
          omi_zone_id?: string | null
          priority?: number
          province?: string
          run_id: string
          started_at?: string | null
          status?: string
          summary?: Json
          updated_at?: string
          zone_name: string
          zone_type?: string | null
        }
        Update: {
          attempts?: number
          created_at?: string
          duration_ms?: number | null
          finished_at?: string | null
          id?: number
          last_error?: string | null
          municipality?: string
          omi_zone_id?: string | null
          priority?: number
          province?: string
          run_id?: string
          started_at?: string | null
          status?: string
          summary?: Json
          updated_at?: string
          zone_name?: string
          zone_type?: string | null
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
      pricing_error_signals: {
        Row: {
          comparable_avg: number | null
          comune: string | null
          confidence_score: number
          data_basis: string[]
          detected_at: string
          deviation_from_comparable_percent: number | null
          deviation_from_omi_percent: number | null
          id: number
          is_active: boolean
          listing_hash: string
          omi_avg: number | null
          omi_max: number | null
          omi_min: number | null
          price_eur: number | null
          price_per_mq: number | null
          pricing_error_type: string
          property_type: string | null
          provincia: string | null
          quality: string
          reason: string | null
          recommended_action: string | null
          score: number
          source_name: string | null
          source_url: string | null
          surface_mq: number | null
          updated_at: string
        }
        Insert: {
          comparable_avg?: number | null
          comune?: string | null
          confidence_score?: number
          data_basis?: string[]
          detected_at?: string
          deviation_from_comparable_percent?: number | null
          deviation_from_omi_percent?: number | null
          id?: number
          is_active?: boolean
          listing_hash: string
          omi_avg?: number | null
          omi_max?: number | null
          omi_min?: number | null
          price_eur?: number | null
          price_per_mq?: number | null
          pricing_error_type?: string
          property_type?: string | null
          provincia?: string | null
          quality?: string
          reason?: string | null
          recommended_action?: string | null
          score?: number
          source_name?: string | null
          source_url?: string | null
          surface_mq?: number | null
          updated_at?: string
        }
        Update: {
          comparable_avg?: number | null
          comune?: string | null
          confidence_score?: number
          data_basis?: string[]
          detected_at?: string
          deviation_from_comparable_percent?: number | null
          deviation_from_omi_percent?: number | null
          id?: number
          is_active?: boolean
          listing_hash?: string
          omi_avg?: number | null
          omi_max?: number | null
          omi_min?: number | null
          price_eur?: number | null
          price_per_mq?: number | null
          pricing_error_type?: string
          property_type?: string | null
          provincia?: string | null
          quality?: string
          reason?: string | null
          recommended_action?: string | null
          score?: number
          source_name?: string | null
          source_url?: string | null
          surface_mq?: number | null
          updated_at?: string
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
      provider_diagnostics_events: {
        Row: {
          action: string | null
          created_at: string
          event_type: string
          http_status: number | null
          id: number
          latency_ms: number | null
          message: string | null
          meta: Json
          ok: boolean
          provider: string
        }
        Insert: {
          action?: string | null
          created_at?: string
          event_type: string
          http_status?: number | null
          id?: number
          latency_ms?: number | null
          message?: string | null
          meta?: Json
          ok: boolean
          provider: string
        }
        Update: {
          action?: string | null
          created_at?: string
          event_type?: string
          http_status?: number | null
          id?: number
          latency_ms?: number | null
          message?: string | null
          meta?: Json
          ok?: boolean
          provider?: string
        }
        Relationships: []
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
      raw_sources_ingest: {
        Row: {
          created_at: string
          fetched_at: string
          id: string
          ingest_error: string | null
          microzone: string | null
          municipality: string | null
          raw_payload: Json
          source_name: string
          source_url: string | null
        }
        Insert: {
          created_at?: string
          fetched_at?: string
          id?: string
          ingest_error?: string | null
          microzone?: string | null
          municipality?: string | null
          raw_payload?: Json
          source_name: string
          source_url?: string | null
        }
        Update: {
          created_at?: string
          fetched_at?: string
          id?: string
          ingest_error?: string | null
          microzone?: string | null
          municipality?: string | null
          raw_payload?: Json
          source_name?: string
          source_url?: string | null
        }
        Relationships: []
      }
      restricted_report_audit: {
        Row: {
          agency_id: string | null
          completed_at: string | null
          cost_cents: number
          error_message: string | null
          feature_code: string
          id: string
          provider: string | null
          provider_response_id: string | null
          requested_at: string
          status: string
          target_ref: string
          user_id: string
        }
        Insert: {
          agency_id?: string | null
          completed_at?: string | null
          cost_cents?: number
          error_message?: string | null
          feature_code: string
          id?: string
          provider?: string | null
          provider_response_id?: string | null
          requested_at?: string
          status?: string
          target_ref: string
          user_id: string
        }
        Update: {
          agency_id?: string | null
          completed_at?: string | null
          cost_cents?: number
          error_message?: string | null
          feature_code?: string
          id?: string
          provider?: string | null
          provider_response_id?: string | null
          requested_at?: string
          status?: string
          target_ref?: string
          user_id?: string
        }
        Relationships: []
      }
      sottra_scans: {
        Row: {
          address: string | null
          comune: string | null
          created_at: string
          id: string
          lat: number | null
          lng: number | null
          photo_thumbnail: string | null
          provincia: string | null
          result_snapshot: Json | null
          user_id: string
          zona_omi: string | null
        }
        Insert: {
          address?: string | null
          comune?: string | null
          created_at?: string
          id?: string
          lat?: number | null
          lng?: number | null
          photo_thumbnail?: string | null
          provincia?: string | null
          result_snapshot?: Json | null
          user_id: string
          zona_omi?: string | null
        }
        Update: {
          address?: string | null
          comune?: string | null
          created_at?: string
          id?: string
          lat?: number | null
          lng?: number | null
          photo_thumbnail?: string | null
          provincia?: string | null
          result_snapshot?: Json | null
          user_id?: string
          zona_omi?: string | null
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
      sue_padova_permits: {
        Row: {
          address_public: string | null
          area_name: string | null
          compliance_verified: boolean
          id: string
          imported_at: string
          practice_date: string | null
          practice_type: string | null
          source_url: string | null
          status: string | null
        }
        Insert: {
          address_public?: string | null
          area_name?: string | null
          compliance_verified?: boolean
          id?: string
          imported_at?: string
          practice_date?: string | null
          practice_type?: string | null
          source_url?: string | null
          status?: string | null
        }
        Update: {
          address_public?: string | null
          area_name?: string | null
          compliance_verified?: boolean
          id?: string
          imported_at?: string
          practice_date?: string | null
          practice_type?: string | null
          source_url?: string | null
          status?: string | null
        }
        Relationships: []
      }
      territorial_signals: {
        Row: {
          amount_eur: number | null
          confidence_score: number
          data_basis: string | null
          description: string | null
          detected_at: string
          fetched_at: string
          fingerprint: string
          geo_polygon: Json | null
          id: number
          impact_direction: string | null
          impact_strength: number | null
          is_active: boolean
          lat: number | null
          lng: number | null
          municipality: string | null
          payload: Json | null
          province: string | null
          quality: string
          signal_subtype: string | null
          signal_type: string
          source_name: string
          source_url: string | null
          target_demand_segment: string | null
          title: string | null
        }
        Insert: {
          amount_eur?: number | null
          confidence_score?: number
          data_basis?: string | null
          description?: string | null
          detected_at?: string
          fetched_at?: string
          fingerprint: string
          geo_polygon?: Json | null
          id?: number
          impact_direction?: string | null
          impact_strength?: number | null
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          municipality?: string | null
          payload?: Json | null
          province?: string | null
          quality?: string
          signal_subtype?: string | null
          signal_type: string
          source_name: string
          source_url?: string | null
          target_demand_segment?: string | null
          title?: string | null
        }
        Update: {
          amount_eur?: number | null
          confidence_score?: number
          data_basis?: string | null
          description?: string | null
          detected_at?: string
          fetched_at?: string
          fingerprint?: string
          geo_polygon?: Json | null
          id?: number
          impact_direction?: string | null
          impact_strength?: number | null
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          municipality?: string | null
          payload?: Json | null
          province?: string | null
          quality?: string
          signal_subtype?: string | null
          signal_type?: string
          source_name?: string
          source_url?: string | null
          target_demand_segment?: string | null
          title?: string | null
        }
        Relationships: []
      }
      turnover_signals: {
        Row: {
          area_label: string | null
          computed_at: string
          comune: string
          confidence_score: number
          data_basis: string[]
          distress_aggregate: number | null
          elderly_ratio: number | null
          fingerprint: string
          id: number
          is_active: boolean
          low_rotation_proxy: number | null
          non_occupied_ratio: number | null
          old_building_ratio: number | null
          provincia: string
          quality: string
          second_home_proxy: number | null
          single_household_ratio: number | null
          source_refs: Json
          turnover_potential_score: number
          updated_at: string
        }
        Insert: {
          area_label?: string | null
          computed_at?: string
          comune: string
          confidence_score?: number
          data_basis?: string[]
          distress_aggregate?: number | null
          elderly_ratio?: number | null
          fingerprint: string
          id?: number
          is_active?: boolean
          low_rotation_proxy?: number | null
          non_occupied_ratio?: number | null
          old_building_ratio?: number | null
          provincia: string
          quality?: string
          second_home_proxy?: number | null
          single_household_ratio?: number | null
          source_refs?: Json
          turnover_potential_score?: number
          updated_at?: string
        }
        Update: {
          area_label?: string | null
          computed_at?: string
          comune?: string
          confidence_score?: number
          data_basis?: string[]
          distress_aggregate?: number | null
          elderly_ratio?: number | null
          fingerprint?: string
          id?: number
          is_active?: boolean
          low_rotation_proxy?: number | null
          non_occupied_ratio?: number | null
          old_building_ratio?: number | null
          provincia?: string
          quality?: string
          second_home_proxy?: number | null
          single_household_ratio?: number | null
          source_refs?: Json
          turnover_potential_score?: number
          updated_at?: string
        }
        Relationships: []
      }
      urgent_opportunity_signals: {
        Row: {
          agent_action: string | null
          area_label: string | null
          comune: string | null
          confidence_score: number
          created_at: string
          data_basis: string[]
          expires_at: string | null
          fingerprint: string
          id: number
          is_active: boolean
          opportunity_type: string
          priority: string
          provincia: string | null
          quality: string
          reason: string | null
          script: string | null
          source_urls: string[]
          target: string | null
          time_window: string
          title: string
        }
        Insert: {
          agent_action?: string | null
          area_label?: string | null
          comune?: string | null
          confidence_score?: number
          created_at?: string
          data_basis?: string[]
          expires_at?: string | null
          fingerprint: string
          id?: number
          is_active?: boolean
          opportunity_type: string
          priority: string
          provincia?: string | null
          quality?: string
          reason?: string | null
          script?: string | null
          source_urls?: string[]
          target?: string | null
          time_window: string
          title: string
        }
        Update: {
          agent_action?: string | null
          area_label?: string | null
          comune?: string | null
          confidence_score?: number
          created_at?: string
          data_basis?: string[]
          expires_at?: string | null
          fingerprint?: string
          id?: number
          is_active?: boolean
          opportunity_type?: string
          priority?: string
          provincia?: string | null
          quality?: string
          reason?: string | null
          script?: string | null
          source_urls?: string[]
          target?: string | null
          time_window?: string
          title?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      veneto_comuni: {
        Row: {
          codice_istat: string
          created_at: string
          is_capoluogo: boolean
          lat: number | null
          lng: number | null
          nome: string
          nome_normalizzato: string
          popolazione: number | null
          provincia: string
          provincia_nome: string
        }
        Insert: {
          codice_istat: string
          created_at?: string
          is_capoluogo?: boolean
          lat?: number | null
          lng?: number | null
          nome: string
          nome_normalizzato: string
          popolazione?: number | null
          provincia: string
          provincia_nome: string
        }
        Update: {
          codice_istat?: string
          created_at?: string
          is_capoluogo?: boolean
          lat?: number | null
          lng?: number | null
          nome?: string
          nome_normalizzato?: string
          popolazione?: number | null
          provincia?: string
          provincia_nome?: string
        }
        Relationships: []
      }
      zone_completeness: {
        Row: {
          avg_freshness_days: number
          categories_count: number
          completeness_score: number
          computed_at: string
          freshness_score: number
          geo_coverage_ratio: number
          id: number
          min_quality_ratio: number
          readiness_label: string
          reason_short: string | null
          top_categories: Json
          total_records: number
          zone_key: string
          zone_label: string
        }
        Insert: {
          avg_freshness_days?: number
          categories_count?: number
          completeness_score?: number
          computed_at?: string
          freshness_score?: number
          geo_coverage_ratio?: number
          id?: number
          min_quality_ratio?: number
          readiness_label?: string
          reason_short?: string | null
          top_categories?: Json
          total_records?: number
          zone_key: string
          zone_label: string
        }
        Update: {
          avg_freshness_days?: number
          categories_count?: number
          completeness_score?: number
          computed_at?: string
          freshness_score?: number
          geo_coverage_ratio?: number
          id?: number
          min_quality_ratio?: number
          readiness_label?: string
          reason_short?: string | null
          top_categories?: Json
          total_records?: number
          zone_key?: string
          zone_label?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      clear_omi_geometry: { Args: never; Returns: undefined }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
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
      is_agency_admin: { Args: { target_agency_id: string }; Returns: boolean }
      is_agency_member: { Args: { target_agency_id: string }; Returns: boolean }
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
      resolve_padova_geo_level: {
        Args: { p_lat: number; p_lng: number }
        Returns: {
          geo_level: string
          microzona: string
          omi_zone: string
        }[]
      }
      vault_create_secret_if_missing: {
        Args: { p_name: string; p_value: string }
        Returns: Json
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
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
    Enums: {
      app_role: ["admin", "moderator", "user"],
    },
  },
} as const
