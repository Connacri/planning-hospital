import { createClient } from "@supabase/supabase-js";

const supabaseUrl =
  process.env.REACT_APP_SUPABASE_URL ||
  "https://yeswhmhlyjzjqcpawxbm.supabase.co";

const supabaseKey =
  process.env.REACT_APP_SUPABASE_PUBLISHABLE_KEY ||
  process.env.REACT_APP_SUPABASE_ANON_KEY ||
  "";

export const supabaseConfigError = supabaseKey
  ? ""
  : "Configurez REACT_APP_SUPABASE_PUBLISHABLE_KEY (ou REACT_APP_SUPABASE_ANON_KEY) dans votre .env.";

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseKey);

export const supabase = hasSupabaseConfig
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  : null;
