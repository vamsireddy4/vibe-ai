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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agency_access_grants: {
        Row: {
          agency_code: string | null
          checkout_url_pro: string | null
          checkout_url_starter: string | null
          checkout_url_ultra: string | null
          client_rate_per_minute: number
          created_at: string
          custom_checkout_url: string | null
          email: string
          granted_by: string
          id: string
          is_active: boolean
          payment_instruction: string | null
          pro_custom_minutes: number | null
          pro_custom_price: number | null
          pro_payment_url: string | null
          starter_custom_minutes: number | null
          starter_custom_price: number | null
          starter_payment_url: string | null
          ultra_custom_minutes: number | null
          ultra_custom_price: number | null
          ultra_payment_url: string | null
          updated_at: string
          wholesale_rate_per_minute: number
        }
        Insert: {
          agency_code?: string | null
          checkout_url_pro?: string | null
          checkout_url_starter?: string | null
          checkout_url_ultra?: string | null
          client_rate_per_minute?: number
          created_at?: string
          custom_checkout_url?: string | null
          email: string
          granted_by: string
          id?: string
          is_active?: boolean
          payment_instruction?: string | null
          pro_custom_minutes?: number | null
          pro_custom_price?: number | null
          pro_payment_url?: string | null
          starter_custom_minutes?: number | null
          starter_custom_price?: number | null
          starter_payment_url?: string | null
          ultra_custom_minutes?: number | null
          ultra_custom_price?: number | null
          ultra_payment_url?: string | null
          updated_at?: string
          wholesale_rate_per_minute?: number
        }
        Update: {
          agency_code?: string | null
          checkout_url_pro?: string | null
          checkout_url_starter?: string | null
          checkout_url_ultra?: string | null
          client_rate_per_minute?: number
          created_at?: string
          custom_checkout_url?: string | null
          email?: string
          granted_by?: string
          id?: string
          is_active?: boolean
          payment_instruction?: string | null
          pro_custom_minutes?: number | null
          pro_custom_price?: number | null
          pro_payment_url?: string | null
          starter_custom_minutes?: number | null
          starter_custom_price?: number | null
          starter_payment_url?: string | null
          ultra_custom_minutes?: number | null
          ultra_custom_price?: number | null
          ultra_payment_url?: string | null
          updated_at?: string
          wholesale_rate_per_minute?: number
        }
        Relationships: []
      }
      agency_relationships: {
        Row: {
          child_agency_email: string
          created_at: string | null
          id: string
          parent_agency_email: string
        }
        Insert: {
          child_agency_email: string
          created_at?: string | null
          id?: string
          parent_agency_email: string
        }
        Update: {
          child_agency_email?: string
          created_at?: string | null
          id?: string
          parent_agency_email?: string
        }
        Relationships: []
      }
      agent_tools: {
        Row: {
          agent_id: string
          created_at: string
          description: string
          http_body_template: Json | null
          http_headers: Json | null
          http_method: string
          http_url: string
          id: string
          is_active: boolean
          name: string
          parameters: Json | null
          tool_type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_id: string
          created_at?: string
          description: string
          http_body_template?: Json | null
          http_headers?: Json | null
          http_method?: string
          http_url: string
          id?: string
          is_active?: boolean
          name: string
          parameters?: Json | null
          tool_type?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_id?: string
          created_at?: string
          description?: string
          http_body_template?: Json | null
          http_headers?: Json | null
          http_method?: string
          http_url?: string
          id?: string
          is_active?: boolean
          name?: string
          parameters?: Json | null
          tool_type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_tools_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agents: {
        Row: {
          ai_provider: string
          created_at: string
          custom_crm_providers: Json
          first_speaker: string
          gmail_body_template: string | null
          id: string
          is_active: boolean
          language_hint: string | null
          max_duration: number | null
          model: string
          name: string
          phone_number_id: string | null
          system_prompt: string
          temperature: number
          ultravox_agent_id: string | null
          updated_at: string
          use_google_docs: boolean
          user_id: string
          voice: string
        }
        Insert: {
          ai_provider?: string
          created_at?: string
          custom_crm_providers?: Json
          first_speaker?: string
          gmail_body_template?: string | null
          id?: string
          is_active?: boolean
          language_hint?: string | null
          max_duration?: number | null
          model?: string
          name: string
          phone_number_id?: string | null
          system_prompt?: string
          temperature?: number
          ultravox_agent_id?: string | null
          updated_at?: string
          use_google_docs?: boolean
          user_id: string
          voice?: string
        }
        Update: {
          ai_provider?: string
          created_at?: string
          custom_crm_providers?: Json
          first_speaker?: string
          gmail_body_template?: string | null
          id?: string
          is_active?: boolean
          language_hint?: string | null
          max_duration?: number | null
          model?: string
          name?: string
          phone_number_id?: string | null
          system_prompt?: string
          temperature?: number
          ultravox_agent_id?: string | null
          updated_at?: string
          use_google_docs?: boolean
          user_id?: string
          voice?: string
        }
        Relationships: [
          {
            foreignKeyName: "agents_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_configs"
            referencedColumns: ["id"]
          },
        ]
      }
      appointment_bookings: {
        Row: {
          agent_id: string | null
          appointment_tool_id: string | null
          booked_for_email: string | null
          booked_for_name: string
          booked_for_phone: string | null
          calendar_integration_id: string | null
          calendar_name: string | null
          created_at: string
          end_time: string | null
          id: string
          metadata: Json
          notes: string | null
          provider: string
          provider_booking_id: string | null
          start_time: string
          status: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_id?: string | null
          appointment_tool_id?: string | null
          booked_for_email?: string | null
          booked_for_name: string
          booked_for_phone?: string | null
          calendar_integration_id?: string | null
          calendar_name?: string | null
          created_at?: string
          end_time?: string | null
          id?: string
          metadata?: Json
          notes?: string | null
          provider: string
          provider_booking_id?: string | null
          start_time: string
          status?: string
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_id?: string | null
          appointment_tool_id?: string | null
          booked_for_email?: string | null
          booked_for_name?: string
          booked_for_phone?: string | null
          calendar_integration_id?: string | null
          calendar_name?: string | null
          created_at?: string
          end_time?: string | null
          id?: string
          metadata?: Json
          notes?: string | null
          provider?: string
          provider_booking_id?: string | null
          start_time?: string
          status?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointment_bookings_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_bookings_appointment_tool_id_fkey"
            columns: ["appointment_tool_id"]
            isOneToOne: false
            referencedRelation: "appointment_tools"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_bookings_calendar_integration_id_fkey"
            columns: ["calendar_integration_id"]
            isOneToOne: false
            referencedRelation: "calendar_integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      appointment_tools: {
        Row: {
          agent_id: string
          appointment_types: Json
          business_hours: Json
          calendar_integration_id: string | null
          created_at: string
          id: string
          is_active: boolean
          name: string
          provider: string
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_id: string
          appointment_types?: Json
          business_hours?: Json
          calendar_integration_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          provider: string
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_id?: string
          appointment_types?: Json
          business_hours?: Json
          calendar_integration_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          provider?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointment_tools_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_tools_calendar_integration_id_fkey"
            columns: ["calendar_integration_id"]
            isOneToOne: false
            referencedRelation: "calendar_integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      audience_campaigns: {
        Row: {
          audience_id: string | null
          completed_at: string | null
          created_at: string
          delivered: number
          description: string | null
          failed: number
          failed_count: number
          id: string
          name: string
          outcomes: Json
          sent_count: number
          sent_date: string | null
          started_at: string | null
          status: string
          template_id: string | null
          template_language: string | null
          template_name: string | null
          template_structure: Json
          total_contacts: number
          updated_at: string
          user_id: string
        }
        Insert: {
          audience_id?: string | null
          completed_at?: string | null
          created_at?: string
          delivered?: number
          description?: string | null
          failed?: number
          failed_count?: number
          id?: string
          name: string
          outcomes?: Json
          sent_count?: number
          sent_date?: string | null
          started_at?: string | null
          status?: string
          template_id?: string | null
          template_language?: string | null
          template_name?: string | null
          template_structure?: Json
          total_contacts?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          audience_id?: string | null
          completed_at?: string | null
          created_at?: string
          delivered?: number
          description?: string | null
          failed?: number
          failed_count?: number
          id?: string
          name?: string
          outcomes?: Json
          sent_count?: number
          sent_date?: string | null
          started_at?: string | null
          status?: string
          template_id?: string | null
          template_language?: string | null
          template_name?: string | null
          template_structure?: Json
          total_contacts?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audience_campaigns_audience_id_fkey"
            columns: ["audience_id"]
            isOneToOne: false
            referencedRelation: "audience_segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audience_campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "Templates"
            referencedColumns: ["id"]
          },
        ]
      }
      audience_segment_contacts: {
        Row: {
          audience_id: string
          contact_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          audience_id: string
          contact_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          audience_id?: string
          contact_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audience_segment_contacts_audience_id_fkey"
            columns: ["audience_id"]
            isOneToOne: false
            referencedRelation: "audience_segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audience_segment_contacts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      audience_segments: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          tag: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          tag?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          tag?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      calendar_integrations: {
        Row: {
          access_token: string | null
          api_key: string | null
          calendar_id: string | null
          config: Json | null
          created_at: string
          display_name: string
          id: string
          is_active: boolean
          provider: string
          refresh_token: string | null
          token_expires_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token?: string | null
          api_key?: string | null
          calendar_id?: string | null
          config?: Json | null
          created_at?: string
          display_name?: string
          id?: string
          is_active?: boolean
          provider: string
          refresh_token?: string | null
          token_expires_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string | null
          api_key?: string | null
          calendar_id?: string | null
          config?: Json | null
          created_at?: string
          display_name?: string
          id?: string
          is_active?: boolean
          provider?: string
          refresh_token?: string | null
          token_expires_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      call_forwarding_numbers: {
        Row: {
          agent_id: string
          created_at: string
          id: string
          label: string | null
          phone_number: string
          priority: number
          user_id: string
        }
        Insert: {
          agent_id: string
          created_at?: string
          id?: string
          label?: string | null
          phone_number: string
          priority?: number
          user_id: string
        }
        Update: {
          agent_id?: string
          created_at?: string
          id?: string
          label?: string | null
          phone_number?: string
          priority?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_forwarding_numbers_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      call_logs: {
        Row: {
          agent_id: string | null
          billed_amount: number | null
          billed_minutes: number | null
          billed_rate_per_minute: number | null
          billed_seconds: number | null
          billing_source: string | null
          billing_status: string
          caller_number: string | null
          created_at: string
          direction: string
          duration: number | null
          ended_at: string | null
          id: string
          recipient_number: string | null
          recording_mime_type: string | null
          recording_path: string | null
          started_at: string
          status: string
          summary: string | null
          transcript: Json | null
          twilio_call_sid: string | null
          ultravox_call_id: string | null
          user_id: string
        }
        Insert: {
          agent_id?: string | null
          billed_amount?: number | null
          billed_minutes?: number | null
          billed_rate_per_minute?: number | null
          billed_seconds?: number | null
          billing_source?: string | null
          billing_status?: string
          caller_number?: string | null
          created_at?: string
          direction: string
          duration?: number | null
          ended_at?: string | null
          id?: string
          recipient_number?: string | null
          recording_mime_type?: string | null
          recording_path?: string | null
          started_at?: string
          status?: string
          summary?: string | null
          transcript?: Json | null
          twilio_call_sid?: string | null
          ultravox_call_id?: string | null
          user_id: string
        }
        Update: {
          agent_id?: string | null
          billed_amount?: number | null
          billed_minutes?: number | null
          billed_rate_per_minute?: number | null
          billed_seconds?: number | null
          billing_source?: string | null
          billing_status?: string
          caller_number?: string | null
          created_at?: string
          direction?: string
          duration?: number | null
          ended_at?: string | null
          id?: string
          recipient_number?: string | null
          recording_mime_type?: string | null
          recording_path?: string | null
          started_at?: string
          status?: string
          summary?: string | null
          transcript?: Json | null
          twilio_call_sid?: string | null
          ultravox_call_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_logs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      call_outcomes: {
        Row: {
          attempt_number: number
          automation_email_sent_at: string | null
          automation_retry_campaign_id: string | null
          automation_sheet_synced_at: string | null
          call_timestamp: string | null
          campaign_id: string
          child_names: string | null
          contact_id: string | null
          created_at: string
          id: string
          outcome: string
          parent_name: string | null
          phone_number: string
          summary: string | null
          transcript: string | null
          user_id: string
          venue_name: string | null
        }
        Insert: {
          attempt_number?: number
          automation_email_sent_at?: string | null
          automation_retry_campaign_id?: string | null
          automation_sheet_synced_at?: string | null
          call_timestamp?: string | null
          campaign_id: string
          child_names?: string | null
          contact_id?: string | null
          created_at?: string
          id?: string
          outcome?: string
          parent_name?: string | null
          phone_number: string
          summary?: string | null
          transcript?: string | null
          user_id: string
          venue_name?: string | null
        }
        Update: {
          attempt_number?: number
          automation_email_sent_at?: string | null
          automation_retry_campaign_id?: string | null
          automation_sheet_synced_at?: string | null
          call_timestamp?: string | null
          campaign_id?: string
          child_names?: string | null
          contact_id?: string | null
          created_at?: string
          id?: string
          outcome?: string
          parent_name?: string | null
          phone_number?: string
          summary?: string | null
          transcript?: string | null
          user_id?: string
          venue_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_outcomes_automation_retry_campaign_id_fkey"
            columns: ["automation_retry_campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_outcomes_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_outcomes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_phone_configs: {
        Row: {
          campaign_id: string
          created_at: string
          id: string
          phone_config_id: string
          sort_order: number
          user_id: string
        }
        Insert: {
          campaign_id: string
          created_at?: string
          id?: string
          phone_config_id: string
          sort_order?: number
          user_id: string
        }
        Update: {
          campaign_id?: string
          created_at?: string
          id?: string
          phone_config_id?: string
          sort_order?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_phone_configs_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_phone_configs_phone_config_id_fkey"
            columns: ["phone_config_id"]
            isOneToOne: false
            referencedRelation: "phone_configs"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          age_range: string | null
          agent_id: string | null
          auto_retry_count: number
          auto_retry_delay_minutes: number
          auto_start_at: string | null
          automation_sheet_id: string | null
          automation_sheet_url: string | null
          booking_target: number | null
          calls_made: number
          created_at: string
          delay_seconds: number
          elevenlabs_campaign_id: string | null
          enable_number_locking: boolean
          end_date: string | null
          execution_mode: string
          id: string
          notes: string | null
          parent_campaign_id: string | null
          phone_config_id: string | null
          round: number
          start_date: string | null
          status: string
          times: string | null
          total_contacts: number
          twilio_phone_number: string | null
          updated_at: string
          user_id: string
          venue_location: string | null
          venue_name: string
        }
        Insert: {
          age_range?: string | null
          agent_id?: string | null
          auto_retry_count?: number
          auto_retry_delay_minutes?: number
          auto_start_at?: string | null
          automation_sheet_id?: string | null
          automation_sheet_url?: string | null
          booking_target?: number | null
          calls_made?: number
          created_at?: string
          delay_seconds?: number
          elevenlabs_campaign_id?: string | null
          enable_number_locking?: boolean
          end_date?: string | null
          execution_mode?: string
          id?: string
          notes?: string | null
          parent_campaign_id?: string | null
          phone_config_id?: string | null
          round?: number
          start_date?: string | null
          status?: string
          times?: string | null
          total_contacts?: number
          twilio_phone_number?: string | null
          updated_at?: string
          user_id: string
          venue_location?: string | null
          venue_name: string
        }
        Update: {
          age_range?: string | null
          agent_id?: string | null
          auto_retry_count?: number
          auto_retry_delay_minutes?: number
          auto_start_at?: string | null
          automation_sheet_id?: string | null
          automation_sheet_url?: string | null
          booking_target?: number | null
          calls_made?: number
          created_at?: string
          delay_seconds?: number
          elevenlabs_campaign_id?: string | null
          enable_number_locking?: boolean
          end_date?: string | null
          execution_mode?: string
          id?: string
          notes?: string | null
          parent_campaign_id?: string | null
          phone_config_id?: string | null
          round?: number
          start_date?: string | null
          status?: string
          times?: string | null
          total_contacts?: number
          twilio_phone_number?: string | null
          updated_at?: string
          user_id?: string
          venue_location?: string | null
          venue_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_parent_campaign_id_fkey"
            columns: ["parent_campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_phone_config_id_fkey"
            columns: ["phone_config_id"]
            isOneToOne: false
            referencedRelation: "phone_configs"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          age_range: string | null
          campaign_id: string
          child_names: string | null
          created_at: string
          end_date: string | null
          first_message: string | null
          first_name: string
          id: string
          language: string | null
          metadata: Json | null
          phone_number: string
          sheet_reference: string | null
          start_date: string | null
          times: string | null
          user_id: string
          venue_location: string | null
          venue_name: string | null
          voice_id: string | null
        }
        Insert: {
          age_range?: string | null
          campaign_id: string
          child_names?: string | null
          created_at?: string
          end_date?: string | null
          first_message?: string | null
          first_name: string
          id?: string
          language?: string | null
          metadata?: Json | null
          phone_number: string
          sheet_reference?: string | null
          start_date?: string | null
          times?: string | null
          user_id: string
          venue_location?: string | null
          venue_name?: string | null
          voice_id?: string | null
        }
        Update: {
          age_range?: string | null
          campaign_id?: string
          child_names?: string | null
          created_at?: string
          end_date?: string | null
          first_message?: string | null
          first_name?: string
          id?: string
          language?: string | null
          metadata?: Json | null
          phone_number?: string
          sheet_reference?: string | null
          start_date?: string | null
          times?: string | null
          user_id?: string
          venue_location?: string | null
          venue_name?: string | null
          voice_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_conversations: {
        Row: {
          created_at: string
          customer_id: string
          customer_name: string | null
          id: string
          last_message: string | null
          last_message_at: string | null
          messages: Json
          status: string
          unread_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          customer_name?: string | null
          id?: string
          last_message?: string | null
          last_message_at?: string | null
          messages?: Json
          status?: string
          unread_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          customer_name?: string | null
          id?: string
          last_message?: string | null
          last_message_at?: string | null
          messages?: Json
          status?: string
          unread_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      customers: {
        Row: {
          created_at: string
          customers_data: Json
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          customers_data?: Json
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          customers_data?: Json
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      do_not_call: {
        Row: {
          added_at: string
          id: string
          parent_name: string | null
          phone_number: string
          reason: string
          user_id: string
          venue_name: string | null
        }
        Insert: {
          added_at?: string
          id?: string
          parent_name?: string | null
          phone_number: string
          reason: string
          user_id: string
          venue_name?: string | null
        }
        Update: {
          added_at?: string
          id?: string
          parent_name?: string | null
          phone_number?: string
          reason?: string
          user_id?: string
          venue_name?: string | null
        }
        Relationships: []
      }
      gmail_campaigns: {
        Row: {
          created_at: string
          extracted_contacts: Json
          id: string
          name: string
          status: string
          template_id: string | null
          total_contacts: number
          updated_at: string
          user_email: string
          user_id: string
        }
        Insert: {
          created_at?: string
          extracted_contacts?: Json
          id?: string
          name: string
          status?: string
          template_id?: string | null
          total_contacts?: number
          updated_at?: string
          user_email: string
          user_id: string
        }
        Update: {
          created_at?: string
          extracted_contacts?: Json
          id?: string
          name?: string
          status?: string
          template_id?: string | null
          total_contacts?: number
          updated_at?: string
          user_email?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "gmail_campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "gmail_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      gmail_completed_campaigns: {
        Row: {
          completed_at: string | null
          created_at: string
          failed_count: number
          id: string
          name: string
          outcomes: Json
          selected_contacts: Json
          sender_email_address: string
          sent_count: number
          source_campaign_id: string | null
          started_at: string
          status: string
          template_id: string | null
          template_name: string
          total_contacts: number
          updated_at: string
          user_email: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          failed_count?: number
          id?: string
          name: string
          outcomes?: Json
          selected_contacts?: Json
          sender_email_address?: string
          sent_count?: number
          source_campaign_id?: string | null
          started_at?: string
          status?: string
          template_id?: string | null
          template_name: string
          total_contacts?: number
          updated_at?: string
          user_email: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          failed_count?: number
          id?: string
          name?: string
          outcomes?: Json
          selected_contacts?: Json
          sender_email_address?: string
          sent_count?: number
          source_campaign_id?: string | null
          started_at?: string
          status?: string
          template_id?: string | null
          template_name?: string
          total_contacts?: number
          updated_at?: string
          user_email?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "gmail_completed_campaigns_source_campaign_id_fkey"
            columns: ["source_campaign_id"]
            isOneToOne: false
            referencedRelation: "gmail_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gmail_completed_campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "gmail_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      gmail_templates: {
        Row: {
          category: string
          created_at: string
          id: string
          linked_tags: Json
          message: string
          name: string
          updated_at: string
          user_email: string
          user_id: string
        }
        Insert: {
          category?: string
          created_at?: string
          id?: string
          linked_tags?: Json
          message: string
          name: string
          updated_at?: string
          user_email: string
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          linked_tags?: Json
          message?: string
          name?: string
          updated_at?: string
          user_email?: string
          user_id?: string
        }
        Relationships: []
      }
      knowledge_base_items: {
        Row: {
          agent_id: string
          content: string | null
          created_at: string
          file_path: string | null
          id: string
          processing_status: string | null
          title: string
          type: string
          updated_at: string
          user_id: string
          website_url: string | null
        }
        Insert: {
          agent_id: string
          content?: string | null
          created_at?: string
          file_path?: string | null
          id?: string
          processing_status?: string | null
          title: string
          type?: string
          updated_at?: string
          user_id: string
          website_url?: string | null
        }
        Update: {
          agent_id?: string
          content?: string | null
          created_at?: string
          file_path?: string | null
          id?: string
          processing_status?: string | null
          title?: string
          type?: string
          updated_at?: string
          user_id?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_base_items_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      minute_transactions: {
        Row: {
          amount: number | null
          call_log_id: string | null
          created_at: string
          id: string
          kind: string
          notes: string | null
          rate_per_minute: number | null
          seconds_delta: number
          source: string
          user_id: string
        }
        Insert: {
          amount?: number | null
          call_log_id?: string | null
          created_at?: string
          id?: string
          kind: string
          notes?: string | null
          rate_per_minute?: number | null
          seconds_delta: number
          source: string
          user_id: string
        }
        Update: {
          amount?: number | null
          call_log_id?: string | null
          created_at?: string
          id?: string
          kind?: string
          notes?: string | null
          rate_per_minute?: number | null
          seconds_delta?: number
          source?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "minute_transactions_call_log_id_fkey"
            columns: ["call_log_id"]
            isOneToOne: false
            referencedRelation: "call_logs"
            referencedColumns: ["id"]
          },
        ]
      }
      phone_configs: {
        Row: {
          channel: string
          created_at: string
          friendly_name: string | null
          id: string
          inbound_agent_id: string | null
          is_active: boolean
          phone_number: string
          provider: string
          sms_sender_type: string | null
          telnyx_alpha_sender_id: string | null
          telnyx_api_key: string | null
          telnyx_connection_id: string | null
          telnyx_dlt_entity_id: string | null
          telnyx_dlt_template_id: string | null
          telnyx_messaging_profile_id: string | null
          telnyx_public_key: string | null
          twilio_account_sid: string | null
          twilio_auth_token: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          channel?: string
          created_at?: string
          friendly_name?: string | null
          id?: string
          inbound_agent_id?: string | null
          is_active?: boolean
          phone_number: string
          provider?: string
          sms_sender_type?: string | null
          telnyx_alpha_sender_id?: string | null
          telnyx_api_key?: string | null
          telnyx_connection_id?: string | null
          telnyx_dlt_entity_id?: string | null
          telnyx_dlt_template_id?: string | null
          telnyx_messaging_profile_id?: string | null
          telnyx_public_key?: string | null
          twilio_account_sid?: string | null
          twilio_auth_token?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          channel?: string
          created_at?: string
          friendly_name?: string | null
          id?: string
          inbound_agent_id?: string | null
          is_active?: boolean
          phone_number?: string
          provider?: string
          sms_sender_type?: string | null
          telnyx_alpha_sender_id?: string | null
          telnyx_api_key?: string | null
          telnyx_connection_id?: string | null
          telnyx_dlt_entity_id?: string | null
          telnyx_dlt_template_id?: string | null
          telnyx_messaging_profile_id?: string | null
          telnyx_public_key?: string | null
          twilio_account_sid?: string | null
          twilio_auth_token?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "phone_configs_inbound_agent_id_fkey"
            columns: ["inbound_agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          agency_code: string | null
          agency_email: string | null
          analysis_model: string | null
          avatar_url: string | null
          company_name: string | null
          created_at: string
          created_by_email: string | null
          full_name: string | null
          gemini_api_key: string | null
          id: string
          timezone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          agency_code?: string | null
          agency_email?: string | null
          analysis_model?: string | null
          avatar_url?: string | null
          company_name?: string | null
          created_at?: string
          created_by_email?: string | null
          full_name?: string | null
          gemini_api_key?: string | null
          id?: string
          timezone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          agency_code?: string | null
          agency_email?: string | null
          analysis_model?: string | null
          avatar_url?: string | null
          company_name?: string | null
          created_at?: string
          created_by_email?: string | null
          full_name?: string | null
          gemini_api_key?: string | null
          id?: string
          timezone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scheduled_calls: {
        Row: {
          agent_id: string | null
          created_at: string
          id: string
          notes: string | null
          recipient_name: string | null
          recipient_number: string
          scheduled_at: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_id?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          recipient_name?: string | null
          recipient_number: string
          scheduled_at: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_id?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          recipient_name?: string | null
          recipient_number?: string
          scheduled_at?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_calls_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_campaigns: {
        Row: {
          created_at: string
          extracted_contacts: Json
          id: string
          name: string
          status: string
          template_id: string | null
          total_contacts: number
          updated_at: string
          user_email: string
          user_id: string
        }
        Insert: {
          created_at?: string
          extracted_contacts?: Json
          id?: string
          name: string
          status?: string
          template_id?: string | null
          total_contacts?: number
          updated_at?: string
          user_email: string
          user_id: string
        }
        Update: {
          created_at?: string
          extracted_contacts?: Json
          id?: string
          name?: string
          status?: string
          template_id?: string | null
          total_contacts?: number
          updated_at?: string
          user_email?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "sms_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_completed_campaigns: {
        Row: {
          completed_at: string | null
          created_at: string
          failed_count: number
          id: string
          name: string
          outcomes: Json
          phone_config_id: string | null
          selected_contacts: Json
          sender_phone_number: string
          sent_count: number
          source_campaign_id: string | null
          started_at: string
          status: string
          template_id: string | null
          template_name: string
          total_contacts: number
          updated_at: string
          user_email: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          failed_count?: number
          id?: string
          name: string
          outcomes?: Json
          phone_config_id?: string | null
          selected_contacts?: Json
          sender_phone_number: string
          sent_count?: number
          source_campaign_id?: string | null
          started_at?: string
          status?: string
          template_id?: string | null
          template_name: string
          total_contacts?: number
          updated_at?: string
          user_email: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          failed_count?: number
          id?: string
          name?: string
          outcomes?: Json
          phone_config_id?: string | null
          selected_contacts?: Json
          sender_phone_number?: string
          sent_count?: number
          source_campaign_id?: string | null
          started_at?: string
          status?: string
          template_id?: string | null
          template_name?: string
          total_contacts?: number
          updated_at?: string
          user_email?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_completed_campaigns_phone_config_id_fkey"
            columns: ["phone_config_id"]
            isOneToOne: false
            referencedRelation: "phone_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_completed_campaigns_source_campaign_id_fkey"
            columns: ["source_campaign_id"]
            isOneToOne: false
            referencedRelation: "sms_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_completed_campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "sms_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_templates: {
        Row: {
          category: string
          created_at: string
          id: string
          linked_tags: Json
          message: string
          name: string
          updated_at: string
          user_email: string
          user_id: string
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          linked_tags?: Json
          message: string
          name: string
          updated_at?: string
          user_email: string
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          linked_tags?: Json
          message?: string
          name?: string
          updated_at?: string
          user_email?: string
          user_id?: string
        }
        Relationships: []
      }
      telnyx_call_state: {
        Row: {
          agent_id: string | null
          call_control_id: string
          created_at: string
          id: string
          join_url: string
          telnyx_api_key: string
          user_id: string | null
        }
        Insert: {
          agent_id?: string | null
          call_control_id: string
          created_at?: string
          id?: string
          join_url: string
          telnyx_api_key: string
          user_id?: string | null
        }
        Update: {
          agent_id?: string | null
          call_control_id?: string
          created_at?: string
          id?: string
          join_url?: string
          telnyx_api_key?: string
          user_id?: string | null
        }
        Relationships: []
      }
      Templates: {
        Row: {
          body_text: string | null
          carousel_data: Json | null
          category: string | null
          content: string | null
          created_at: string | null
          id: string
          language: string | null
          meta_template_id: string | null
          status: string | null
          template_name: string
          template_type: string | null
          updated_at: string | null
          user_email: string
        }
        Insert: {
          body_text?: string | null
          carousel_data?: Json | null
          category?: string | null
          content?: string | null
          created_at?: string | null
          id?: string
          language?: string | null
          meta_template_id?: string | null
          status?: string | null
          template_name: string
          template_type?: string | null
          updated_at?: string | null
          user_email: string
        }
        Update: {
          body_text?: string | null
          carousel_data?: Json | null
          category?: string | null
          content?: string | null
          created_at?: string | null
          id?: string
          language?: string | null
          meta_template_id?: string | null
          status?: string | null
          template_name?: string
          template_type?: string | null
          updated_at?: string | null
          user_email?: string
        }
        Relationships: []
      }
      training_sessions: {
        Row: {
          completed_at: string | null
          created_at: string
          duration_seconds: number
          id: string
          notes: string | null
          persona_name: string
          persona_role: string | null
          score: number | null
          skill_scores: Json
          started_at: string
          status: string
          talk_ratio: number | null
          transcript: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          duration_seconds?: number
          id?: string
          notes?: string | null
          persona_name: string
          persona_role?: string | null
          score?: number | null
          skill_scores?: Json
          started_at?: string
          status?: string
          talk_ratio?: number | null
          transcript?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          duration_seconds?: number
          id?: string
          notes?: string | null
          persona_name?: string
          persona_role?: string | null
          score?: number | null
          skill_scores?: Json
          started_at?: string
          status?: string
          talk_ratio?: number | null
          transcript?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_minute_balances: {
        Row: {
          available_seconds: number
          created_at: string
          enterprise_rate_per_minute: number | null
          id: string
          last_enterprise_amount: number | null
          last_enterprise_minutes: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          available_seconds?: number
          created_at?: string
          enterprise_rate_per_minute?: number | null
          id?: string
          last_enterprise_amount?: number | null
          last_enterprise_minutes?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          available_seconds?: number
          created_at?: string
          enterprise_rate_per_minute?: number | null
          id?: string
          last_enterprise_amount?: number | null
          last_enterprise_minutes?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      webhook_logs: {
        Row: {
          created_at: string
          direction: string | null
          error_message: string | null
          event_id: string | null
          event_type: string
          from_number: string | null
          id: string
          message_id: string | null
          message_text: string | null
          occurred_at: string | null
          processed: boolean
          raw_payload: Json
          status: string | null
          to_number: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          direction?: string | null
          error_message?: string | null
          event_id?: string | null
          event_type: string
          from_number?: string | null
          id?: string
          message_id?: string | null
          message_text?: string | null
          occurred_at?: string | null
          processed?: boolean
          raw_payload: Json
          status?: string | null
          to_number?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          direction?: string | null
          error_message?: string | null
          event_id?: string | null
          event_type?: string
          from_number?: string | null
          id?: string
          message_id?: string | null
          message_text?: string | null
          occurred_at?: string | null
          processed?: boolean
          raw_payload?: Json
          status?: string | null
          to_number?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      webhooks: {
        Row: {
          agent_id: string | null
          created_at: string
          events: string[]
          id: string
          is_active: boolean
          name: string
          secret: string | null
          updated_at: string
          url: string
          user_id: string
        }
        Insert: {
          agent_id?: string | null
          created_at?: string
          events?: string[]
          id?: string
          is_active?: boolean
          name: string
          secret?: string | null
          updated_at?: string
          url: string
          user_id: string
        }
        Update: {
          agent_id?: string | null
          created_at?: string
          events?: string[]
          id?: string
          is_active?: boolean
          name?: string
          secret?: string | null
          updated_at?: string
          url?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhooks_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_api_configs: {
        Row: {
          created_at: string
          id: string
          meta_access_token: string | null
          meta_app_id: string | null
          meta_business_account_id: string | null
          meta_phone_number_id: string | null
          updated_at: string
          user_id: string
          validated_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          meta_access_token?: string | null
          meta_app_id?: string | null
          meta_business_account_id?: string | null
          meta_phone_number_id?: string | null
          updated_at?: string
          user_id: string
          validated_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          meta_access_token?: string | null
          meta_app_id?: string | null
          meta_business_account_id?: string | null
          meta_phone_number_id?: string | null
          updated_at?: string
          user_id?: string
          validated_at?: string | null
        }
        Relationships: []
      }
      whatsapp_audience_contacts: {
        Row: {
          audience_id: string
          contact_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          audience_id: string
          contact_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          audience_id?: string
          contact_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_audience_contacts_audience_id_fkey"
            columns: ["audience_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_audiences"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_audience_contacts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_audiences: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          tag: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          tag?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          tag?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_auto_reply_configs: {
        Row: {
          created_at: string
          id: string
          is_enabled: boolean
          updated_at: string
          user_id: string
          webhook_url: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_enabled?: boolean
          updated_at?: string
          user_id: string
          webhook_url?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_enabled?: boolean
          updated_at?: string
          user_id?: string
          webhook_url?: string | null
        }
        Relationships: []
      }
      whatsapp_campaigns: {
        Row: {
          audience_id: string | null
          completed_at: string | null
          created_at: string
          delivered: number
          description: string | null
          failed: number
          failed_count: number
          id: string
          name: string
          outcomes: Json
          sent_count: number
          sent_date: string | null
          started_at: string | null
          status: string
          template_id: string | null
          template_language: string | null
          template_name: string | null
          template_structure: Json
          total_contacts: number
          updated_at: string
          user_id: string
        }
        Insert: {
          audience_id?: string | null
          completed_at?: string | null
          created_at?: string
          delivered?: number
          description?: string | null
          failed?: number
          failed_count?: number
          id?: string
          name: string
          outcomes?: Json
          sent_count?: number
          sent_date?: string | null
          started_at?: string | null
          status?: string
          template_id?: string | null
          template_language?: string | null
          template_name?: string | null
          template_structure?: Json
          total_contacts?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          audience_id?: string | null
          completed_at?: string | null
          created_at?: string
          delivered?: number
          description?: string | null
          failed?: number
          failed_count?: number
          id?: string
          name?: string
          outcomes?: Json
          sent_count?: number
          sent_date?: string | null
          started_at?: string | null
          status?: string
          template_id?: string | null
          template_language?: string | null
          template_name?: string | null
          template_structure?: Json
          total_contacts?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_campaigns_audience_id_fkey"
            columns: ["audience_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_audiences"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_contacts: {
        Row: {
          created_at: string
          email: string | null
          id: string
          metadata: Json
          name: string
          phone_number: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          metadata?: Json
          name: string
          phone_number: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          metadata?: Json
          name?: string
          phone_number?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_conversations: {
        Row: {
          contact_name: string
          created_at: string
          id: string
          last_message_at: string | null
          last_message_text: string | null
          phone_number: string
          unread_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          contact_name: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          last_message_text?: string | null
          phone_number: string
          unread_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          contact_name?: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          last_message_text?: string | null
          phone_number?: string
          unread_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_messages: {
        Row: {
          body: string
          conversation_id: string
          created_at: string
          direction: string
          error_message: string | null
          id: string
          provider_message_id: string | null
          raw_payload: Json
          sent_at: string
          status: string
          user_id: string
        }
        Insert: {
          body: string
          conversation_id: string
          created_at?: string
          direction: string
          error_message?: string | null
          id?: string
          provider_message_id?: string | null
          raw_payload?: Json
          sent_at?: string
          status?: string
          user_id: string
        }
        Update: {
          body?: string
          conversation_id?: string
          created_at?: string
          direction?: string
          error_message?: string | null
          id?: string
          provider_message_id?: string | null
          raw_payload?: Json
          sent_at?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_templates: {
        Row: {
          body: string
          button_types: string[]
          buttons: Json
          buttons_enabled: boolean
          carousel_cards: Json
          category: string
          created_at: string
          footer_enabled: boolean
          footer_text: string
          header_enabled: boolean
          header_text: string
          header_type: string | null
          id: string
          language: string
          meta_status: string
          meta_template_id: string | null
          name: string
          normalized_name: string
          parameter_tokens: string[]
          template_type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body: string
          button_types?: string[]
          buttons?: Json
          buttons_enabled?: boolean
          carousel_cards?: Json
          category?: string
          created_at?: string
          footer_enabled?: boolean
          footer_text?: string
          header_enabled?: boolean
          header_text?: string
          header_type?: string | null
          id?: string
          language?: string
          meta_status?: string
          meta_template_id?: string | null
          name: string
          normalized_name: string
          parameter_tokens?: string[]
          template_type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string
          button_types?: string[]
          buttons?: Json
          buttons_enabled?: boolean
          carousel_cards?: Json
          category?: string
          created_at?: string
          footer_enabled?: boolean
          footer_text?: string
          header_enabled?: boolean
          header_text?: string
          header_type?: string | null
          id?: string
          language?: string
          meta_status?: string
          meta_template_id?: string | null
          name?: string
          normalized_name?: string
          parameter_tokens?: string[]
          template_type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      whatsapp_webhook_configs: {
        Row: {
          created_at: string
          id: string
          updated_at: string
          user_id: string
          verify_token: string
          webhook_key: string
        }
        Insert: {
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
          verify_token?: string
          webhook_key?: string
        }
        Update: {
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
          verify_token?: string
          webhook_key?: string
        }
        Relationships: []
      }
      whatsapp_webhook_events: {
        Row: {
          created_at: string
          event_type: string | null
          id: string
          payload: Json
          user_id: string
          webhook_config_id: string
        }
        Insert: {
          created_at?: string
          event_type?: string | null
          id?: string
          payload: Json
          user_id: string
          webhook_config_id: string
        }
        Update: {
          created_at?: string
          event_type?: string | null
          id?: string
          payload?: Json
          user_id?: string
          webhook_config_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_webhook_events_webhook_config_id_fkey"
            columns: ["webhook_config_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_webhook_configs"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_weekly_report_settings: {
        Row: {
          button_types: string[]
          created_at: string
          id: string
          image_names: string[]
          language: string
          prompt: string
          tone: string
          updated_at: string
          user_id: string
        }
        Insert: {
          button_types?: string[]
          created_at?: string
          id?: string
          image_names?: string[]
          language?: string
          prompt?: string
          tone?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          button_types?: string[]
          created_at?: string
          id?: string
          image_names?: string[]
          language?: string
          prompt?: string
          tone?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      xpay_payment_events: {
        Row: {
          amount: number | null
          created_at: string
          currency: string | null
          customer_email: string | null
          event_type: string
          id: string
          intent_id: string | null
          minutes_credited: number
          plan_name: string | null
          provider_event_id: string
          raw_payload: Json
          subscription_id: string | null
          user_id: string | null
        }
        Insert: {
          amount?: number | null
          created_at?: string
          currency?: string | null
          customer_email?: string | null
          event_type: string
          id?: string
          intent_id?: string | null
          minutes_credited?: number
          plan_name?: string | null
          provider_event_id: string
          raw_payload?: Json
          subscription_id?: string | null
          user_id?: string | null
        }
        Update: {
          amount?: number | null
          created_at?: string
          currency?: string | null
          customer_email?: string | null
          event_type?: string
          id?: string
          intent_id?: string | null
          minutes_credited?: number
          plan_name?: string | null
          provider_event_id?: string
          raw_payload?: Json
          subscription_id?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      client_details: {
        Row: {
          agency_code: string | null
          agency_email: string | null
          company_name: string | null
          created_by_email: string | null
          email: string | null
          full_name: string | null
          raw_user_meta_data: Json | null
          user_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      generate_agency_code: { Args: never; Returns: string }
      generate_whatsapp_verify_token: { Args: never; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
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
