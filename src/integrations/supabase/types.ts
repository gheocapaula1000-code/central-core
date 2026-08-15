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
      _bkp_20260724_eosc_touched: {
        Row: {
          agent_action: string | null
          ai_summary: string | null
          amount_text: string | null
          asset_type: string | null
          commercial_value_score: number | null
          comune: string | null
          confidence_score: number | null
          created_at: string | null
          data_basis: string | null
          deadline_text: string | null
          fingerprint: string | null
          id: string | null
          import_recommendation: string | null
          investor_pitch: string | null
          location_detail: string | null
          needs_review: boolean | null
          owner_pitch: string | null
          payload: Json | null
          possible_agent_action: string | null
          priority_score: number | null
          privacy_safe: boolean | null
          promoted_at: string | null
          promoted_to: string | null
          provincia: string | null
          publication_date: string | null
          quality: string | null
          quartiere: string | null
          real_estate_relevance_score: number | null
          reject_reason: string | null
          rejection_reason: string | null
          review_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          run_id: string | null
          signal_type: string | null
          source_name: string | null
          source_url: string | null
          status: string | null
          summary: string | null
          timing: string | null
          title: string | null
          why_it_matters: string | null
        }
        Insert: {
          agent_action?: string | null
          ai_summary?: string | null
          amount_text?: string | null
          asset_type?: string | null
          commercial_value_score?: number | null
          comune?: string | null
          confidence_score?: number | null
          created_at?: string | null
          data_basis?: string | null
          deadline_text?: string | null
          fingerprint?: string | null
          id?: string | null
          import_recommendation?: string | null
          investor_pitch?: string | null
          location_detail?: string | null
          needs_review?: boolean | null
          owner_pitch?: string | null
          payload?: Json | null
          possible_agent_action?: string | null
          priority_score?: number | null
          privacy_safe?: boolean | null
          promoted_at?: string | null
          promoted_to?: string | null
          provincia?: string | null
          publication_date?: string | null
          quality?: string | null
          quartiere?: string | null
          real_estate_relevance_score?: number | null
          reject_reason?: string | null
          rejection_reason?: string | null
          review_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          run_id?: string | null
          signal_type?: string | null
          source_name?: string | null
          source_url?: string | null
          status?: string | null
          summary?: string | null
          timing?: string | null
          title?: string | null
          why_it_matters?: string | null
        }
        Update: {
          agent_action?: string | null
          ai_summary?: string | null
          amount_text?: string | null
          asset_type?: string | null
          commercial_value_score?: number | null
          comune?: string | null
          confidence_score?: number | null
          created_at?: string | null
          data_basis?: string | null
          deadline_text?: string | null
          fingerprint?: string | null
          id?: string | null
          import_recommendation?: string | null
          investor_pitch?: string | null
          location_detail?: string | null
          needs_review?: boolean | null
          owner_pitch?: string | null
          payload?: Json | null
          possible_agent_action?: string | null
          priority_score?: number | null
          privacy_safe?: boolean | null
          promoted_at?: string | null
          promoted_to?: string | null
          provincia?: string | null
          publication_date?: string | null
          quality?: string | null
          quartiere?: string | null
          real_estate_relevance_score?: number | null
          reject_reason?: string | null
          rejection_reason?: string | null
          review_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          run_id?: string | null
          signal_type?: string | null
          source_name?: string | null
          source_url?: string | null
          status?: string | null
          summary?: string | null
          timing?: string | null
          title?: string | null
          why_it_matters?: string | null
        }
        Relationships: []
      }
      _bkp_20260724_padova_contendibili: {
        Row: {
          agencies_normalized: string[] | null
          agency_count_distinct: number | null
          agency_count_raw: number | null
          agenzie: string[] | null
          bagni: number | null
          cambio_agenzia: boolean | null
          cambio_agenzia_a: string | null
          cambio_agenzia_da: string | null
          cambio_agenzia_data: string | null
          chiave_match: string | null
          confidenza: string | null
          created_at: string | null
          data_primo_annuncio: string | null
          differenza_zona_pct: number | null
          fonti: string[] | null
          giorni_fermo: number | null
          giorni_sul_mercato: number | null
          id: number | null
          is_ripubblicato: boolean | null
          lat: number | null
          lng: number | null
          locali: number | null
          mq: number | null
          n_agenzie: number | null
          n_annunci: number | null
          n_portali: number | null
          n_ribassi: number | null
          portals_seen: string[] | null
          prezzo_immobile_eur_mq: number | null
          prezzo_max: number | null
          prezzo_medio_zona_eur_mq: number | null
          prezzo_min: number | null
          quartiere: string | null
          ribasso_pct: number | null
          score_pressione: number | null
          urls: string[] | null
        }
        Insert: {
          agencies_normalized?: string[] | null
          agency_count_distinct?: number | null
          agency_count_raw?: number | null
          agenzie?: string[] | null
          bagni?: number | null
          cambio_agenzia?: boolean | null
          cambio_agenzia_a?: string | null
          cambio_agenzia_da?: string | null
          cambio_agenzia_data?: string | null
          chiave_match?: string | null
          confidenza?: string | null
          created_at?: string | null
          data_primo_annuncio?: string | null
          differenza_zona_pct?: number | null
          fonti?: string[] | null
          giorni_fermo?: number | null
          giorni_sul_mercato?: number | null
          id?: number | null
          is_ripubblicato?: boolean | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          n_agenzie?: number | null
          n_annunci?: number | null
          n_portali?: number | null
          n_ribassi?: number | null
          portals_seen?: string[] | null
          prezzo_immobile_eur_mq?: number | null
          prezzo_max?: number | null
          prezzo_medio_zona_eur_mq?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          ribasso_pct?: number | null
          score_pressione?: number | null
          urls?: string[] | null
        }
        Update: {
          agencies_normalized?: string[] | null
          agency_count_distinct?: number | null
          agency_count_raw?: number | null
          agenzie?: string[] | null
          bagni?: number | null
          cambio_agenzia?: boolean | null
          cambio_agenzia_a?: string | null
          cambio_agenzia_da?: string | null
          cambio_agenzia_data?: string | null
          chiave_match?: string | null
          confidenza?: string | null
          created_at?: string | null
          data_primo_annuncio?: string | null
          differenza_zona_pct?: number | null
          fonti?: string[] | null
          giorni_fermo?: number | null
          giorni_sul_mercato?: number | null
          id?: number | null
          is_ripubblicato?: boolean | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          n_agenzie?: number | null
          n_annunci?: number | null
          n_portali?: number | null
          n_ribassi?: number | null
          portals_seen?: string[] | null
          prezzo_immobile_eur_mq?: number | null
          prezzo_max?: number | null
          prezzo_medio_zona_eur_mq?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          ribasso_pct?: number | null
          score_pressione?: number | null
          urls?: string[] | null
        }
        Relationships: []
      }
      _bkp_20260724_padova_multi_portale: {
        Row: {
          agencies_normalized: string[] | null
          agency_count_distinct: number | null
          agenzie: string[] | null
          bagni: number | null
          chiave_match: string | null
          created_at: string | null
          id: number | null
          lat: number | null
          lng: number | null
          locali: number | null
          mq: number | null
          n_annunci: number | null
          portal_count: number | null
          portals_seen: string[] | null
          prezzo_max: number | null
          prezzo_min: number | null
          quartiere: string | null
          urls: string[] | null
        }
        Insert: {
          agencies_normalized?: string[] | null
          agency_count_distinct?: number | null
          agenzie?: string[] | null
          bagni?: number | null
          chiave_match?: string | null
          created_at?: string | null
          id?: number | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          n_annunci?: number | null
          portal_count?: number | null
          portals_seen?: string[] | null
          prezzo_max?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          urls?: string[] | null
        }
        Update: {
          agencies_normalized?: string[] | null
          agency_count_distinct?: number | null
          agenzie?: string[] | null
          bagni?: number | null
          chiave_match?: string | null
          created_at?: string | null
          id?: number | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          n_annunci?: number | null
          portal_count?: number | null
          portals_seen?: string[] | null
          prezzo_max?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          urls?: string[] | null
        }
        Relationships: []
      }
      _bkp_20260724020000_cont: {
        Row: {
          agencies_normalized: string[] | null
          agency_count_distinct: number | null
          agency_count_raw: number | null
          agenzie: string[] | null
          bagni: number | null
          cambio_agenzia: boolean | null
          cambio_agenzia_a: string | null
          cambio_agenzia_da: string | null
          cambio_agenzia_data: string | null
          chiave_match: string | null
          confidenza: string | null
          created_at: string | null
          data_primo_annuncio: string | null
          differenza_zona_pct: number | null
          fonti: string[] | null
          giorni_fermo: number | null
          giorni_sul_mercato: number | null
          id: number | null
          is_ripubblicato: boolean | null
          last_seen_at: string | null
          lat: number | null
          lng: number | null
          locali: number | null
          mq: number | null
          n_agenzie: number | null
          n_annunci: number | null
          n_portali: number | null
          n_ribassi: number | null
          portals_seen: string[] | null
          prezzo_immobile_eur_mq: number | null
          prezzo_max: number | null
          prezzo_medio_zona_eur_mq: number | null
          prezzo_min: number | null
          quartiere: string | null
          ribasso_pct: number | null
          score_pressione: number | null
          updated_at: string | null
          urls: string[] | null
        }
        Insert: {
          agencies_normalized?: string[] | null
          agency_count_distinct?: number | null
          agency_count_raw?: number | null
          agenzie?: string[] | null
          bagni?: number | null
          cambio_agenzia?: boolean | null
          cambio_agenzia_a?: string | null
          cambio_agenzia_da?: string | null
          cambio_agenzia_data?: string | null
          chiave_match?: string | null
          confidenza?: string | null
          created_at?: string | null
          data_primo_annuncio?: string | null
          differenza_zona_pct?: number | null
          fonti?: string[] | null
          giorni_fermo?: number | null
          giorni_sul_mercato?: number | null
          id?: number | null
          is_ripubblicato?: boolean | null
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          n_agenzie?: number | null
          n_annunci?: number | null
          n_portali?: number | null
          n_ribassi?: number | null
          portals_seen?: string[] | null
          prezzo_immobile_eur_mq?: number | null
          prezzo_max?: number | null
          prezzo_medio_zona_eur_mq?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          ribasso_pct?: number | null
          score_pressione?: number | null
          updated_at?: string | null
          urls?: string[] | null
        }
        Update: {
          agencies_normalized?: string[] | null
          agency_count_distinct?: number | null
          agency_count_raw?: number | null
          agenzie?: string[] | null
          bagni?: number | null
          cambio_agenzia?: boolean | null
          cambio_agenzia_a?: string | null
          cambio_agenzia_da?: string | null
          cambio_agenzia_data?: string | null
          chiave_match?: string | null
          confidenza?: string | null
          created_at?: string | null
          data_primo_annuncio?: string | null
          differenza_zona_pct?: number | null
          fonti?: string[] | null
          giorni_fermo?: number | null
          giorni_sul_mercato?: number | null
          id?: number | null
          is_ripubblicato?: boolean | null
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          n_agenzie?: number | null
          n_annunci?: number | null
          n_portali?: number | null
          n_ribassi?: number | null
          portals_seen?: string[] | null
          prezzo_immobile_eur_mq?: number | null
          prezzo_max?: number | null
          prezzo_medio_zona_eur_mq?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          ribasso_pct?: number | null
          score_pressione?: number | null
          updated_at?: string | null
          urls?: string[] | null
        }
        Relationships: []
      }
      _bkp_20260724020000_cont_ids: {
        Row: {
          chiave_match: string | null
          id: number | null
        }
        Insert: {
          chiave_match?: string | null
          id?: number | null
        }
        Update: {
          chiave_match?: string | null
          id?: number | null
        }
        Relationships: []
      }
      _bkp_20260724020000_mp: {
        Row: {
          agencies_normalized: string[] | null
          agency_count_distinct: number | null
          agenzie: string[] | null
          bagni: number | null
          chiave_match: string | null
          created_at: string | null
          id: number | null
          last_seen_at: string | null
          lat: number | null
          lng: number | null
          locali: number | null
          mq: number | null
          n_annunci: number | null
          portal_count: number | null
          portals_seen: string[] | null
          prezzo_max: number | null
          prezzo_min: number | null
          quartiere: string | null
          updated_at: string | null
          urls: string[] | null
        }
        Insert: {
          agencies_normalized?: string[] | null
          agency_count_distinct?: number | null
          agenzie?: string[] | null
          bagni?: number | null
          chiave_match?: string | null
          created_at?: string | null
          id?: number | null
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          n_annunci?: number | null
          portal_count?: number | null
          portals_seen?: string[] | null
          prezzo_max?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          updated_at?: string | null
          urls?: string[] | null
        }
        Update: {
          agencies_normalized?: string[] | null
          agency_count_distinct?: number | null
          agenzie?: string[] | null
          bagni?: number | null
          chiave_match?: string | null
          created_at?: string | null
          id?: number | null
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          n_annunci?: number | null
          portal_count?: number | null
          portals_seen?: string[] | null
          prezzo_max?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          updated_at?: string | null
          urls?: string[] | null
        }
        Relationships: []
      }
      _bkp_20260724020000_mp_ids: {
        Row: {
          chiave_match: string | null
          id: number | null
        }
        Insert: {
          chiave_match?: string | null
          id?: number | null
        }
        Update: {
          chiave_match?: string | null
          id?: number | null
        }
        Relationships: []
      }
      _bkp_20260808_zone_contract_v2: {
        Row: {
          captured_at: string
          old_slug: string | null
          quartiere: string | null
          row_id: string
          src_table: string
        }
        Insert: {
          captured_at?: string
          old_slug?: string | null
          quartiere?: string | null
          row_id: string
          src_table: string
        }
        Update: {
          captured_at?: string
          old_slug?: string | null
          quartiere?: string | null
          row_id?: string
          src_table?: string
        }
        Relationships: []
      }
      _casa_scrape_debug_cache: {
        Row: {
          created_at: string
          id: number
          md: string
          url: string
        }
        Insert: {
          created_at?: string
          id?: number
          md: string
          url: string
        }
        Update: {
          created_at?: string
          id?: number
          md?: string
          url?: string
        }
        Relationships: []
      }
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
      ai_spend_daily: {
        Row: {
          calls: number
          day_utc: string
          est_usd: number
          input_tokens: number
          output_tokens: number
          provider: string
          updated_at: string
        }
        Insert: {
          calls?: number
          day_utc: string
          est_usd?: number
          input_tokens?: number
          output_tokens?: number
          provider: string
          updated_at?: string
        }
        Update: {
          calls?: number
          day_utc?: string
          est_usd?: number
          input_tokens?: number
          output_tokens?: number
          provider?: string
          updated_at?: string
        }
        Relationships: []
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
      apify_spend_daily: {
        Row: {
          calls: number
          day_utc: string
          est_usd: number
          updated_at: string
        }
        Insert: {
          calls?: number
          day_utc: string
          est_usd?: number
          updated_at?: string
        }
        Update: {
          calls?: number
          day_utc?: string
          est_usd?: number
          updated_at?: string
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
      b2b_companies: {
        Row: {
          address: string | null
          category: string | null
          comune: string | null
          country: string | null
          created_at: string
          email: string | null
          fit_reason: string | null
          id: string
          identity_hash: string
          last_seen_at: string | null
          lat: number | null
          lng: number | null
          metadata: Json
          name: string
          notes: string | null
          phone: string | null
          priority: string | null
          provincia: string | null
          regione: string | null
          score: number | null
          source_count: number
          status: string
          updated_at: string
          website: string | null
        }
        Insert: {
          address?: string | null
          category?: string | null
          comune?: string | null
          country?: string | null
          created_at?: string
          email?: string | null
          fit_reason?: string | null
          id?: string
          identity_hash: string
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          metadata?: Json
          name: string
          notes?: string | null
          phone?: string | null
          priority?: string | null
          provincia?: string | null
          regione?: string | null
          score?: number | null
          source_count?: number
          status?: string
          updated_at?: string
          website?: string | null
        }
        Update: {
          address?: string | null
          category?: string | null
          comune?: string | null
          country?: string | null
          created_at?: string
          email?: string | null
          fit_reason?: string | null
          id?: string
          identity_hash?: string
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          metadata?: Json
          name?: string
          notes?: string | null
          phone?: string | null
          priority?: string | null
          provincia?: string | null
          regione?: string | null
          score?: number | null
          source_count?: number
          status?: string
          updated_at?: string
          website?: string | null
        }
        Relationships: []
      }
      b2b_company_sources: {
        Row: {
          company_id: string
          confidence: number | null
          created_at: string
          extracted_summary: string | null
          fetched_at: string
          id: string
          job_id: string | null
          payload: Json
          source: string
          source_ref: string | null
          source_title: string | null
          source_url: string | null
        }
        Insert: {
          company_id: string
          confidence?: number | null
          created_at?: string
          extracted_summary?: string | null
          fetched_at?: string
          id?: string
          job_id?: string | null
          payload?: Json
          source: string
          source_ref?: string | null
          source_title?: string | null
          source_url?: string | null
        }
        Update: {
          company_id?: string
          confidence?: number | null
          created_at?: string
          extracted_summary?: string | null
          fetched_at?: string
          id?: string
          job_id?: string | null
          payload?: Json
          source?: string
          source_ref?: string | null
          source_title?: string | null
          source_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "b2b_company_sources_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "b2b_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "b2b_company_sources_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "b2b_search_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      b2b_enrichment_jobs: {
        Row: {
          budget_eur: number
          cancel_requested: boolean
          company_ids: Json
          completed_at: string | null
          cost_eur: number
          created_at: string
          error: string | null
          failed: number
          id: string
          job_id: string | null
          limit_n: number
          mode: string
          processed: number
          providers_used: Json
          ready_to_contact: number
          skipped: number
          started_at: string | null
          status: string
          total: number
          updated_at: string
          updated_count: number
          warnings: Json
        }
        Insert: {
          budget_eur?: number
          cancel_requested?: boolean
          company_ids?: Json
          completed_at?: string | null
          cost_eur?: number
          created_at?: string
          error?: string | null
          failed?: number
          id?: string
          job_id?: string | null
          limit_n?: number
          mode: string
          processed?: number
          providers_used?: Json
          ready_to_contact?: number
          skipped?: number
          started_at?: string | null
          status?: string
          total?: number
          updated_at?: string
          updated_count?: number
          warnings?: Json
        }
        Update: {
          budget_eur?: number
          cancel_requested?: boolean
          company_ids?: Json
          completed_at?: string | null
          cost_eur?: number
          created_at?: string
          error?: string | null
          failed?: number
          id?: string
          job_id?: string | null
          limit_n?: number
          mode?: string
          processed?: number
          providers_used?: Json
          ready_to_contact?: number
          skipped?: number
          started_at?: string | null
          status?: string
          total?: number
          updated_at?: string
          updated_count?: number
          warnings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "b2b_enrichment_jobs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "b2b_search_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      b2b_outreach_messages: {
        Row: {
          body: string
          channel: string
          company_id: string
          created_at: string
          generated_at: string
          id: string
          job_id: string | null
          language: string
          metadata: Json
          status: string
          subject: string | null
          vertical: string
        }
        Insert: {
          body: string
          channel: string
          company_id: string
          created_at?: string
          generated_at?: string
          id?: string
          job_id?: string | null
          language?: string
          metadata?: Json
          status?: string
          subject?: string | null
          vertical?: string
        }
        Update: {
          body?: string
          channel?: string
          company_id?: string
          created_at?: string
          generated_at?: string
          id?: string
          job_id?: string | null
          language?: string
          metadata?: Json
          status?: string
          subject?: string | null
          vertical?: string
        }
        Relationships: [
          {
            foreignKeyName: "b2b_outreach_messages_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "b2b_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "b2b_outreach_messages_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "b2b_search_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      b2b_search_jobs: {
        Row: {
          cost_eur: number
          counts: Json
          created_at: string
          created_by: string | null
          debug_id: string | null
          error_message: string | null
          filters: Json
          finished_at: string | null
          id: string
          mode: string
          product: string
          status: string
          vertical: string
          zone: Json
        }
        Insert: {
          cost_eur?: number
          counts?: Json
          created_at?: string
          created_by?: string | null
          debug_id?: string | null
          error_message?: string | null
          filters?: Json
          finished_at?: string | null
          id?: string
          mode?: string
          product?: string
          status?: string
          vertical?: string
          zone?: Json
        }
        Update: {
          cost_eur?: number
          counts?: Json
          created_at?: string
          created_by?: string | null
          debug_id?: string | null
          error_message?: string | null
          filters?: Json
          finished_at?: string | null
          id?: string
          mode?: string
          product?: string
          status?: string
          vertical?: string
          zone?: Json
        }
        Relationships: []
      }
      b2b_usage_ledger: {
        Row: {
          action: string
          cost_eur: number
          created_at: string
          day: string
          id: string
          job_id: string | null
          metadata: Json
          provider: string
          units: number
        }
        Insert: {
          action: string
          cost_eur?: number
          created_at?: string
          day?: string
          id?: string
          job_id?: string | null
          metadata?: Json
          provider: string
          units?: number
        }
        Update: {
          action?: string
          cost_eur?: number
          created_at?: string
          day?: string
          id?: string
          job_id?: string | null
          metadata?: Json
          provider?: string
          units?: number
        }
        Relationships: [
          {
            foreignKeyName: "b2b_usage_ledger_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "b2b_search_jobs"
            referencedColumns: ["id"]
          },
        ]
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
          billing_interval: string | null
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
          zona_assegnata: string | null
          zona_status: string
        }
        Insert: {
          agency_id: string
          app_id?: string
          billing_interval?: string | null
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
          zona_assegnata?: string | null
          zona_status?: string
        }
        Update: {
          agency_id?: string
          app_id?: string
          billing_interval?: string | null
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
          zona_assegnata?: string | null
          zona_status?: string
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
      civiko_admin_workspaces: {
        Row: {
          active: boolean
          created_at: string
          label: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          label?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          label?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: []
      }
      civiko_apify_run_reconciliations: {
        Row: {
          created_at: string
          evidence: Json
          id: number
          new_status: string
          portal: string
          previous_status: string
          reason: string
          reconciled_at: string
          rule: string
          run_id: string
        }
        Insert: {
          created_at?: string
          evidence?: Json
          id?: number
          new_status: string
          portal: string
          previous_status: string
          reason: string
          reconciled_at?: string
          rule: string
          run_id: string
        }
        Update: {
          created_at?: string
          evidence?: Json
          id?: number
          new_status?: string
          portal?: string
          previous_status?: string
          reason?: string
          reconciled_at?: string
          rule?: string
          run_id?: string
        }
        Relationships: []
      }
      civiko_commercial_zones: {
        Row: {
          agency_id: string | null
          attiva: boolean | null
          canone_mese_eur: number
          contendibili_count: number | null
          created_at: string | null
          descrizione: string | null
          id: string
          nome: string
          occupied_agency_id: string | null
          occupied_since: string | null
          omi_codes: string[]
          provvigioni_anno_eur: number | null
          slug: string
          status: string
          stripe_price_id: string | null
          tier: string
          trial_agency_id: string | null
          trial_reserved_until: string | null
        }
        Insert: {
          agency_id?: string | null
          attiva?: boolean | null
          canone_mese_eur: number
          contendibili_count?: number | null
          created_at?: string | null
          descrizione?: string | null
          id?: string
          nome: string
          occupied_agency_id?: string | null
          occupied_since?: string | null
          omi_codes: string[]
          provvigioni_anno_eur?: number | null
          slug: string
          status?: string
          stripe_price_id?: string | null
          tier: string
          trial_agency_id?: string | null
          trial_reserved_until?: string | null
        }
        Update: {
          agency_id?: string | null
          attiva?: boolean | null
          canone_mese_eur?: number
          contendibili_count?: number | null
          created_at?: string | null
          descrizione?: string | null
          id?: string
          nome?: string
          occupied_agency_id?: string | null
          occupied_since?: string | null
          omi_codes?: string[]
          provvigioni_anno_eur?: number | null
          slug?: string
          status?: string
          stripe_price_id?: string | null
          tier?: string
          trial_agency_id?: string | null
          trial_reserved_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "civiko_commercial_zones_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civiko_commercial_zones_occupied_agency_id_fkey"
            columns: ["occupied_agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civiko_commercial_zones_trial_agency_id_fkey"
            columns: ["trial_agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      civiko_commissioning_artifacts: {
        Row: {
          change_kind: string
          created_at: string
          evidence: Json
          id: string
          provider: string
          row_ref: string
          run_id: string
          table_name: string
        }
        Insert: {
          change_kind: string
          created_at?: string
          evidence?: Json
          id?: string
          provider: string
          row_ref: string
          run_id: string
          table_name: string
        }
        Update: {
          change_kind?: string
          created_at?: string
          evidence?: Json
          id?: string
          provider?: string
          row_ref?: string
          run_id?: string
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "civiko_commissioning_artifacts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "civiko_commissioning_runs"
            referencedColumns: ["run_id"]
          },
        ]
      }
      civiko_commissioning_baselines: {
        Row: {
          captured_at: string
          complete: boolean
          counters: Json
          created_at: string
          failed_queries: Json
          snapshot_id: string
          updated_at: string
        }
        Insert: {
          captured_at?: string
          complete?: boolean
          counters?: Json
          created_at?: string
          failed_queries?: Json
          snapshot_id?: string
          updated_at?: string
        }
        Update: {
          captured_at?: string
          complete?: boolean
          counters?: Json
          created_at?: string
          failed_queries?: Json
          snapshot_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      civiko_commissioning_claims: {
        Row: {
          claimed_at: string
          created_at: string
          expires_at: string
          provider: string
          run_id: string
          updated_at: string
        }
        Insert: {
          claimed_at?: string
          created_at?: string
          expires_at: string
          provider: string
          run_id: string
          updated_at?: string
        }
        Update: {
          claimed_at?: string
          created_at?: string
          expires_at?: string
          provider?: string
          run_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      civiko_commissioning_runs: {
        Row: {
          action: string
          actual_cost_usd: number
          applied_cap: Json | null
          baseline_snapshot_id: string | null
          cap_confirmed: boolean
          counters: Json
          created_at: string
          error_code: string | null
          finished_at: string | null
          provider: string
          requested_cap: Json
          run_id: string
          started_at: string
          status: string
          updated_at: string
        }
        Insert: {
          action: string
          actual_cost_usd?: number
          applied_cap?: Json | null
          baseline_snapshot_id?: string | null
          cap_confirmed?: boolean
          counters?: Json
          created_at?: string
          error_code?: string | null
          finished_at?: string | null
          provider: string
          requested_cap?: Json
          run_id: string
          started_at?: string
          status: string
          updated_at?: string
        }
        Update: {
          action?: string
          actual_cost_usd?: number
          applied_cap?: Json | null
          baseline_snapshot_id?: string | null
          cap_confirmed?: boolean
          counters?: Json
          created_at?: string
          error_code?: string | null
          finished_at?: string | null
          provider?: string
          requested_cap?: Json
          run_id?: string
          started_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "civiko_commissioning_runs_baseline_snapshot_id_fkey"
            columns: ["baseline_snapshot_id"]
            isOneToOne: false
            referencedRelation: "civiko_commissioning_baselines"
            referencedColumns: ["snapshot_id"]
          },
        ]
      }
      civiko_contendibili_evidence_attempts: {
        Row: {
          chiave_match: string
          commercial_zone_slug: string
          completed_at: string | null
          error_code: string | null
          evidence: Json | null
          last_attempt_at: string
          listing_id: number
          queue_id: string | null
          run_id: string | null
          status: string
          updated_at: string
          url: string
        }
        Insert: {
          chiave_match: string
          commercial_zone_slug: string
          completed_at?: string | null
          error_code?: string | null
          evidence?: Json | null
          last_attempt_at?: string
          listing_id: number
          queue_id?: string | null
          run_id?: string | null
          status: string
          updated_at?: string
          url: string
        }
        Update: {
          chiave_match?: string
          commercial_zone_slug?: string
          completed_at?: string | null
          error_code?: string | null
          evidence?: Json | null
          last_attempt_at?: string
          listing_id?: number
          queue_id?: string | null
          run_id?: string | null
          status?: string
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "civiko_contendibili_evidence_attempts_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: true
            referencedRelation: "civiko_padova_tipo_lead_mismatch_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civiko_contendibili_evidence_attempts_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: true
            referencedRelation: "padova_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civiko_contendibili_evidence_attempts_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: true
            referencedRelation: "padova_listings_zone_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civiko_contendibili_evidence_attempts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "civiko_contendibili_evidence_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      civiko_contendibili_evidence_runs: {
        Row: {
          candidates_found: number
          completed_at: string | null
          enqueued: number
          error_code: string | null
          evidence_with_civico: number
          evidence_with_piano: number
          failed: number
          groups_considered: number
          groups_eligible: number
          groups_forbidden: number
          groups_invalid: number
          id: string
          processed: number
          requested_limit: number
          run_date: string
          started_at: string
          status: string
        }
        Insert: {
          candidates_found?: number
          completed_at?: string | null
          enqueued?: number
          error_code?: string | null
          evidence_with_civico?: number
          evidence_with_piano?: number
          failed?: number
          groups_considered?: number
          groups_eligible?: number
          groups_forbidden?: number
          groups_invalid?: number
          id: string
          processed?: number
          requested_limit?: number
          run_date: string
          started_at?: string
          status: string
        }
        Update: {
          candidates_found?: number
          completed_at?: string | null
          enqueued?: number
          error_code?: string | null
          evidence_with_civico?: number
          evidence_with_piano?: number
          failed?: number
          groups_considered?: number
          groups_eligible?: number
          groups_forbidden?: number
          groups_invalid?: number
          id?: string
          processed?: number
          requested_limit?: number
          run_date?: string
          started_at?: string
          status?: string
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
      civiko_evidence: {
        Row: {
          compliance_visibility: string
          confidence: string
          created_at: string
          entity_key: string
          entity_type: string
          evidence_type: string
          evidence_value: Json | null
          explanation: string | null
          freshness_days: number | null
          id: number
          observed_at: string
          raw_ref_id: string | null
          source_code: string
        }
        Insert: {
          compliance_visibility?: string
          confidence: string
          created_at?: string
          entity_key: string
          entity_type: string
          evidence_type: string
          evidence_value?: Json | null
          explanation?: string | null
          freshness_days?: number | null
          id?: number
          observed_at?: string
          raw_ref_id?: string | null
          source_code: string
        }
        Update: {
          compliance_visibility?: string
          confidence?: string
          created_at?: string
          entity_key?: string
          entity_type?: string
          evidence_type?: string
          evidence_value?: Json | null
          explanation?: string | null
          freshness_days?: number | null
          id?: number
          observed_at?: string
          raw_ref_id?: string | null
          source_code?: string
        }
        Relationships: []
      }
      civiko_image_certify_attempts: {
        Row: {
          attempts: number
          created_at: string
          image_source_fp: string | null
          last_attempt_at: string
          last_outcome: string | null
          last_pipeline_run_id: string | null
          listing_id: number
          terminal: boolean
          terminal_reason: string | null
        }
        Insert: {
          attempts?: number
          created_at?: string
          image_source_fp?: string | null
          last_attempt_at?: string
          last_outcome?: string | null
          last_pipeline_run_id?: string | null
          listing_id: number
          terminal?: boolean
          terminal_reason?: string | null
        }
        Update: {
          attempts?: number
          created_at?: string
          image_source_fp?: string | null
          last_attempt_at?: string
          last_outcome?: string | null
          last_pipeline_run_id?: string | null
          listing_id?: number
          terminal?: boolean
          terminal_reason?: string | null
        }
        Relationships: []
      }
      civiko_listing_image_fingerprints: {
        Row: {
          algo: string
          bytes: number
          created_at: string
          entropy: number
          height: number
          listing_id: number
          phash: string
          sha256: string
          source_host: string | null
          updated_at: string
          width: number
        }
        Insert: {
          algo: string
          bytes: number
          created_at?: string
          entropy: number
          height: number
          listing_id: number
          phash: string
          sha256: string
          source_host?: string | null
          updated_at?: string
          width: number
        }
        Update: {
          algo?: string
          bytes?: number
          created_at?: string
          entropy?: number
          height?: number
          listing_id?: number
          phash?: string
          sha256?: string
          source_host?: string | null
          updated_at?: string
          width?: number
        }
        Relationships: []
      }
      civiko_listing_photo_pair_evidence: {
        Row: {
          agency_a: string
          agency_b: string
          algo: string
          computed_at: string
          distances: Json
          evidence_kind: string
          listing_a: number
          listing_b: number
          match_version: string
          shared_photos: number
          soglia: number
          updated_at: string
        }
        Insert: {
          agency_a: string
          agency_b: string
          algo: string
          computed_at?: string
          distances?: Json
          evidence_kind: string
          listing_a: number
          listing_b: number
          match_version: string
          shared_photos: number
          soglia: number
          updated_at?: string
        }
        Update: {
          agency_a?: string
          agency_b?: string
          algo?: string
          computed_at?: string
          distances?: Json
          evidence_kind?: string
          listing_a?: number
          listing_b?: number
          match_version?: string
          shared_photos?: number
          soglia?: number
          updated_at?: string
        }
        Relationships: []
      }
      civiko_one_generated_outputs: {
        Row: {
          agency_id: string
          case_id: string
          content_jsonb: Json
          cost_eur: number | null
          created_at: string
          generated_by: string | null
          id: string
          kind: Database["public"]["Enums"]["civiko_one_output_kind"]
          model_used: string | null
          storage_path: string | null
          version: number
          warnings: Json
        }
        Insert: {
          agency_id: string
          case_id: string
          content_jsonb?: Json
          cost_eur?: number | null
          created_at?: string
          generated_by?: string | null
          id?: string
          kind: Database["public"]["Enums"]["civiko_one_output_kind"]
          model_used?: string | null
          storage_path?: string | null
          version?: number
          warnings?: Json
        }
        Update: {
          agency_id?: string
          case_id?: string
          content_jsonb?: Json
          cost_eur?: number | null
          created_at?: string
          generated_by?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["civiko_one_output_kind"]
          model_used?: string | null
          storage_path?: string | null
          version?: number
          warnings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "civiko_one_generated_outputs_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civiko_one_generated_outputs_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "civiko_one_property_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      civiko_one_property_cases: {
        Row: {
          address_text: string | null
          agency_id: string
          ask_price: number | null
          assigned_agent_id: string | null
          bathrooms: number | null
          cap: string | null
          civico: string | null
          created_at: string
          created_by: string
          draft_jsonb: Json
          energy_class: string | null
          floor: string | null
          id: string
          lat: number | null
          lng: number | null
          microzone: string | null
          municipality: string | null
          notes: string | null
          property_type: string | null
          province: string | null
          rooms: number | null
          status: Database["public"]["Enums"]["civiko_one_case_status"]
          surface_mq: number | null
          title: string
          updated_at: string
          year_built: number | null
        }
        Insert: {
          address_text?: string | null
          agency_id: string
          ask_price?: number | null
          assigned_agent_id?: string | null
          bathrooms?: number | null
          cap?: string | null
          civico?: string | null
          created_at?: string
          created_by: string
          draft_jsonb?: Json
          energy_class?: string | null
          floor?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          microzone?: string | null
          municipality?: string | null
          notes?: string | null
          property_type?: string | null
          province?: string | null
          rooms?: number | null
          status?: Database["public"]["Enums"]["civiko_one_case_status"]
          surface_mq?: number | null
          title: string
          updated_at?: string
          year_built?: number | null
        }
        Update: {
          address_text?: string | null
          agency_id?: string
          ask_price?: number | null
          assigned_agent_id?: string | null
          bathrooms?: number | null
          cap?: string | null
          civico?: string | null
          created_at?: string
          created_by?: string
          draft_jsonb?: Json
          energy_class?: string | null
          floor?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          microzone?: string | null
          municipality?: string | null
          notes?: string | null
          property_type?: string | null
          province?: string | null
          rooms?: number | null
          status?: Database["public"]["Enums"]["civiko_one_case_status"]
          surface_mq?: number | null
          title?: string
          updated_at?: string
          year_built?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "civiko_one_property_cases_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      civiko_one_property_documents: {
        Row: {
          agency_id: string
          case_id: string
          created_at: string
          display_name: string
          doc_type: string
          id: string
          notes: string | null
          required: boolean
          status: Database["public"]["Enums"]["civiko_one_doc_status"]
          storage_path: string | null
          updated_at: string
          uploaded_by: string | null
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          agency_id: string
          case_id: string
          created_at?: string
          display_name: string
          doc_type: string
          id?: string
          notes?: string | null
          required?: boolean
          status?: Database["public"]["Enums"]["civiko_one_doc_status"]
          storage_path?: string | null
          updated_at?: string
          uploaded_by?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          agency_id?: string
          case_id?: string
          created_at?: string
          display_name?: string
          doc_type?: string
          id?: string
          notes?: string | null
          required?: boolean
          status?: Database["public"]["Enums"]["civiko_one_doc_status"]
          storage_path?: string | null
          updated_at?: string
          uploaded_by?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "civiko_one_property_documents_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civiko_one_property_documents_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "civiko_one_property_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      civiko_one_property_photos: {
        Row: {
          agency_id: string
          bytes: number | null
          caption: string | null
          case_id: string
          created_at: string
          height: number | null
          id: string
          is_cover: boolean
          sort_order: number
          storage_path: string
          uploaded_by: string
          width: number | null
        }
        Insert: {
          agency_id: string
          bytes?: number | null
          caption?: string | null
          case_id: string
          created_at?: string
          height?: number | null
          id?: string
          is_cover?: boolean
          sort_order?: number
          storage_path: string
          uploaded_by: string
          width?: number | null
        }
        Update: {
          agency_id?: string
          bytes?: number | null
          caption?: string | null
          case_id?: string
          created_at?: string
          height?: number | null
          id?: string
          is_cover?: boolean
          sort_order?: number
          storage_path?: string
          uploaded_by?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "civiko_one_property_photos_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civiko_one_property_photos_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "civiko_one_property_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      civiko_orchestrator_action_runs: {
        Row: {
          action: string
          attempt_no: number
          counters: Json
          created_at: string
          duration_ms: number | null
          error_code: string | null
          finished_at: string | null
          http_status: number | null
          id: string
          ok: boolean | null
          pipeline: string | null
          pipeline_action: string | null
          pipeline_run_id: string | null
          result: Json
          run_id: string
          started_at: string
          status: number | null
          target: string | null
        }
        Insert: {
          action: string
          attempt_no?: number
          counters?: Json
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          finished_at?: string | null
          http_status?: number | null
          id?: string
          ok?: boolean | null
          pipeline?: string | null
          pipeline_action?: string | null
          pipeline_run_id?: string | null
          result?: Json
          run_id: string
          started_at?: string
          status?: number | null
          target?: string | null
        }
        Update: {
          action?: string
          attempt_no?: number
          counters?: Json
          created_at?: string
          duration_ms?: number | null
          error_code?: string | null
          finished_at?: string | null
          http_status?: number | null
          id?: string
          ok?: boolean | null
          pipeline?: string | null
          pipeline_action?: string | null
          pipeline_run_id?: string | null
          result?: Json
          run_id?: string
          started_at?: string
          status?: number | null
          target?: string | null
        }
        Relationships: []
      }
      civiko_pipeline_runs: {
        Row: {
          created_at: string
          error_code: string | null
          finished_at: string | null
          ok: boolean | null
          pipeline: string
          pipeline_run_id: string | null
          run_id: string
          started_at: string
          steps: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          error_code?: string | null
          finished_at?: string | null
          ok?: boolean | null
          pipeline: string
          pipeline_run_id?: string | null
          run_id: string
          started_at?: string
          steps?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          error_code?: string | null
          finished_at?: string | null
          ok?: boolean | null
          pipeline?: string
          pipeline_run_id?: string | null
          run_id?: string
          started_at?: string
          steps?: Json
          updated_at?: string
        }
        Relationships: []
      }
      civiko_pwa_sync_acks: {
        Row: {
          commercial_zone_slugs: string[]
          counts: Json
          created_at: string
          error_code: string | null
          finished_at: string
          idempotency_key: string | null
          municipality: string
          ok: boolean
          pipeline_run_id: string
          run_id: string
          scope_comune: string | null
          scope_slugs: string[] | null
          source_app: string
          started_at: string
          updated_at: string
        }
        Insert: {
          commercial_zone_slugs: string[]
          counts?: Json
          created_at?: string
          error_code?: string | null
          finished_at: string
          idempotency_key?: string | null
          municipality: string
          ok: boolean
          pipeline_run_id: string
          run_id: string
          scope_comune?: string | null
          scope_slugs?: string[] | null
          source_app: string
          started_at: string
          updated_at?: string
        }
        Update: {
          commercial_zone_slugs?: string[]
          counts?: Json
          created_at?: string
          error_code?: string | null
          finished_at?: string
          idempotency_key?: string | null
          municipality?: string
          ok?: boolean
          pipeline_run_id?: string
          run_id?: string
          scope_comune?: string | null
          scope_slugs?: string[] | null
          source_app?: string
          started_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      civiko_quartiere_commercial_zone_map: {
        Row: {
          commercial_zone_slug: string
          created_at: string
          quartiere_key: string
        }
        Insert: {
          commercial_zone_slug: string
          created_at?: string
          quartiere_key: string
        }
        Update: {
          commercial_zone_slug?: string
          created_at?: string
          quartiere_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "civiko_quartiere_commercial_zone_map_commercial_zone_slug_fkey"
            columns: ["commercial_zone_slug"]
            isOneToOne: false
            referencedRelation: "civiko_commercial_zones"
            referencedColumns: ["slug"]
          },
        ]
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
          automation_notes: string | null
          automation_status: string | null
          automation_todo: string | null
          compliance_level: string
          created_at: string
          cross_check_enabled: boolean
          freshness_days: number | null
          id: string
          implementation_status: string
          ingestion_endpoint: string | null
          last_error: string | null
          last_run_at: string | null
          last_success_at: string | null
          next_run_at: string | null
          notes: string | null
          record_count: number
          refresh_frequency: string | null
          scheduler_frequency: string | null
          scheduler_job_name: string | null
          source_code: string
          source_name: string
          source_url: string | null
          stale_after_days: number | null
          updated_at: string
        }
        Insert: {
          access_type: string
          activation_mode?: string | null
          automation_notes?: string | null
          automation_status?: string | null
          automation_todo?: string | null
          compliance_level: string
          created_at?: string
          cross_check_enabled?: boolean
          freshness_days?: number | null
          id?: string
          implementation_status: string
          ingestion_endpoint?: string | null
          last_error?: string | null
          last_run_at?: string | null
          last_success_at?: string | null
          next_run_at?: string | null
          notes?: string | null
          record_count?: number
          refresh_frequency?: string | null
          scheduler_frequency?: string | null
          scheduler_job_name?: string | null
          source_code: string
          source_name: string
          source_url?: string | null
          stale_after_days?: number | null
          updated_at?: string
        }
        Update: {
          access_type?: string
          activation_mode?: string | null
          automation_notes?: string | null
          automation_status?: string | null
          automation_todo?: string | null
          compliance_level?: string
          created_at?: string
          cross_check_enabled?: boolean
          freshness_days?: number | null
          id?: string
          implementation_status?: string
          ingestion_endpoint?: string | null
          last_error?: string | null
          last_run_at?: string | null
          last_success_at?: string | null
          next_run_at?: string | null
          notes?: string | null
          record_count?: number
          refresh_frequency?: string | null
          scheduler_frequency?: string | null
          scheduler_job_name?: string | null
          source_code?: string
          source_name?: string
          source_url?: string | null
          stale_after_days?: number | null
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
      cron_alerts_pending: {
        Row: {
          acknowledged_at: string | null
          created_at: string
          id: number
          message: string
          severity: string
          source: string | null
        }
        Insert: {
          acknowledged_at?: string | null
          created_at?: string
          id?: number
          message: string
          severity?: string
          source?: string | null
        }
        Update: {
          acknowledged_at?: string | null
          created_at?: string
          id?: number
          message?: string
          severity?: string
          source?: string | null
        }
        Relationships: []
      }
      cron_executions_log: {
        Row: {
          completed_at: string | null
          duration_ms: number | null
          error_message: string | null
          http_request_id: number | null
          http_status: number | null
          id: number
          job_name: string
          response_excerpt: string | null
          status: string
          triggered_at: string
        }
        Insert: {
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          http_request_id?: number | null
          http_status?: number | null
          id?: number
          job_name: string
          response_excerpt?: string | null
          status: string
          triggered_at?: string
        }
        Update: {
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          http_request_id?: number | null
          http_status?: number | null
          id?: number
          job_name?: string
          response_excerpt?: string | null
          status?: string
          triggered_at?: string
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
          quartiere: string | null
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
          quartiere?: string | null
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
          quartiere?: string | null
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
      firecrawl_spend_daily: {
        Row: {
          calls: number
          day_utc: string
          est_usd: number
          pages: number
          updated_at: string
        }
        Insert: {
          calls?: number
          day_utc: string
          est_usd?: number
          pages?: number
          updated_at?: string
        }
        Update: {
          calls?: number
          day_utc?: string
          est_usd?: number
          pages?: number
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
      listing_agency_enrichment: {
        Row: {
          agency_logo_url: string | null
          agency_phone: string | null
          agency_url: string | null
          confidence: string | null
          enriched_at: string
          error: string | null
          extraction_method: string | null
          id: number
          listing_url: string
          normalized_agency_name: string | null
          portal: string
          raw_agency_name: string | null
          raw_excerpt: Json | null
        }
        Insert: {
          agency_logo_url?: string | null
          agency_phone?: string | null
          agency_url?: string | null
          confidence?: string | null
          enriched_at?: string
          error?: string | null
          extraction_method?: string | null
          id?: number
          listing_url: string
          normalized_agency_name?: string | null
          portal: string
          raw_agency_name?: string | null
          raw_excerpt?: Json | null
        }
        Update: {
          agency_logo_url?: string | null
          agency_phone?: string | null
          agency_url?: string | null
          confidence?: string | null
          enriched_at?: string
          error?: string | null
          extraction_method?: string | null
          id?: number
          listing_url?: string
          normalized_agency_name?: string | null
          portal?: string
          raw_agency_name?: string | null
          raw_excerpt?: Json | null
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
          cap: string | null
          category: string | null
          completeness_score: number
          created_at: string
          data_rilevamento: string
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
          predictive_insight: string | null
          priority: string | null
          priority_score: number
          property_type: string | null
          quality_bucket: string | null
          raw_id: string | null
          scoring_reason: string | null
          source_name: string
          source_url: string | null
          status: string | null
          surface_mq: number | null
          tags: string[]
          title: string
          updated_at: string
          valore_omi_max: number | null
          valore_omi_min: number | null
        }
        Insert: {
          address_text?: string | null
          ask_price?: number | null
          cap?: string | null
          category?: string | null
          completeness_score?: number
          created_at?: string
          data_rilevamento?: string
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
          predictive_insight?: string | null
          priority?: string | null
          priority_score?: number
          property_type?: string | null
          quality_bucket?: string | null
          raw_id?: string | null
          scoring_reason?: string | null
          source_name: string
          source_url?: string | null
          status?: string | null
          surface_mq?: number | null
          tags?: string[]
          title: string
          updated_at?: string
          valore_omi_max?: number | null
          valore_omi_min?: number | null
        }
        Update: {
          address_text?: string | null
          ask_price?: number | null
          cap?: string | null
          category?: string | null
          completeness_score?: number
          created_at?: string
          data_rilevamento?: string
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
          predictive_insight?: string | null
          priority?: string | null
          priority_score?: number
          property_type?: string | null
          quality_bucket?: string | null
          raw_id?: string | null
          scoring_reason?: string | null
          source_name?: string
          source_url?: string | null
          status?: string | null
          surface_mq?: number | null
          tags?: string[]
          title?: string
          updated_at?: string
          valore_omi_max?: number | null
          valore_omi_min?: number | null
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
          computed_at: string
          confidence: string
          id: number
          imported_at: string
          last_observed_at: string | null
          source_code: string
          source_url: string | null
          visible_to_pwa: boolean
          window_days: number
          window_end: string
          window_start: string
        }
        Insert: {
          area_code: string
          area_type: string
          bucket_count: number
          computed_at?: string
          confidence?: string
          id?: number
          imported_at?: string
          last_observed_at?: string | null
          source_code?: string
          source_url?: string | null
          visible_to_pwa?: boolean
          window_days: number
          window_end: string
          window_start: string
        }
        Update: {
          area_code?: string
          area_type?: string
          bucket_count?: number
          computed_at?: string
          confidence?: string
          id?: number
          imported_at?: string
          last_observed_at?: string | null
          source_code?: string
          source_url?: string | null
          visible_to_pwa?: boolean
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
      operational_mode: {
        Row: {
          ai_daily_cap_usd: number
          firecrawl_daily_cap_credits: number
          heavy_cron_every_n_days: number
          id: number
          mode: string
          monthly_cap_usd: number
          test_ends_at: string | null
          test_started_at: string | null
          updated_at: string
        }
        Insert: {
          ai_daily_cap_usd?: number
          firecrawl_daily_cap_credits?: number
          heavy_cron_every_n_days?: number
          id?: number
          mode?: string
          monthly_cap_usd?: number
          test_ends_at?: string | null
          test_started_at?: string | null
          updated_at?: string
        }
        Update: {
          ai_daily_cap_usd?: number
          firecrawl_daily_cap_credits?: number
          heavy_cron_every_n_days?: number
          id?: number
          mode?: string
          monthly_cap_usd?: number
          test_ends_at?: string | null
          test_started_at?: string | null
          updated_at?: string
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
      padova_apify_runs: {
        Row: {
          actor_id: string
          cost_cap_usd: number
          cost_usd: number | null
          dataset_id: string | null
          error: string | null
          finished_at: string | null
          id: number
          imported: number | null
          items_count: number | null
          portal: string
          run_id: string
          started_at: string
          status: string
        }
        Insert: {
          actor_id: string
          cost_cap_usd: number
          cost_usd?: number | null
          dataset_id?: string | null
          error?: string | null
          finished_at?: string | null
          id?: number
          imported?: number | null
          items_count?: number | null
          portal: string
          run_id: string
          started_at?: string
          status?: string
        }
        Update: {
          actor_id?: string
          cost_cap_usd?: number
          cost_usd?: number | null
          dataset_id?: string | null
          error?: string | null
          finished_at?: string | null
          id?: number
          imported?: number | null
          items_count?: number | null
          portal?: string
          run_id?: string
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      padova_cambi_agenzia: {
        Row: {
          agenzia_nuova: string
          agenzia_precedente: string
          canon_url: string
          commercial_zone_slug: string | null
          contendibile_overlap: boolean
          created_at: string
          data_cambio: string
          first_detected_at: string
          id: string
          indirizzo: string | null
          is_active: boolean
          last_seen_at: string
          locali: number | null
          mq: number | null
          portale: string | null
          prezzo_eur: number | null
          quartiere: string | null
          titolo: string | null
          updated_at: string
          zona_omi: string | null
        }
        Insert: {
          agenzia_nuova: string
          agenzia_precedente: string
          canon_url: string
          commercial_zone_slug?: string | null
          contendibile_overlap?: boolean
          created_at?: string
          data_cambio: string
          first_detected_at?: string
          id?: string
          indirizzo?: string | null
          is_active?: boolean
          last_seen_at?: string
          locali?: number | null
          mq?: number | null
          portale?: string | null
          prezzo_eur?: number | null
          quartiere?: string | null
          titolo?: string | null
          updated_at?: string
          zona_omi?: string | null
        }
        Update: {
          agenzia_nuova?: string
          agenzia_precedente?: string
          canon_url?: string
          commercial_zone_slug?: string | null
          contendibile_overlap?: boolean
          created_at?: string
          data_cambio?: string
          first_detected_at?: string
          id?: string
          indirizzo?: string | null
          is_active?: boolean
          last_seen_at?: string
          locali?: number | null
          mq?: number | null
          portale?: string | null
          prezzo_eur?: number | null
          quartiere?: string | null
          titolo?: string | null
          updated_at?: string
          zona_omi?: string | null
        }
        Relationships: []
      }
      padova_casa_staging: {
        Row: {
          fetched_at: string
          id: number
          raw_json: Json
        }
        Insert: {
          fetched_at?: string
          id?: number
          raw_json: Json
        }
        Update: {
          fetched_at?: string
          id?: number
          raw_json?: Json
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
      padova_collect_v2_items: {
        Row: {
          agency: string | null
          agency_phone: string | null
          anno_costruzione: number | null
          attempts: number
          bagni: number | null
          cap: string | null
          citta: string | null
          civico: string | null
          cluster_key: string | null
          contendibile: boolean | null
          contendibile_confidenza: string | null
          contendibile_group_id: string | null
          created_at: string
          http_status: number | null
          id: number
          job_id: string
          lat: number | null
          listing_id: string | null
          lng: number | null
          locali: number | null
          log_reason: string | null
          mq: number | null
          n_agenzie: number | null
          omi_zone: string | null
          parse_status: string | null
          piano: string | null
          portal: string
          previous_price_eur: number | null
          prezzo: number | null
          prezzo_iniziale: number | null
          processed_at: string | null
          quartiere: string | null
          raw_address: string | null
          raw_json: Json | null
          ribasso_date: string | null
          ribasso_eur: number | null
          ribasso_pct: number | null
          riscaldamento: string | null
          stato: string | null
          tipo_lead: string | null
          tipologia: string | null
          updated_at: string | null
          url: string | null
        }
        Insert: {
          agency?: string | null
          agency_phone?: string | null
          anno_costruzione?: number | null
          attempts?: number
          bagni?: number | null
          cap?: string | null
          citta?: string | null
          civico?: string | null
          cluster_key?: string | null
          contendibile?: boolean | null
          contendibile_confidenza?: string | null
          contendibile_group_id?: string | null
          created_at?: string
          http_status?: number | null
          id?: number
          job_id: string
          lat?: number | null
          listing_id?: string | null
          lng?: number | null
          locali?: number | null
          log_reason?: string | null
          mq?: number | null
          n_agenzie?: number | null
          omi_zone?: string | null
          parse_status?: string | null
          piano?: string | null
          portal: string
          previous_price_eur?: number | null
          prezzo?: number | null
          prezzo_iniziale?: number | null
          processed_at?: string | null
          quartiere?: string | null
          raw_address?: string | null
          raw_json?: Json | null
          ribasso_date?: string | null
          ribasso_eur?: number | null
          ribasso_pct?: number | null
          riscaldamento?: string | null
          stato?: string | null
          tipo_lead?: string | null
          tipologia?: string | null
          updated_at?: string | null
          url?: string | null
        }
        Update: {
          agency?: string | null
          agency_phone?: string | null
          anno_costruzione?: number | null
          attempts?: number
          bagni?: number | null
          cap?: string | null
          citta?: string | null
          civico?: string | null
          cluster_key?: string | null
          contendibile?: boolean | null
          contendibile_confidenza?: string | null
          contendibile_group_id?: string | null
          created_at?: string
          http_status?: number | null
          id?: number
          job_id?: string
          lat?: number | null
          listing_id?: string | null
          lng?: number | null
          locali?: number | null
          log_reason?: string | null
          mq?: number | null
          n_agenzie?: number | null
          omi_zone?: string | null
          parse_status?: string | null
          piano?: string | null
          portal?: string
          previous_price_eur?: number | null
          prezzo?: number | null
          prezzo_iniziale?: number | null
          processed_at?: string | null
          quartiere?: string | null
          raw_address?: string | null
          raw_json?: Json | null
          ribasso_date?: string | null
          ribasso_eur?: number | null
          ribasso_pct?: number | null
          riscaldamento?: string | null
          stato?: string | null
          tipo_lead?: string | null
          tipologia?: string | null
          updated_at?: string | null
          url?: string | null
        }
        Relationships: []
      }
      padova_contendibili: {
        Row: {
          agencies_normalized: string[] | null
          agency_count_distinct: number | null
          agency_count_raw: number | null
          agenzie: string[]
          bagni: number | null
          cambio_agenzia: boolean | null
          cambio_agenzia_a: string | null
          cambio_agenzia_da: string | null
          cambio_agenzia_data: string | null
          chiave_match: string
          commercial_zone_slug: string
          confidenza: string
          created_at: string
          data_primo_annuncio: string | null
          differenza_zona_pct: number | null
          evidence_kind: string | null
          evidence_ref: string | null
          fonti: string[]
          giorni_fermo: number | null
          giorni_sul_mercato: number | null
          id: number
          is_ripubblicato: boolean | null
          last_seen_at: string | null
          lat: number | null
          lng: number | null
          locali: number | null
          match_metrics: Json | null
          match_version: string | null
          mq: number | null
          n_agenzie: number
          n_annunci: number
          n_portali: number | null
          n_ribassi: number | null
          portals_seen: string[] | null
          prezzo_immobile_eur_mq: number | null
          prezzo_max: number | null
          prezzo_medio_zona_eur_mq: number | null
          prezzo_min: number | null
          quartiere: string | null
          ribasso_pct: number | null
          score_pressione: number | null
          updated_at: string
          urls: string[]
        }
        Insert: {
          agencies_normalized?: string[] | null
          agency_count_distinct?: number | null
          agency_count_raw?: number | null
          agenzie: string[]
          bagni?: number | null
          cambio_agenzia?: boolean | null
          cambio_agenzia_a?: string | null
          cambio_agenzia_da?: string | null
          cambio_agenzia_data?: string | null
          chiave_match: string
          commercial_zone_slug: string
          confidenza: string
          created_at?: string
          data_primo_annuncio?: string | null
          differenza_zona_pct?: number | null
          evidence_kind?: string | null
          evidence_ref?: string | null
          fonti: string[]
          giorni_fermo?: number | null
          giorni_sul_mercato?: number | null
          id?: number
          is_ripubblicato?: boolean | null
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          match_metrics?: Json | null
          match_version?: string | null
          mq?: number | null
          n_agenzie: number
          n_annunci: number
          n_portali?: number | null
          n_ribassi?: number | null
          portals_seen?: string[] | null
          prezzo_immobile_eur_mq?: number | null
          prezzo_max?: number | null
          prezzo_medio_zona_eur_mq?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          ribasso_pct?: number | null
          score_pressione?: number | null
          updated_at?: string
          urls: string[]
        }
        Update: {
          agencies_normalized?: string[] | null
          agency_count_distinct?: number | null
          agency_count_raw?: number | null
          agenzie?: string[]
          bagni?: number | null
          cambio_agenzia?: boolean | null
          cambio_agenzia_a?: string | null
          cambio_agenzia_da?: string | null
          cambio_agenzia_data?: string | null
          chiave_match?: string
          commercial_zone_slug?: string
          confidenza?: string
          created_at?: string
          data_primo_annuncio?: string | null
          differenza_zona_pct?: number | null
          evidence_kind?: string | null
          evidence_ref?: string | null
          fonti?: string[]
          giorni_fermo?: number | null
          giorni_sul_mercato?: number | null
          id?: number
          is_ripubblicato?: boolean | null
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          match_metrics?: Json | null
          match_version?: string | null
          mq?: number | null
          n_agenzie?: number
          n_annunci?: number
          n_portali?: number | null
          n_ribassi?: number | null
          portals_seen?: string[] | null
          prezzo_immobile_eur_mq?: number | null
          prezzo_max?: number | null
          prezzo_medio_zona_eur_mq?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          ribasso_pct?: number | null
          score_pressione?: number | null
          updated_at?: string
          urls?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "padova_contendibili_commercial_zone_slug_fkey"
            columns: ["commercial_zone_slug"]
            isOneToOne: false
            referencedRelation: "civiko_commercial_zones"
            referencedColumns: ["slug"]
          },
        ]
      }
      padova_contendibili_quarantena: {
        Row: {
          agenzie: string[] | null
          bagni: number | null
          chiave_match: string | null
          commercial_zone_slug: string | null
          confidenza: string | null
          fonti: string[] | null
          id: number
          lat: number | null
          lng: number | null
          locali: number | null
          match_version: string | null
          metriche: Json | null
          motivi: string[] | null
          motivo: string
          mq: number | null
          n_agenzie: number | null
          n_annunci: number | null
          prezzo_max: number | null
          prezzo_min: number | null
          quarantined_at: string
          quartiere: string | null
          urls: string[] | null
        }
        Insert: {
          agenzie?: string[] | null
          bagni?: number | null
          chiave_match?: string | null
          commercial_zone_slug?: string | null
          confidenza?: string | null
          fonti?: string[] | null
          id?: number
          lat?: number | null
          lng?: number | null
          locali?: number | null
          match_version?: string | null
          metriche?: Json | null
          motivi?: string[] | null
          motivo: string
          mq?: number | null
          n_agenzie?: number | null
          n_annunci?: number | null
          prezzo_max?: number | null
          prezzo_min?: number | null
          quarantined_at?: string
          quartiere?: string | null
          urls?: string[] | null
        }
        Update: {
          agenzie?: string[] | null
          bagni?: number | null
          chiave_match?: string | null
          commercial_zone_slug?: string | null
          confidenza?: string | null
          fonti?: string[] | null
          id?: number
          lat?: number | null
          lng?: number | null
          locali?: number | null
          match_version?: string | null
          metriche?: Json | null
          motivi?: string[] | null
          motivo?: string
          mq?: number | null
          n_agenzie?: number | null
          n_annunci?: number | null
          prezzo_max?: number | null
          prezzo_min?: number | null
          quarantined_at?: string
          quartiere?: string | null
          urls?: string[] | null
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
      padova_firecrawl_jobs: {
        Row: {
          annunci_fail: number
          annunci_ok: number
          annunci_processati: number
          annunci_totali: number
          cov_agency: number
          cov_bagni: number
          cov_civico: number
          cov_latlng: number
          cov_locali: number
          cov_mq: number
          cov_piano: number
          cov_tipologia: number
          fallback_apify_usati: number
          finished_at: string | null
          job_id: string
          last_error: string | null
          source_job_id: string | null
          spesa_apify_usd: number
          spesa_firecrawl_usd: number
          started_at: string
          status: string
          updated_at: string
        }
        Insert: {
          annunci_fail?: number
          annunci_ok?: number
          annunci_processati?: number
          annunci_totali?: number
          cov_agency?: number
          cov_bagni?: number
          cov_civico?: number
          cov_latlng?: number
          cov_locali?: number
          cov_mq?: number
          cov_piano?: number
          cov_tipologia?: number
          fallback_apify_usati?: number
          finished_at?: string | null
          job_id: string
          last_error?: string | null
          source_job_id?: string | null
          spesa_apify_usd?: number
          spesa_firecrawl_usd?: number
          started_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          annunci_fail?: number
          annunci_ok?: number
          annunci_processati?: number
          annunci_totali?: number
          cov_agency?: number
          cov_bagni?: number
          cov_civico?: number
          cov_latlng?: number
          cov_locali?: number
          cov_mq?: number
          cov_piano?: number
          cov_tipologia?: number
          fallback_apify_usati?: number
          finished_at?: string | null
          job_id?: string
          last_error?: string | null
          source_job_id?: string | null
          spesa_apify_usd?: number
          spesa_firecrawl_usd?: number
          started_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      padova_idealista_staging: {
        Row: {
          agency: string | null
          bagni: number | null
          fetched_at: string
          id: number
          indirizzo: string | null
          lat: number | null
          lng: number | null
          locali: number | null
          mq: number | null
          prezzo: number | null
          raw_json: Json | null
          tipo_lead: string | null
          url: string | null
        }
        Insert: {
          agency?: string | null
          bagni?: number | null
          fetched_at?: string
          id?: number
          indirizzo?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          prezzo?: number | null
          raw_json?: Json | null
          tipo_lead?: string | null
          url?: string | null
        }
        Update: {
          agency?: string | null
          bagni?: number | null
          fetched_at?: string
          id?: number
          indirizzo?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          prezzo?: number | null
          raw_json?: Json | null
          tipo_lead?: string | null
          url?: string | null
        }
        Relationships: []
      }
      padova_immobiliare_detail_staging: {
        Row: {
          agency: string | null
          bagni: number | null
          fetched_at: string
          id: number
          indirizzo: string | null
          lat: number | null
          lng: number | null
          locali: number | null
          mq: number | null
          prezzo: number | null
          raw_json: Json | null
          run_id: string | null
          tipo_lead: string | null
          url: string | null
        }
        Insert: {
          agency?: string | null
          bagni?: number | null
          fetched_at?: string
          id?: number
          indirizzo?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          prezzo?: number | null
          raw_json?: Json | null
          run_id?: string | null
          tipo_lead?: string | null
          url?: string | null
        }
        Update: {
          agency?: string | null
          bagni?: number | null
          fetched_at?: string
          id?: number
          indirizzo?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          prezzo?: number | null
          raw_json?: Json | null
          run_id?: string | null
          tipo_lead?: string | null
          url?: string | null
        }
        Relationships: []
      }
      padova_listings: {
        Row: {
          agency: string | null
          bagni: number | null
          commercial_zone_slug: string | null
          comune: string | null
          ev_agency_key: string | null
          ev_canonical_listing_id: string | null
          ev_civico_norm: string | null
          ev_derived_at: string | null
          ev_descr_fp: string | null
          ev_flags_at: string | null
          ev_image_refs: Json | null
          ev_is_asta: boolean | null
          ev_is_mls: boolean | null
          ev_piano_key: string | null
          ev_provenance: Json | null
          ev_tipologia: string | null
          ev_via_norm: string | null
          expired_at: string | null
          fonte: string
          id: number
          imported_at: string
          indirizzo: string | null
          last_seen_at: string
          lat: number | null
          lng: number | null
          locali: number | null
          mq: number | null
          omi_zone: string | null
          prezzo: number | null
          published_at_portal: string | null
          quartiere: string | null
          raw_json: Json | null
          tag_legacy: string | null
          telefono: string | null
          tipo_lead: string | null
          url: string | null
          zone_match_confidence: number | null
          zone_match_method: string | null
          zone_resolved_at: string | null
        }
        Insert: {
          agency?: string | null
          bagni?: number | null
          commercial_zone_slug?: string | null
          comune?: string | null
          ev_agency_key?: string | null
          ev_canonical_listing_id?: string | null
          ev_civico_norm?: string | null
          ev_derived_at?: string | null
          ev_descr_fp?: string | null
          ev_flags_at?: string | null
          ev_image_refs?: Json | null
          ev_is_asta?: boolean | null
          ev_is_mls?: boolean | null
          ev_piano_key?: string | null
          ev_provenance?: Json | null
          ev_tipologia?: string | null
          ev_via_norm?: string | null
          expired_at?: string | null
          fonte: string
          id?: number
          imported_at?: string
          indirizzo?: string | null
          last_seen_at?: string
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          omi_zone?: string | null
          prezzo?: number | null
          published_at_portal?: string | null
          quartiere?: string | null
          raw_json?: Json | null
          tag_legacy?: string | null
          telefono?: string | null
          tipo_lead?: string | null
          url?: string | null
          zone_match_confidence?: number | null
          zone_match_method?: string | null
          zone_resolved_at?: string | null
        }
        Update: {
          agency?: string | null
          bagni?: number | null
          commercial_zone_slug?: string | null
          comune?: string | null
          ev_agency_key?: string | null
          ev_canonical_listing_id?: string | null
          ev_civico_norm?: string | null
          ev_derived_at?: string | null
          ev_descr_fp?: string | null
          ev_flags_at?: string | null
          ev_image_refs?: Json | null
          ev_is_asta?: boolean | null
          ev_is_mls?: boolean | null
          ev_piano_key?: string | null
          ev_provenance?: Json | null
          ev_tipologia?: string | null
          ev_via_norm?: string | null
          expired_at?: string | null
          fonte?: string
          id?: number
          imported_at?: string
          indirizzo?: string | null
          last_seen_at?: string
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          omi_zone?: string | null
          prezzo?: number | null
          published_at_portal?: string | null
          quartiere?: string | null
          raw_json?: Json | null
          tag_legacy?: string | null
          telefono?: string | null
          tipo_lead?: string | null
          url?: string | null
          zone_match_confidence?: number | null
          zone_match_method?: string | null
          zone_resolved_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "padova_listings_commercial_zone_slug_fkey"
            columns: ["commercial_zone_slug"]
            isOneToOne: false
            referencedRelation: "civiko_commercial_zones"
            referencedColumns: ["slug"]
          },
        ]
      }
      padova_listings_casa_quartiere_backfill_20260723: {
        Row: {
          captured_at: string | null
          commercial_zone_slug_pre: string | null
          fonte: string | null
          id: number | null
          quartiere_pre: string | null
          quartiere_structured: string | null
          resolved_slug: string | null
          url: string | null
        }
        Insert: {
          captured_at?: string | null
          commercial_zone_slug_pre?: string | null
          fonte?: string | null
          id?: number | null
          quartiere_pre?: string | null
          quartiere_structured?: string | null
          resolved_slug?: string | null
          url?: string | null
        }
        Update: {
          captured_at?: string | null
          commercial_zone_slug_pre?: string | null
          fonte?: string | null
          id?: number | null
          quartiere_pre?: string | null
          quartiere_structured?: string | null
          resolved_slug?: string | null
          url?: string | null
        }
        Relationships: []
      }
      padova_listings_immobiliare_quartiere_backfill_20260723: {
        Row: {
          backfilled_at: string
          commercial_zone_slug_before: string | null
          listing_id: number
          portal_id: string
          quartiere_after: string
          quartiere_before: string | null
          url: string
        }
        Insert: {
          backfilled_at?: string
          commercial_zone_slug_before?: string | null
          listing_id: number
          portal_id: string
          quartiere_after: string
          quartiere_before?: string | null
          url: string
        }
        Update: {
          backfilled_at?: string
          commercial_zone_slug_before?: string | null
          listing_id?: number
          portal_id?: string
          quartiere_after?: string
          quartiere_before?: string | null
          url?: string
        }
        Relationships: []
      }
      padova_listings_price_history: {
        Row: {
          created_at: string
          id: number
          listing_id: number
          prezzo: number
          snapshot_date: string
        }
        Insert: {
          created_at?: string
          id?: number
          listing_id: number
          prezzo: number
          snapshot_date?: string
        }
        Update: {
          created_at?: string
          id?: number
          listing_id?: number
          prezzo?: number
          snapshot_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "padova_listings_price_history_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "civiko_padova_tipo_lead_mismatch_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "padova_listings_price_history_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "padova_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "padova_listings_price_history_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "padova_listings_zone_v"
            referencedColumns: ["id"]
          },
        ]
      }
      padova_listings_subito_alias_backfill_20260723: {
        Row: {
          captured_at: string
          commercial_zone_slug_before: string | null
          id: number
          matched_alias: string
          quartiere_before: string | null
          staging_quartiere: string | null
          url: string
        }
        Insert: {
          captured_at?: string
          commercial_zone_slug_before?: string | null
          id: number
          matched_alias: string
          quartiere_before?: string | null
          staging_quartiere?: string | null
          url: string
        }
        Update: {
          captured_at?: string
          commercial_zone_slug_before?: string | null
          id?: number
          matched_alias?: string
          quartiere_before?: string | null
          staging_quartiere?: string | null
          url?: string
        }
        Relationships: []
      }
      padova_multi_portale: {
        Row: {
          agencies_normalized: string[]
          agency_count_distinct: number
          agenzie: string[]
          bagni: number | null
          chiave_match: string | null
          commercial_zone_slug: string
          created_at: string
          id: number
          last_seen_at: string | null
          lat: number | null
          lng: number | null
          locali: number | null
          mq: number | null
          n_annunci: number
          portal_count: number
          portals_seen: string[]
          prezzo_max: number | null
          prezzo_min: number | null
          quartiere: string | null
          updated_at: string
          urls: string[]
        }
        Insert: {
          agencies_normalized?: string[]
          agency_count_distinct?: number
          agenzie?: string[]
          bagni?: number | null
          chiave_match?: string | null
          commercial_zone_slug: string
          created_at?: string
          id?: number
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          n_annunci?: number
          portal_count?: number
          portals_seen?: string[]
          prezzo_max?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          updated_at?: string
          urls?: string[]
        }
        Update: {
          agencies_normalized?: string[]
          agency_count_distinct?: number
          agenzie?: string[]
          bagni?: number | null
          chiave_match?: string | null
          commercial_zone_slug?: string
          created_at?: string
          id?: number
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          n_annunci?: number
          portal_count?: number
          portals_seen?: string[]
          prezzo_max?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          updated_at?: string
          urls?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "padova_multi_portale_commercial_zone_slug_fkey"
            columns: ["commercial_zone_slug"]
            isOneToOne: false
            referencedRelation: "civiko_commercial_zones"
            referencedColumns: ["slug"]
          },
        ]
      }
      padova_multi_portale_quarantena: {
        Row: {
          agenzie: string[] | null
          bagni: number | null
          chiave_match: string
          commercial_zone_slug: string | null
          created_at: string
          id: number
          locali: number | null
          metriche: Json
          motivi: string[]
          mq: number | null
          n_annunci: number | null
          portal_count: number | null
          portals_seen: string[] | null
          prezzo_max: number | null
          prezzo_min: number | null
          quarantined_at: string
          quartiere: string | null
          updated_at: string
          urls: string[] | null
        }
        Insert: {
          agenzie?: string[] | null
          bagni?: number | null
          chiave_match: string
          commercial_zone_slug?: string | null
          created_at?: string
          id?: number
          locali?: number | null
          metriche?: Json
          motivi?: string[]
          mq?: number | null
          n_annunci?: number | null
          portal_count?: number | null
          portals_seen?: string[] | null
          prezzo_max?: number | null
          prezzo_min?: number | null
          quarantined_at?: string
          quartiere?: string | null
          updated_at?: string
          urls?: string[] | null
        }
        Update: {
          agenzie?: string[] | null
          bagni?: number | null
          chiave_match?: string
          commercial_zone_slug?: string | null
          created_at?: string
          id?: number
          locali?: number | null
          metriche?: Json
          motivi?: string[]
          mq?: number | null
          n_annunci?: number | null
          portal_count?: number | null
          portals_seen?: string[] | null
          prezzo_max?: number | null
          prezzo_min?: number | null
          quarantined_at?: string
          quartiere?: string | null
          updated_at?: string
          urls?: string[] | null
        }
        Relationships: []
      }
      padova_recompute_last_result: {
        Row: {
          created_at: string
          id: number
          result: Json
        }
        Insert: {
          created_at?: string
          id?: number
          result: Json
        }
        Update: {
          created_at?: string
          id?: number
          result?: Json
        }
        Relationships: []
      }
      padova_subito_staging: {
        Row: {
          fetched_at: string
          id: number
          raw_json: Json | null
        }
        Insert: {
          fetched_at?: string
          id?: number
          raw_json?: Json | null
        }
        Update: {
          fetched_at?: string
          id?: number
          raw_json?: Json | null
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
      pipeline_runs: {
        Row: {
          apify_run_ids: string[]
          cost_usd: number
          created_at: string
          duration_ms: number | null
          error_message: string | null
          finished_at: string | null
          id: number
          mode: string
          monthly_cap_usd: number | null
          monthly_spent_usd_at_start: number | null
          per_source_stats: Json
          pipeline_name: string
          sources: string[]
          started_at: string
          status: string
          trigger_source: string
          updated_at: string
          warnings: string[]
        }
        Insert: {
          apify_run_ids?: string[]
          cost_usd?: number
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: number
          mode: string
          monthly_cap_usd?: number | null
          monthly_spent_usd_at_start?: number | null
          per_source_stats?: Json
          pipeline_name: string
          sources?: string[]
          started_at?: string
          status?: string
          trigger_source?: string
          updated_at?: string
          warnings?: string[]
        }
        Update: {
          apify_run_ids?: string[]
          cost_usd?: number
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: number
          mode?: string
          monthly_cap_usd?: number | null
          monthly_spent_usd_at_start?: number | null
          per_source_stats?: Json
          pipeline_name?: string
          sources?: string[]
          started_at?: string
          status?: string
          trigger_source?: string
          updated_at?: string
          warnings?: string[]
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
      private_leads_run_status: {
        Row: {
          created_at: string
          duration_ms: number | null
          error_message: string | null
          id: number
          last_run_at: string
          notes: Json | null
          opportunita_totali: number
          privato_stanco_count: number
          source: string
          status: string
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: number
          last_run_at?: string
          notes?: Json | null
          opportunita_totali?: number
          privato_stanco_count?: number
          source: string
          status?: string
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: number
          last_run_at?: string
          notes?: Json | null
          opportunita_totali?: number
          privato_stanco_count?: number
          source?: string
          status?: string
        }
        Relationships: []
      }
      private_leads_spend_monthly: {
        Row: {
          apify_usd: number
          firecrawl_usd: number
          total_usd: number | null
          updated_at: string
          year_month: string
        }
        Insert: {
          apify_usd?: number
          firecrawl_usd?: number
          total_usd?: number | null
          updated_at?: string
          year_month: string
        }
        Update: {
          apify_usd?: number
          firecrawl_usd?: number
          total_usd?: number | null
          updated_at?: string
          year_month?: string
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
          signal_id: string
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
          signal_id: string
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
          signal_id?: string
          visible_in_owner_report?: boolean
        }
        Relationships: []
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
      quartiere_canon_map: {
        Row: {
          chiave: string
          microzona: string
        }
        Insert: {
          chiave: string
          microzona: string
        }
        Update: {
          chiave?: string
          microzona?: string
        }
        Relationships: []
      }
      quartiere_zona_map: {
        Row: {
          created_at: string | null
          omi_zone_code: string
          quartiere_key: string
          zona_slug: string
        }
        Insert: {
          created_at?: string | null
          omi_zone_code: string
          quartiere_key: string
          zona_slug: string
        }
        Update: {
          created_at?: string | null
          omi_zone_code?: string
          quartiere_key?: string
          zona_slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "quartiere_zona_map_zona_slug_fkey"
            columns: ["zona_slug"]
            isOneToOne: false
            referencedRelation: "civiko_commercial_zones"
            referencedColumns: ["slug"]
          },
        ]
      }
      radar_budget_ledger: {
        Row: {
          api_name: string | null
          budget_mode: string | null
          calls_count: number
          compute_units: number
          cost_basis: string
          created_at: string
          day_key: string
          estimated_cost_eur: number
          estimated_cost_usd: number
          id: string
          input_tokens: number
          intent: string | null
          items_processed: number
          metadata: Json
          mode: string | null
          month_key: string
          operation: string | null
          output_tokens: number
          provider: string
          proxy_gb: number
          request_id: string | null
          run_id: string | null
          scope: string | null
          source: string | null
          target: string | null
          triggered_by: string | null
          week_key: string
        }
        Insert: {
          api_name?: string | null
          budget_mode?: string | null
          calls_count?: number
          compute_units?: number
          cost_basis?: string
          created_at?: string
          day_key: string
          estimated_cost_eur?: number
          estimated_cost_usd?: number
          id?: string
          input_tokens?: number
          intent?: string | null
          items_processed?: number
          metadata?: Json
          mode?: string | null
          month_key: string
          operation?: string | null
          output_tokens?: number
          provider: string
          proxy_gb?: number
          request_id?: string | null
          run_id?: string | null
          scope?: string | null
          source?: string | null
          target?: string | null
          triggered_by?: string | null
          week_key: string
        }
        Update: {
          api_name?: string | null
          budget_mode?: string | null
          calls_count?: number
          compute_units?: number
          cost_basis?: string
          created_at?: string
          day_key?: string
          estimated_cost_eur?: number
          estimated_cost_usd?: number
          id?: string
          input_tokens?: number
          intent?: string | null
          items_processed?: number
          metadata?: Json
          mode?: string | null
          month_key?: string
          operation?: string | null
          output_tokens?: number
          provider?: string
          proxy_gb?: number
          request_id?: string | null
          run_id?: string | null
          scope?: string | null
          source?: string | null
          target?: string | null
          triggered_by?: string | null
          week_key?: string
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
      scraping_provider_state: {
        Row: {
          circuit_open_until: string | null
          consecutive_failures: number
          last_failure_at: string | null
          last_success_at: string | null
          provider: Database["public"]["Enums"]["scraping_provider"]
          updated_at: string
        }
        Insert: {
          circuit_open_until?: string | null
          consecutive_failures?: number
          last_failure_at?: string | null
          last_success_at?: string | null
          provider: Database["public"]["Enums"]["scraping_provider"]
          updated_at?: string
        }
        Update: {
          circuit_open_until?: string | null
          consecutive_failures?: number
          last_failure_at?: string | null
          last_success_at?: string | null
          provider?: Database["public"]["Enums"]["scraping_provider"]
          updated_at?: string
        }
        Relationships: []
      }
      scraping_queue: {
        Row: {
          attempt: number
          available_at: string
          completed_at: string | null
          created_at: string
          depends_on: string[]
          duration_ms: number | null
          group_key: string | null
          http_status: number | null
          id: string
          idempotency_key: string | null
          last_error: Json | null
          last_heartbeat_at: string | null
          locked_at: string | null
          locked_by: string | null
          locked_until: string | null
          max_attempts: number
          operation: string
          parent_id: string | null
          payload: Json
          priority: number
          processed_at: string | null
          processing_attempt: number
          processing_available_at: string | null
          processing_last_error: Json | null
          processing_locked_at: string | null
          processing_locked_by: string | null
          processing_locked_until: string | null
          processing_max_attempts: number
          processing_status: string
          processor: string | null
          processor_context: Json
          provider: Database["public"]["Enums"]["scraping_provider"]
          result: Json | null
          result_ref: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["scraping_queue_status"]
          timeout_seconds: number
          updated_at: string
        }
        Insert: {
          attempt?: number
          available_at?: string
          completed_at?: string | null
          created_at?: string
          depends_on?: string[]
          duration_ms?: number | null
          group_key?: string | null
          http_status?: number | null
          id?: string
          idempotency_key?: string | null
          last_error?: Json | null
          last_heartbeat_at?: string | null
          locked_at?: string | null
          locked_by?: string | null
          locked_until?: string | null
          max_attempts?: number
          operation: string
          parent_id?: string | null
          payload?: Json
          priority?: number
          processed_at?: string | null
          processing_attempt?: number
          processing_available_at?: string | null
          processing_last_error?: Json | null
          processing_locked_at?: string | null
          processing_locked_by?: string | null
          processing_locked_until?: string | null
          processing_max_attempts?: number
          processing_status?: string
          processor?: string | null
          processor_context?: Json
          provider: Database["public"]["Enums"]["scraping_provider"]
          result?: Json | null
          result_ref?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["scraping_queue_status"]
          timeout_seconds?: number
          updated_at?: string
        }
        Update: {
          attempt?: number
          available_at?: string
          completed_at?: string | null
          created_at?: string
          depends_on?: string[]
          duration_ms?: number | null
          group_key?: string | null
          http_status?: number | null
          id?: string
          idempotency_key?: string | null
          last_error?: Json | null
          last_heartbeat_at?: string | null
          locked_at?: string | null
          locked_by?: string | null
          locked_until?: string | null
          max_attempts?: number
          operation?: string
          parent_id?: string | null
          payload?: Json
          priority?: number
          processed_at?: string | null
          processing_attempt?: number
          processing_available_at?: string | null
          processing_last_error?: Json | null
          processing_locked_at?: string | null
          processing_locked_by?: string | null
          processing_locked_until?: string | null
          processing_max_attempts?: number
          processing_status?: string
          processor?: string | null
          processor_context?: Json
          provider?: Database["public"]["Enums"]["scraping_provider"]
          result?: Json | null
          result_ref?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["scraping_queue_status"]
          timeout_seconds?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scraping_queue_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "scraping_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      scraping_queue_events: {
        Row: {
          attempt: number
          created_at: string
          detail: Json
          event: string
          id: number
          queue_id: string
          worker_id: string | null
        }
        Insert: {
          attempt: number
          created_at?: string
          detail?: Json
          event: string
          id?: never
          queue_id: string
          worker_id?: string | null
        }
        Update: {
          attempt?: number
          created_at?: string
          detail?: Json
          event?: string
          id?: never
          queue_id?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scraping_queue_events_queue_id_fkey"
            columns: ["queue_id"]
            isOneToOne: false
            referencedRelation: "scraping_queue"
            referencedColumns: ["id"]
          },
        ]
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
      stripe_webhook_events: {
        Row: {
          attempts: number
          claimed_at: string | null
          id: string
          last_error: string | null
          processed_at: string | null
          status: string
          type: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          claimed_at?: string | null
          id: string
          last_error?: string | null
          processed_at?: string | null
          status?: string
          type: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          claimed_at?: string | null
          id?: string
          last_error?: string | null
          processed_at?: string | null
          status?: string
          type?: string
          updated_at?: string
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
      trovabandi_evidence: {
        Row: {
          content_hash: string | null
          evidence_type: string
          excerpt: string | null
          fetched_at: string
          id: string
          opportunity_id: string
          published_at: string | null
          source_title: string | null
          source_url: string
        }
        Insert: {
          content_hash?: string | null
          evidence_type: string
          excerpt?: string | null
          fetched_at?: string
          id?: string
          opportunity_id: string
          published_at?: string | null
          source_title?: string | null
          source_url: string
        }
        Update: {
          content_hash?: string | null
          evidence_type?: string
          excerpt?: string | null
          fetched_at?: string
          id?: string
          opportunity_id?: string
          published_at?: string | null
          source_title?: string | null
          source_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "trovabandi_evidence_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "trovabandi_opportunities"
            referencedColumns: ["id"]
          },
        ]
      }
      trovabandi_opportunities: {
        Row: {
          aid_intensity_percent: number | null
          application_url: string | null
          authority_level: string
          authority_name: string
          canonical_key: string
          category: string
          click_day: boolean
          consortium_required: boolean | null
          content_hash: string | null
          created_at: string
          de_minimis: boolean | null
          deadline_at: string | null
          direct_applicant_allowed: boolean | null
          discovered_by: string[]
          eligible_ateco_prefixes: string[]
          eligible_company_sizes: string[]
          eligible_countries: string[]
          eligible_expenses: string[]
          eligible_legal_forms: string[]
          excluded_ateco_prefixes: string[]
          female_only: boolean
          first_seen_at: string
          forms_url: string | null
          id: string
          implementing_body: string | null
          innovative_only: boolean
          last_seen_at: string
          last_verified_at: string | null
          max_grant_amount: number | null
          min_grant_amount: number | null
          min_partners: number | null
          municipality: string | null
          notice_url: string | null
          official_source: boolean
          official_url: string
          opens_at: string | null
          pnrr_component: string | null
          pnrr_mission: string | null
          programme_code: string | null
          programme_name: string | null
          protocol_email: string | null
          province: string | null
          publication_reference: string | null
          rarity_score: number
          raw_excerpt: string | null
          region: string | null
          requirements: string[]
          source_kind: string
          startup_only: boolean
          summary: string
          title: string
          total_budget: number | null
          updated_at: string
          verification_status: string
          youth_only: boolean
        }
        Insert: {
          aid_intensity_percent?: number | null
          application_url?: string | null
          authority_level: string
          authority_name: string
          canonical_key: string
          category: string
          click_day?: boolean
          consortium_required?: boolean | null
          content_hash?: string | null
          created_at?: string
          de_minimis?: boolean | null
          deadline_at?: string | null
          direct_applicant_allowed?: boolean | null
          discovered_by?: string[]
          eligible_ateco_prefixes?: string[]
          eligible_company_sizes?: string[]
          eligible_countries?: string[]
          eligible_expenses?: string[]
          eligible_legal_forms?: string[]
          excluded_ateco_prefixes?: string[]
          female_only?: boolean
          first_seen_at?: string
          forms_url?: string | null
          id?: string
          implementing_body?: string | null
          innovative_only?: boolean
          last_seen_at?: string
          last_verified_at?: string | null
          max_grant_amount?: number | null
          min_grant_amount?: number | null
          min_partners?: number | null
          municipality?: string | null
          notice_url?: string | null
          official_source?: boolean
          official_url: string
          opens_at?: string | null
          pnrr_component?: string | null
          pnrr_mission?: string | null
          programme_code?: string | null
          programme_name?: string | null
          protocol_email?: string | null
          province?: string | null
          publication_reference?: string | null
          rarity_score?: number
          raw_excerpt?: string | null
          region?: string | null
          requirements?: string[]
          source_kind?: string
          startup_only?: boolean
          summary: string
          title: string
          total_budget?: number | null
          updated_at?: string
          verification_status?: string
          youth_only?: boolean
        }
        Update: {
          aid_intensity_percent?: number | null
          application_url?: string | null
          authority_level?: string
          authority_name?: string
          canonical_key?: string
          category?: string
          click_day?: boolean
          consortium_required?: boolean | null
          content_hash?: string | null
          created_at?: string
          de_minimis?: boolean | null
          deadline_at?: string | null
          direct_applicant_allowed?: boolean | null
          discovered_by?: string[]
          eligible_ateco_prefixes?: string[]
          eligible_company_sizes?: string[]
          eligible_countries?: string[]
          eligible_expenses?: string[]
          eligible_legal_forms?: string[]
          excluded_ateco_prefixes?: string[]
          female_only?: boolean
          first_seen_at?: string
          forms_url?: string | null
          id?: string
          implementing_body?: string | null
          innovative_only?: boolean
          last_seen_at?: string
          last_verified_at?: string | null
          max_grant_amount?: number | null
          min_grant_amount?: number | null
          min_partners?: number | null
          municipality?: string | null
          notice_url?: string | null
          official_source?: boolean
          official_url?: string
          opens_at?: string | null
          pnrr_component?: string | null
          pnrr_mission?: string | null
          programme_code?: string | null
          programme_name?: string | null
          protocol_email?: string | null
          province?: string | null
          publication_reference?: string | null
          rarity_score?: number
          raw_excerpt?: string | null
          region?: string | null
          requirements?: string[]
          source_kind?: string
          startup_only?: boolean
          summary?: string
          title?: string
          total_budget?: number | null
          updated_at?: string
          verification_status?: string
          youth_only?: boolean
        }
        Relationships: []
      }
      trovabandi_refresh_requests: {
        Row: {
          ateco_prefix: string | null
          company_size: string | null
          female_business: boolean
          id: string
          innovative_business: boolean
          interest_categories: string[]
          municipality: string | null
          processed_at: string | null
          province: string | null
          region: string | null
          request_key: string
          requested_at: string
          youth_business: boolean
        }
        Insert: {
          ateco_prefix?: string | null
          company_size?: string | null
          female_business?: boolean
          id?: string
          innovative_business?: boolean
          interest_categories?: string[]
          municipality?: string | null
          processed_at?: string | null
          province?: string | null
          region?: string | null
          request_key: string
          requested_at?: string
          youth_business?: boolean
        }
        Update: {
          ateco_prefix?: string | null
          company_size?: string | null
          female_business?: boolean
          id?: string
          innovative_business?: boolean
          interest_categories?: string[]
          municipality?: string | null
          processed_at?: string | null
          province?: string | null
          region?: string | null
          request_key?: string
          requested_at?: string
          youth_business?: boolean
        }
        Relationships: []
      }
      trovabandi_refresh_requests_log_tmp: {
        Row: {
          created_at: string
          id: number
          request_id: number | null
        }
        Insert: {
          created_at?: string
          id?: number
          request_id?: number | null
        }
        Update: {
          created_at?: string
          id?: number
          request_id?: number | null
        }
        Relationships: []
      }
      trovabandi_runs: {
        Row: {
          action: string
          discovered_count: number
          error_code: string | null
          finished_at: string | null
          id: string
          processed_count: number
          provider_usage: Json
          source_id: string | null
          started_at: string
          status: string
          trigger_source: string
          verified_count: number
          warnings: string[]
        }
        Insert: {
          action: string
          discovered_count?: number
          error_code?: string | null
          finished_at?: string | null
          id?: string
          processed_count?: number
          provider_usage?: Json
          source_id?: string | null
          started_at?: string
          status?: string
          trigger_source?: string
          verified_count?: number
          warnings?: string[]
        }
        Update: {
          action?: string
          discovered_count?: number
          error_code?: string | null
          finished_at?: string | null
          id?: string
          processed_count?: number
          provider_usage?: Json
          source_id?: string | null
          started_at?: string
          status?: string
          trigger_source?: string
          verified_count?: number
          warnings?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "trovabandi_runs_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "trovabandi_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      trovabandi_source_candidates: {
        Row: {
          attempt_count: number
          content_hash: string | null
          created_at: string
          discovered_at: string
          id: string
          last_attempted_at: string | null
          last_seen_at: string
          provider: string | null
          snippet: string | null
          source_id: string
          title: string | null
          updated_at: string
          url: string
          url_hash: string
        }
        Insert: {
          attempt_count?: number
          content_hash?: string | null
          created_at?: string
          discovered_at?: string
          id?: string
          last_attempted_at?: string | null
          last_seen_at?: string
          provider?: string | null
          snippet?: string | null
          source_id: string
          title?: string | null
          updated_at?: string
          url: string
          url_hash: string
        }
        Update: {
          attempt_count?: number
          content_hash?: string | null
          created_at?: string
          discovered_at?: string
          id?: string
          last_attempted_at?: string | null
          last_seen_at?: string
          provider?: string | null
          snippet?: string | null
          source_id?: string
          title?: string | null
          updated_at?: string
          url?: string
          url_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "trovabandi_source_candidates_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "trovabandi_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      trovabandi_sources: {
        Row: {
          authority_level: string
          created_at: string
          enabled: boolean
          fast_lane: boolean
          id: string
          last_scanned_at: string | null
          name: string
          next_scan_at: string
          official_domain: string
          priority: number
          province: string | null
          rarity_base: number
          region: string | null
          scan_interval_minutes: number
          search_query: string
          source_kind: string
          updated_at: string
        }
        Insert: {
          authority_level: string
          created_at?: string
          enabled?: boolean
          fast_lane?: boolean
          id?: string
          last_scanned_at?: string | null
          name: string
          next_scan_at?: string
          official_domain: string
          priority?: number
          province?: string | null
          rarity_base?: number
          region?: string | null
          scan_interval_minutes?: number
          search_query: string
          source_kind?: string
          updated_at?: string
        }
        Update: {
          authority_level?: string
          created_at?: string
          enabled?: boolean
          fast_lane?: boolean
          id?: string
          last_scanned_at?: string | null
          name?: string
          next_scan_at?: string
          official_domain?: string
          priority?: number
          province?: string | null
          rarity_base?: number
          region?: string | null
          scan_interval_minutes?: number
          search_query?: string
          source_kind?: string
          updated_at?: string
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
      civiko_padova_release_gate_v: {
        Row: {
          capped_cost_cap_ok: boolean | null
          capped_semantic_equivalence_ok: boolean | null
          casa_queue_processed_ok: boolean | null
          categoria_snapshot_corrente: boolean | null
          checked_at: string | null
          classificazione_ultima: string | null
          contendibili_fuori_perimetro: number | null
          contendibili_snapshot_correnti: number | null
          contendibili_totali: number | null
          downstream_actions_ok: number | null
          downstream_avvio: string | null
          downstream_ultimo: string | null
          fingerprint_correnti: number | null
          image_attempts_correnti: number | null
          image_certify_corrente: boolean | null
          import_corrente_ok: boolean | null
          import_nuovi_ok: boolean | null
          listings_freschi: number | null
          mismatch_professionale: number | null
          pipeline_0510_avvio: string | null
          pipeline_0510_kind: string | null
          pipeline_0510_ok: boolean | null
          pipeline_0510_run_id: string | null
          pipeline_0510_ultimo: string | null
          pipeline_0545_avvio: string | null
          pipeline_0545_ok: boolean | null
          pipeline_0545_run_id: string | null
          pipeline_0545_ultimo: string | null
          pipeline_0710_avvio: string | null
          pipeline_0710_ok: boolean | null
          pipeline_0710_run_id: string | null
          pipeline_0710_ultimo: string | null
          portale_casa_lancio_ok: boolean | null
          portale_idealista_lancio_ok: boolean | null
          portale_immobiliare_lancio_ok: boolean | null
          portale_subito_lancio_ok: boolean | null
          portali_freschi: number | null
          portali_lancio_corrente_ok: boolean | null
          private_classify_na_ok: boolean | null
          privati_fuori_perimetro: number | null
          pwa_sync_ack_avvio: string | null
          pwa_sync_ack_corrente: boolean | null
          pwa_sync_ack_counts: Json | null
          pwa_sync_ack_pipeline_run_id: string | null
          pwa_sync_ack_ultimo_ok: string | null
          recompute_corrente: boolean | null
          recompute_ultimo: string | null
          release_order_ok: boolean | null
          sync_pwa_dopo_classificazione: boolean | null
        }
        Relationships: []
      }
      civiko_padova_tipo_lead_mismatch_v: {
        Row: {
          agency: string | null
          commercial_zone_slug: string | null
          fonte: string | null
          id: number | null
          last_seen_at: string | null
          tipo_lead: string | null
          url: string | null
        }
        Insert: {
          agency?: string | null
          commercial_zone_slug?: string | null
          fonte?: string | null
          id?: number | null
          last_seen_at?: string | null
          tipo_lead?: string | null
          url?: string | null
        }
        Update: {
          agency?: string | null
          commercial_zone_slug?: string | null
          fonte?: string | null
          id?: number | null
          last_seen_at?: string | null
          tipo_lead?: string | null
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "padova_listings_commercial_zone_slug_fkey"
            columns: ["commercial_zone_slug"]
            isOneToOne: false
            referencedRelation: "civiko_commercial_zones"
            referencedColumns: ["slug"]
          },
        ]
      }
      early_offmarket_signal_candidates_by_zone_v: {
        Row: {
          agent_action: string | null
          ai_summary: string | null
          amount_text: string | null
          asset_type: string | null
          commercial_value_score: number | null
          commercial_zone_slug: string | null
          comune: string | null
          confidence_score: number | null
          created_at: string | null
          data_basis: string | null
          deadline_text: string | null
          fingerprint: string | null
          id: string | null
          import_recommendation: string | null
          investor_pitch: string | null
          location_detail: string | null
          needs_review: boolean | null
          owner_pitch: string | null
          payload: Json | null
          possible_agent_action: string | null
          priority_score: number | null
          privacy_safe: boolean | null
          promoted_at: string | null
          promoted_to: string | null
          provincia: string | null
          publication_date: string | null
          quality: string | null
          quartiere: string | null
          real_estate_relevance_score: number | null
          reject_reason: string | null
          rejection_reason: string | null
          review_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          run_id: string | null
          signal_type: string | null
          source_name: string | null
          source_url: string | null
          status: string | null
          summary: string | null
          timing: string | null
          title: string | null
          why_it_matters: string | null
        }
        Insert: {
          agent_action?: string | null
          ai_summary?: string | null
          amount_text?: string | null
          asset_type?: string | null
          commercial_value_score?: number | null
          commercial_zone_slug?: never
          comune?: string | null
          confidence_score?: number | null
          created_at?: string | null
          data_basis?: string | null
          deadline_text?: string | null
          fingerprint?: string | null
          id?: string | null
          import_recommendation?: string | null
          investor_pitch?: string | null
          location_detail?: string | null
          needs_review?: boolean | null
          owner_pitch?: string | null
          payload?: Json | null
          possible_agent_action?: string | null
          priority_score?: number | null
          privacy_safe?: boolean | null
          promoted_at?: string | null
          promoted_to?: string | null
          provincia?: string | null
          publication_date?: string | null
          quality?: string | null
          quartiere?: string | null
          real_estate_relevance_score?: number | null
          reject_reason?: string | null
          rejection_reason?: string | null
          review_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          run_id?: string | null
          signal_type?: string | null
          source_name?: string | null
          source_url?: string | null
          status?: string | null
          summary?: string | null
          timing?: string | null
          title?: string | null
          why_it_matters?: string | null
        }
        Update: {
          agent_action?: string | null
          ai_summary?: string | null
          amount_text?: string | null
          asset_type?: string | null
          commercial_value_score?: number | null
          commercial_zone_slug?: never
          comune?: string | null
          confidence_score?: number | null
          created_at?: string | null
          data_basis?: string | null
          deadline_text?: string | null
          fingerprint?: string | null
          id?: string | null
          import_recommendation?: string | null
          investor_pitch?: string | null
          location_detail?: string | null
          needs_review?: boolean | null
          owner_pitch?: string | null
          payload?: Json | null
          possible_agent_action?: string | null
          priority_score?: number | null
          privacy_safe?: boolean | null
          promoted_at?: string | null
          promoted_to?: string | null
          provincia?: string | null
          publication_date?: string | null
          quality?: string | null
          quartiere?: string | null
          real_estate_relevance_score?: number | null
          reject_reason?: string | null
          rejection_reason?: string | null
          review_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          run_id?: string | null
          signal_type?: string | null
          source_name?: string | null
          source_url?: string | null
          status?: string | null
          summary?: string | null
          timing?: string | null
          title?: string | null
          why_it_matters?: string | null
        }
        Relationships: []
      }
      omi_microzone_range: {
        Row: {
          comune_key: string | null
          microzone: string | null
          omi_max: number | null
          omi_min: number | null
          semestre_ultimo: string | null
        }
        Relationships: []
      }
      padova_cambi_agenzia_by_zone_v: {
        Row: {
          agenzia_nuova: string | null
          agenzia_precedente: string | null
          canon_url: string | null
          commercial_zone_slug: string | null
          contendibile_overlap: boolean | null
          created_at: string | null
          data_cambio: string | null
          first_detected_at: string | null
          id: string | null
          indirizzo: string | null
          is_active: boolean | null
          last_seen_at: string | null
          locali: number | null
          mq: number | null
          portale: string | null
          prezzo_eur: number | null
          quartiere: string | null
          titolo: string | null
          updated_at: string | null
          zona_omi: string | null
        }
        Insert: {
          agenzia_nuova?: string | null
          agenzia_precedente?: string | null
          canon_url?: string | null
          commercial_zone_slug?: string | null
          contendibile_overlap?: boolean | null
          created_at?: string | null
          data_cambio?: string | null
          first_detected_at?: string | null
          id?: string | null
          indirizzo?: string | null
          is_active?: boolean | null
          last_seen_at?: string | null
          locali?: number | null
          mq?: number | null
          portale?: string | null
          prezzo_eur?: number | null
          quartiere?: string | null
          titolo?: string | null
          updated_at?: string | null
          zona_omi?: string | null
        }
        Update: {
          agenzia_nuova?: string | null
          agenzia_precedente?: string | null
          canon_url?: string | null
          commercial_zone_slug?: string | null
          contendibile_overlap?: boolean | null
          created_at?: string | null
          data_cambio?: string | null
          first_detected_at?: string | null
          id?: string | null
          indirizzo?: string | null
          is_active?: boolean | null
          last_seen_at?: string | null
          locali?: number | null
          mq?: number | null
          portale?: string | null
          prezzo_eur?: number | null
          quartiere?: string | null
          titolo?: string | null
          updated_at?: string | null
          zona_omi?: string | null
        }
        Relationships: []
      }
      padova_collect_v2_items_by_zone_v: {
        Row: {
          agency: string | null
          agency_phone: string | null
          anno_costruzione: number | null
          attempts: number | null
          bagni: number | null
          cap: string | null
          citta: string | null
          civico: string | null
          cluster_key: string | null
          commercial_zone_slug: string | null
          contendibile: boolean | null
          contendibile_confidenza: string | null
          contendibile_group_id: string | null
          created_at: string | null
          http_status: number | null
          id: number | null
          job_id: string | null
          lat: number | null
          listing_id: string | null
          lng: number | null
          locali: number | null
          log_reason: string | null
          mq: number | null
          n_agenzie: number | null
          omi_zone: string | null
          parse_status: string | null
          piano: string | null
          portal: string | null
          previous_price_eur: number | null
          prezzo: number | null
          prezzo_iniziale: number | null
          processed_at: string | null
          quartiere: string | null
          raw_address: string | null
          raw_json: Json | null
          ribasso_date: string | null
          ribasso_eur: number | null
          ribasso_pct: number | null
          riscaldamento: string | null
          stato: string | null
          tipo_lead: string | null
          tipologia: string | null
          updated_at: string | null
          url: string | null
        }
        Insert: {
          agency?: string | null
          agency_phone?: string | null
          anno_costruzione?: number | null
          attempts?: number | null
          bagni?: number | null
          cap?: string | null
          citta?: string | null
          civico?: string | null
          cluster_key?: string | null
          commercial_zone_slug?: never
          contendibile?: boolean | null
          contendibile_confidenza?: string | null
          contendibile_group_id?: string | null
          created_at?: string | null
          http_status?: number | null
          id?: number | null
          job_id?: string | null
          lat?: number | null
          listing_id?: string | null
          lng?: number | null
          locali?: number | null
          log_reason?: string | null
          mq?: number | null
          n_agenzie?: number | null
          omi_zone?: string | null
          parse_status?: string | null
          piano?: string | null
          portal?: string | null
          previous_price_eur?: number | null
          prezzo?: number | null
          prezzo_iniziale?: number | null
          processed_at?: string | null
          quartiere?: string | null
          raw_address?: string | null
          raw_json?: Json | null
          ribasso_date?: string | null
          ribasso_eur?: number | null
          ribasso_pct?: number | null
          riscaldamento?: string | null
          stato?: string | null
          tipo_lead?: string | null
          tipologia?: string | null
          updated_at?: string | null
          url?: string | null
        }
        Update: {
          agency?: string | null
          agency_phone?: string | null
          anno_costruzione?: number | null
          attempts?: number | null
          bagni?: number | null
          cap?: string | null
          citta?: string | null
          civico?: string | null
          cluster_key?: string | null
          commercial_zone_slug?: never
          contendibile?: boolean | null
          contendibile_confidenza?: string | null
          contendibile_group_id?: string | null
          created_at?: string | null
          http_status?: number | null
          id?: number | null
          job_id?: string | null
          lat?: number | null
          listing_id?: string | null
          lng?: number | null
          locali?: number | null
          log_reason?: string | null
          mq?: number | null
          n_agenzie?: number | null
          omi_zone?: string | null
          parse_status?: string | null
          piano?: string | null
          portal?: string | null
          previous_price_eur?: number | null
          prezzo?: number | null
          prezzo_iniziale?: number | null
          processed_at?: string | null
          quartiere?: string | null
          raw_address?: string | null
          raw_json?: Json | null
          ribasso_date?: string | null
          ribasso_eur?: number | null
          ribasso_pct?: number | null
          riscaldamento?: string | null
          stato?: string | null
          tipo_lead?: string | null
          tipologia?: string | null
          updated_at?: string | null
          url?: string | null
        }
        Relationships: []
      }
      padova_contendibili_by_zone_v: {
        Row: {
          agencies_normalized: string[] | null
          agency_count_distinct: number | null
          agency_count_raw: number | null
          agenzie: string[] | null
          bagni: number | null
          cambio_agenzia: boolean | null
          cambio_agenzia_a: string | null
          cambio_agenzia_da: string | null
          cambio_agenzia_data: string | null
          chiave_match: string | null
          commercial_zone_slug: string | null
          confidenza: string | null
          created_at: string | null
          data_primo_annuncio: string | null
          differenza_zona_pct: number | null
          evidence_kind: string | null
          evidence_ref: string | null
          fonti: string[] | null
          giorni_fermo: number | null
          giorni_sul_mercato: number | null
          id: number | null
          is_ripubblicato: boolean | null
          last_seen_at: string | null
          lat: number | null
          lng: number | null
          locali: number | null
          match_metrics: Json | null
          match_version: string | null
          mq: number | null
          n_agenzie: number | null
          n_annunci: number | null
          n_portali: number | null
          n_ribassi: number | null
          portals_seen: string[] | null
          prezzo_immobile_eur_mq: number | null
          prezzo_max: number | null
          prezzo_medio_zona_eur_mq: number | null
          prezzo_min: number | null
          quartiere: string | null
          ribasso_pct: number | null
          score_pressione: number | null
          updated_at: string | null
          urls: string[] | null
        }
        Insert: {
          agencies_normalized?: string[] | null
          agency_count_distinct?: number | null
          agency_count_raw?: number | null
          agenzie?: string[] | null
          bagni?: number | null
          cambio_agenzia?: boolean | null
          cambio_agenzia_a?: string | null
          cambio_agenzia_da?: string | null
          cambio_agenzia_data?: string | null
          chiave_match?: string | null
          commercial_zone_slug?: string | null
          confidenza?: string | null
          created_at?: string | null
          data_primo_annuncio?: string | null
          differenza_zona_pct?: number | null
          evidence_kind?: string | null
          evidence_ref?: string | null
          fonti?: string[] | null
          giorni_fermo?: number | null
          giorni_sul_mercato?: number | null
          id?: number | null
          is_ripubblicato?: boolean | null
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          match_metrics?: Json | null
          match_version?: string | null
          mq?: number | null
          n_agenzie?: number | null
          n_annunci?: number | null
          n_portali?: number | null
          n_ribassi?: number | null
          portals_seen?: string[] | null
          prezzo_immobile_eur_mq?: number | null
          prezzo_max?: number | null
          prezzo_medio_zona_eur_mq?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          ribasso_pct?: number | null
          score_pressione?: number | null
          updated_at?: string | null
          urls?: string[] | null
        }
        Update: {
          agencies_normalized?: string[] | null
          agency_count_distinct?: number | null
          agency_count_raw?: number | null
          agenzie?: string[] | null
          bagni?: number | null
          cambio_agenzia?: boolean | null
          cambio_agenzia_a?: string | null
          cambio_agenzia_da?: string | null
          cambio_agenzia_data?: string | null
          chiave_match?: string | null
          commercial_zone_slug?: string | null
          confidenza?: string | null
          created_at?: string | null
          data_primo_annuncio?: string | null
          differenza_zona_pct?: number | null
          evidence_kind?: string | null
          evidence_ref?: string | null
          fonti?: string[] | null
          giorni_fermo?: number | null
          giorni_sul_mercato?: number | null
          id?: number | null
          is_ripubblicato?: boolean | null
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          match_metrics?: Json | null
          match_version?: string | null
          mq?: number | null
          n_agenzie?: number | null
          n_annunci?: number | null
          n_portali?: number | null
          n_ribassi?: number | null
          portals_seen?: string[] | null
          prezzo_immobile_eur_mq?: number | null
          prezzo_max?: number | null
          prezzo_medio_zona_eur_mq?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          ribasso_pct?: number | null
          score_pressione?: number | null
          updated_at?: string | null
          urls?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "padova_contendibili_commercial_zone_slug_fkey"
            columns: ["commercial_zone_slug"]
            isOneToOne: false
            referencedRelation: "civiko_commercial_zones"
            referencedColumns: ["slug"]
          },
        ]
      }
      padova_contendibili_reachability_v: {
        Row: {
          argento_best_listing_id: number | null
          argento_has_phone: boolean | null
          argento_match_count: number | null
          id: number | null
          reachability_argento: boolean | null
        }
        Relationships: []
      }
      padova_listings_totali_v: {
        Row: {
          tot_agenzie: number | null
          tot_annunci: number | null
        }
        Relationships: []
      }
      padova_listings_zone_v: {
        Row: {
          id: number | null
          microzone: string[] | null
          omi_codes: string[] | null
          quartiere_raw: string | null
          zone_slugs: string[] | null
        }
        Relationships: []
      }
      padova_multi_portale_by_zone_v: {
        Row: {
          agencies_normalized: string[] | null
          agency_count_distinct: number | null
          agenzie: string[] | null
          bagni: number | null
          chiave_match: string | null
          commercial_zone_slug: string | null
          created_at: string | null
          id: number | null
          last_seen_at: string | null
          lat: number | null
          lng: number | null
          locali: number | null
          mq: number | null
          n_annunci: number | null
          portal_count: number | null
          portals_seen: string[] | null
          prezzo_max: number | null
          prezzo_min: number | null
          quartiere: string | null
          updated_at: string | null
          urls: string[] | null
        }
        Insert: {
          agencies_normalized?: string[] | null
          agency_count_distinct?: number | null
          agenzie?: string[] | null
          bagni?: number | null
          chiave_match?: string | null
          commercial_zone_slug?: string | null
          created_at?: string | null
          id?: number | null
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          n_annunci?: number | null
          portal_count?: number | null
          portals_seen?: string[] | null
          prezzo_max?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          updated_at?: string | null
          urls?: string[] | null
        }
        Update: {
          agencies_normalized?: string[] | null
          agency_count_distinct?: number | null
          agenzie?: string[] | null
          bagni?: number | null
          chiave_match?: string | null
          commercial_zone_slug?: string | null
          created_at?: string | null
          id?: number | null
          last_seen_at?: string | null
          lat?: number | null
          lng?: number | null
          locali?: number | null
          mq?: number | null
          n_annunci?: number | null
          portal_count?: number | null
          portals_seen?: string[] | null
          prezzo_max?: number | null
          prezzo_min?: number | null
          quartiere?: string | null
          updated_at?: string | null
          urls?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "padova_multi_portale_commercial_zone_slug_fkey"
            columns: ["commercial_zone_slug"]
            isOneToOne: false
            referencedRelation: "civiko_commercial_zones"
            referencedColumns: ["slug"]
          },
        ]
      }
      padova_quartieri_stats_v: {
        Row: {
          n_agenzie: number | null
          n_annunci: number | null
          n_contendibili: number | null
          n_privati: number | null
          n_ribassi: number | null
          prezzo_max: number | null
          prezzo_min: number | null
          zona: string | null
        }
        Relationships: []
      }
      padova_totali_v: {
        Row: {
          tot_agenzie: number | null
          tot_annunci: number | null
        }
        Relationships: []
      }
      radar_budget_monthly_spend: {
        Row: {
          entries: number | null
          month_key: string | null
          runs: number | null
          spent_eur: number | null
          spent_usd: number | null
        }
        Relationships: []
      }
      total_spend_current_month: {
        Row: {
          ai_usd: number | null
          apify_usd: number | null
          firecrawl_usd: number | null
          month_start: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _is_auction_blob: { Args: { _txt: string }; Returns: boolean }
      _safe_float: { Args: { p: string }; Returns: number }
      _safe_int: { Args: { p: string }; Returns: number }
      agency_pipeline_budget_check: {
        Args: { p_cap_usd?: number }
        Returns: Json
      }
      agency_pipeline_monthly_spent_usd: { Args: never; Returns: number }
      canon_quartiere: { Args: { p: string }; Returns: string }
      canon_url: { Args: { p: string }; Returns: string }
      check_if_marketed: {
        Args: {
          p_address: string
          p_cap: string
          p_microzone?: string
          p_municipality?: string
          p_surface_mq?: number
        }
        Returns: boolean
      }
      civiko_activate_paid_zone_atomic: {
        Args: {
          p_agency_id: string
          p_app_id?: string
          p_billing_interval?: string
          p_cancel_at_period_end?: boolean
          p_current_period_end?: string
          p_email?: string
          p_plan_key?: string
          p_price_id?: string
          p_status: string
          p_stripe_customer_id: string
          p_stripe_subscription_id: string
          p_trial_end?: string
          p_zone_slug: string
        }
        Returns: Json
      }
      civiko_admin_invoke_job: {
        Args: { p_body?: Json; p_path: string }
        Returns: number
      }
      civiko_ascii_fold: { Args: { p_value: string }; Returns: string }
      civiko_cambi_zone_slug: {
        Args: { _curl: string; _quartiere: string }
        Returns: string
      }
      civiko_classify_tipo_lead: {
        Args: { p_agency: string; p_n_agenzie: number; p_src_tipo_lead: string }
        Returns: string
      }
      civiko_commissioning_claim: {
        Args: { p_provider: string; p_run_id: string; p_ttl_seconds?: number }
        Returns: boolean
      }
      civiko_commissioning_promote_apify_job: {
        Args: { p_job_id: string; p_run_id: string }
        Returns: Json
      }
      civiko_commissioning_release_claim: {
        Args: { p_provider: string; p_run_id: string }
        Returns: boolean
      }
      civiko_is_admin_agency: { Args: { _agency_id: string }; Returns: boolean }
      civiko_is_comune_padova: { Args: { p_value: string }; Returns: boolean }
      civiko_is_official_zone_slug: {
        Args: { p_slug: string }
        Returns: boolean
      }
      civiko_merge_tipo_lead: {
        Args: { p_existing: string; p_incoming: string }
        Returns: string
      }
      civiko_normalize_comune: { Args: { p_value: string }; Returns: string }
      civiko_normalize_quartiere: { Args: { p_value: string }; Returns: string }
      civiko_padova_img_group_gate_ok: {
        Args: {
          p_has_asta: boolean
          p_has_mls: boolean
          p_mq_max: number
          p_mq_min: number
          p_n_agenzie: number
          p_n_annunci_canonici: number
          p_n_bagni: number
          p_n_locali: number
          p_n_pairs: number
          p_n_pairs_attese: number
          p_n_pairs_over15: number
          p_n_pairs_photo: number
          p_n_pairs_photo_weak: number
          p_n_piani: number
          p_n_rows: number
          p_n_tipologie: number
          p_n_zone: number
          p_prezzo_max: number
          p_prezzo_min: number
        }
        Returns: boolean
      }
      civiko_padova_matcher_v4_candidates: {
        Args: never
        Returns: {
          agency_key: string
          agency_raw: string
          bagni: number
          canonical_listing_id: string
          civico_n: string
          czone_slug: string
          descr_fp: string
          fonte: string
          id: number
          identity_key: string
          is_asta: boolean
          is_mls: boolean
          l_last_seen_at: string
          lat: number
          lng: number
          locali: number
          mq: number
          piano_k: string
          prezzo: number
          quartiere: string
          tipologia: string
          title_type_ok: boolean
          url: string
          via_n: string
        }[]
      }
      civiko_padova_matcher_v4_pairs: {
        Args: never
        Returns: {
          a_id: number
          b_id: number
          dist_m: number
          evidence_branch: string
          geo_unita_testo_ok: boolean
          match_version: string
          pair_kind: string
          photo_strong: boolean
          prezzo_ratio: number
          shared_photos: number
        }[]
      }
      civiko_photo_evidence_contract: {
        Args: never
        Returns: {
          algo: string
          evidence_kind: string
          match_version: string
        }[]
      }
      civiko_pwa_counts_contract_ok: {
        Args: { p_counts: Json }
        Returns: boolean
      }
      civiko_release_zone_on_cancel_atomic: {
        Args: { p_stripe_subscription_id: string }
        Returns: Json
      }
      civiko_repair_padova_tipo_lead: { Args: never; Returns: Json }
      civiko_replace_photo_pair_evidence: {
        Args: { p_computed_at: string; p_pairs: Json }
        Returns: Json
      }
      civiko_resolve_commercial_zone_slug: {
        Args: { p_quartiere: string }
        Returns: string
      }
      claim_padova_detail_batch: {
        Args: { p_size?: number }
        Returns: {
          attempts: number
          id: number
          url: string
        }[]
      }
      clear_omi_geometry: { Args: never; Returns: undefined }
      compute_cluster_key: {
        Args: {
          p_civico: string
          p_locali: number
          p_mq: number
          p_via: string
        }
        Returns: string
      }
      detect_padova_cambio_agenzia: { Args: never; Returns: Json }
      expire_commercial_zone_trials: { Args: never; Returns: undefined }
      expire_padova_agency_listings: {
        Args: { p_seen_since: string }
        Returns: Json
      }
      generate_predictive_insight: {
        Args: { p_opportunity_id: string }
        Returns: string
      }
      get_cron_job_last_runs: {
        Args: { p_job_names: string[] }
        Returns: {
          end_time: string
          jobname: string
          return_message: string
          start_time: string
          status: string
        }[]
      }
      get_padova_verified_price_drops: {
        Args: {
          p_limit?: number
          p_max_age_days?: number
          p_min_drop_pct?: number
        }
        Returns: {
          commercial_zone_slug: string
          comune: string
          current_price_eur: number
          drops_count: number
          first_seen_at: string
          initial_price_eur: number
          last_seen_at: string
          lat: number
          listing_id: string
          lng: number
          mq: number
          observations_count: number
          omi_zone: string
          source: string
          source_id: string
          title: string
          total_drop_pct: number
          url: string
          zone_match_confidence: number
          zone_match_method: string
        }[]
      }
      get_padova_verified_price_drops_by_zone: {
        Args: {
          p_commercial_zone_slug: string
          p_limit?: number
          p_max_age_days?: number
          p_min_drop_pct?: number
        }
        Returns: {
          commercial_zone_slug: string
          comune: string
          current_price_eur: number
          drops_count: number
          first_seen_at: string
          initial_price_eur: number
          last_seen_at: string
          lat: number
          listing_id: string
          lng: number
          mq: number
          observations_count: number
          omi_zone: string
          source: string
          source_id: string
          title: string
          total_drop_pct: number
          url: string
          zone_match_confidence: number
          zone_match_method: string
        }[]
      }
      get_padova_verified_price_drops_by_zone_v2: {
        Args: {
          p_commercial_zone_slug: string
          p_limit?: number
          p_max_age_days?: number
          p_min_drop_pct?: number
          p_quartiere?: string
        }
        Returns: {
          commercial_zone_slug: string
          comune: string
          current_price_eur: number
          drops_count: number
          first_seen_at: string
          initial_price_eur: number
          last_seen_at: string
          lat: number
          listing_id: string
          lng: number
          mq: number
          observations_count: number
          omi_zone: string
          quartiere: string
          source: string
          source_id: string
          title: string
          total_drop_pct: number
          url: string
          zone_match_confidence: number
          zone_match_method: string
        }[]
      }
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
      log_cron_http_invocation: {
        Args: { p_body?: Json; p_job_name: string; p_url: string }
        Returns: number
      }
      merge_padova_contendibili: { Args: never; Returns: Json }
      norm_agency: { Args: { p: string }; Returns: string }
      norm_agency_name: { Args: { p: string }; Returns: string }
      norm_via: { Args: { p: string }; Returns: string }
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
      omi_zones_by_points: {
        Args: { p_lats: number[]; p_lngs: number[] }
        Returns: {
          idx: number
          zona: string
        }[]
      }
      padova_backfill_unit_evidence: {
        Args: { p_batch?: number; p_force?: boolean }
        Returns: Json
      }
      padova_certify_multi_portale: { Args: never; Returns: Json }
      padova_civico_norm: { Args: { p: string }; Returns: string }
      padova_cluster_points_50m: {
        Args: { p_lats: number[]; p_lngs: number[] }
        Returns: number[]
      }
      padova_descr_fp: { Args: { p: string }; Returns: string }
      padova_descr_norm: { Args: { p: string }; Returns: string }
      padova_extract_civico: { Args: { p: string }; Returns: string }
      padova_extract_via: { Args: { p: string }; Returns: string }
      padova_haversine_m: {
        Args: { lat1: number; lat2: number; lng1: number; lng2: number }
        Returns: number
      }
      padova_is_quartiere_label: { Args: { p: string }; Returns: boolean }
      padova_listing_canonical_id: {
        Args: { p_fonte?: string; p_url: string }
        Returns: string
      }
      padova_listing_has_auction_evidence: {
        Args: { p_agency?: string; p_raw: Json }
        Returns: boolean
      }
      padova_listing_has_mls_exclusive_evidence: {
        Args: { p_raw: Json }
        Returns: boolean
      }
      padova_listing_identity_key: {
        Args: { p_civ: string; p_lat: number; p_lng: number }
        Returns: string
      }
      padova_listings_price_drop_candidates: {
        Args: { p_drop_pct?: number; p_min_age_days?: number }
        Returns: {
          history_days: number
          listing_id: number
          prezzo_max: number
          prezzo_min: number
          ribasso_pct: number
        }[]
      }
      padova_omi_snapshot_breakdown: {
        Args: { p_since: string }
        Returns: {
          fascia: string
          omi_zone_code: string
          snapshot_count: number
          zona_descr: string
        }[]
      }
      padova_piano_from_text: { Args: { p: string }; Returns: string }
      padova_piano_key_norm: { Args: { p: string }; Returns: string }
      padova_unit_floor_key: { Args: { p_raw: Json }; Returns: string }
      padova_unit_floor_key_v2: { Args: { p_raw: Json }; Returns: string }
      padova_unit_tipologia: { Args: { p_raw: Json }; Returns: string }
      padova_via_key: { Args: { p: string }; Returns: string }
      process_civiko_contendibile_detail_v1: {
        Args: {
          p_commercial_zone_slug: string
          p_evidence: Json
          p_listing_id: number
          p_queue_id: string
          p_url: string
          p_worker_id: string
        }
        Returns: Json
      }
      process_padova_portal_collect_v2: {
        Args: { p_listings: Json; p_queue_id: string; p_worker_id: string }
        Returns: Json
      }
      process_padova_subito_staging: {
        Args: { p_max_rows?: number; p_since_hours?: number }
        Returns: Json
      }
      promote_padova_agencies_listings: {
        Args: { p_since?: string }
        Returns: Json
      }
      promote_padova_collect_v2_to_listings: {
        Args: { p_since?: string }
        Returns: Json
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
      recompute_padova_contendibili: { Args: never; Returns: Json }
      recompute_padova_contendibili_extras: { Args: never; Returns: Json }
      recompute_padova_listings_contendibili: { Args: never; Returns: Json }
      reserve_commercial_zone: {
        Args: { p_agency_id: string; p_slug: string }
        Returns: Json
      }
      reserve_padova_pilot_zone_atomic: {
        Args: {
          p_agency_id: string
          p_slug: string
          p_user_email?: string
          p_user_id: string
        }
        Returns: Json
      }
      resolve_padova_geo_level: {
        Args: { p_lat: number; p_lng: number }
        Returns: {
          geo_level: string
          microzona: string
          omi_zone: string
        }[]
      }
      scraping_cancel_group: { Args: { p_group_key: string }; Returns: number }
      scraping_claim: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_provider?: Database["public"]["Enums"]["scraping_provider"]
          p_worker_id: string
        }
        Returns: {
          attempt: number
          available_at: string
          completed_at: string | null
          created_at: string
          depends_on: string[]
          duration_ms: number | null
          group_key: string | null
          http_status: number | null
          id: string
          idempotency_key: string | null
          last_error: Json | null
          last_heartbeat_at: string | null
          locked_at: string | null
          locked_by: string | null
          locked_until: string | null
          max_attempts: number
          operation: string
          parent_id: string | null
          payload: Json
          priority: number
          processed_at: string | null
          processing_attempt: number
          processing_available_at: string | null
          processing_last_error: Json | null
          processing_locked_at: string | null
          processing_locked_by: string | null
          processing_locked_until: string | null
          processing_max_attempts: number
          processing_status: string
          processor: string | null
          processor_context: Json
          provider: Database["public"]["Enums"]["scraping_provider"]
          result: Json | null
          result_ref: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["scraping_queue_status"]
          timeout_seconds: number
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "scraping_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      scraping_complete: {
        Args: {
          p_duration_ms?: number
          p_http_status?: number
          p_id: string
          p_result: Json
          p_result_ref?: string
          p_worker_id: string
        }
        Returns: boolean
      }
      scraping_enqueue: {
        Args: {
          p_available_at?: string
          p_depends_on?: string[]
          p_group_key?: string
          p_idempotency_key?: string
          p_max_attempts?: number
          p_operation: string
          p_parent_id?: string
          p_payload: Json
          p_priority?: number
          p_provider: Database["public"]["Enums"]["scraping_provider"]
          p_timeout_seconds?: number
        }
        Returns: string
      }
      scraping_enqueue_processed: {
        Args: {
          p_available_at?: string
          p_depends_on?: string[]
          p_group_key?: string
          p_idempotency_key?: string
          p_max_attempts?: number
          p_operation: string
          p_parent_id?: string
          p_payload: Json
          p_priority?: number
          p_processing_max_attempts?: number
          p_processor: string
          p_processor_context?: Json
          p_provider: Database["public"]["Enums"]["scraping_provider"]
          p_timeout_seconds?: number
        }
        Returns: string
      }
      scraping_fail: {
        Args: {
          p_duration_ms?: number
          p_error: Json
          p_http_status?: number
          p_id: string
          p_retry_after_seconds?: number
          p_retryable?: boolean
          p_worker_id: string
        }
        Returns: string
      }
      scraping_heartbeat: {
        Args: { p_extend_seconds?: number; p_id: string; p_worker_id: string }
        Returns: boolean
      }
      scraping_processing_claim: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_worker_id: string
        }
        Returns: {
          id: string
          operation: string
          payload: Json
          processing_attempt: number
          processing_max_attempts: number
          processor: string
          processor_context: Json
          provider: Database["public"]["Enums"]["scraping_provider"]
          result: Json
          result_ref: string
        }[]
      }
      scraping_processing_complete: {
        Args: { p_id: string; p_worker_id: string }
        Returns: boolean
      }
      scraping_processing_fail: {
        Args: {
          p_error: Json
          p_id: string
          p_retryable?: boolean
          p_worker_id: string
        }
        Returns: string
      }
      scraping_processing_reap_expired: { Args: never; Returns: number }
      scraping_reap_expired: { Args: never; Returns: number }
      st_zone_geojson_by_descr: {
        Args: { p_descr: string }
        Returns: {
          geojson: string
          lat: number
          lng: number
        }[]
      }
      stripe_webhook_event_claim: {
        Args: { p_event_id: string; p_stale_after?: string; p_type: string }
        Returns: Json
      }
      stripe_webhook_event_mark_failed: {
        Args: { p_error?: string; p_event_id: string }
        Returns: boolean
      }
      stripe_webhook_event_mark_processed: {
        Args: { p_event_id: string }
        Returns: boolean
      }
      tick_padova_firecrawl_collect: { Args: never; Returns: undefined }
      trovabandi_verified_active_distinct_count: {
        Args: { p_now?: string }
        Returns: number
      }
      unschedule_padova_detail_chain: { Args: never; Returns: boolean }
      vault_create_secret_if_missing: {
        Args: { p_name: string; p_value: string }
        Returns: Json
      }
      vault_secret_exists: { Args: { p_name: string }; Returns: boolean }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
      civiko_one_case_status:
        | "draft"
        | "active"
        | "listed"
        | "negotiating"
        | "sold"
        | "withdrawn"
        | "archived"
      civiko_one_doc_status: "missing" | "uploaded" | "verified" | "rejected"
      civiko_one_output_kind:
        | "owner_dossier"
        | "listing_casa"
        | "listing_immobiliare"
        | "listing_idealista"
        | "listing_subito"
        | "promo_plan"
      scraping_provider: "firecrawl" | "perplexity" | "apify"
      scraping_queue_status:
        | "pending"
        | "running"
        | "retry"
        | "succeeded"
        | "dead"
        | "cancelled"
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
      civiko_one_case_status: [
        "draft",
        "active",
        "listed",
        "negotiating",
        "sold",
        "withdrawn",
        "archived",
      ],
      civiko_one_doc_status: ["missing", "uploaded", "verified", "rejected"],
      civiko_one_output_kind: [
        "owner_dossier",
        "listing_casa",
        "listing_immobiliare",
        "listing_idealista",
        "listing_subito",
        "promo_plan",
      ],
      scraping_provider: ["firecrawl", "perplexity", "apify"],
      scraping_queue_status: [
        "pending",
        "running",
        "retry",
        "succeeded",
        "dead",
        "cancelled",
      ],
    },
  },
} as const
