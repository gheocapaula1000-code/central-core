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
          maschi: number | null
          percentuale_over65: number | null
          percentuale_under18: number | null
          percentuale_under35: number | null
          popolazione: number | null
        }
        Insert: {
          anno?: number | null
          codice_istat: string
          comune: string
          eta_media?: number | null
          femmine?: number | null
          id?: number
          maschi?: number | null
          percentuale_over65?: number | null
          percentuale_under18?: number | null
          percentuale_under35?: number | null
          popolazione?: number | null
        }
        Update: {
          anno?: number | null
          codice_istat?: string
          comune?: string
          eta_media?: number | null
          femmine?: number | null
          id?: number
          maschi?: number | null
          percentuale_over65?: number | null
          percentuale_under18?: number | null
          percentuale_under35?: number | null
          popolazione?: number | null
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
