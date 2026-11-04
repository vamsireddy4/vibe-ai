import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-local-user-id",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function decodeBase64FilePayload(value: string) {
  const normalized = value.replace(/\s/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function getAuthenticatedUser(req: Request) {
  const localUserId = (Deno.env.get("ALLOW_LOCAL_USER_HEADER") === "true" ? (req.headers.get("x-local-user-id") || "").trim() : "");
  if (localUserId) {
    const { data: profile, error } = await admin
      .from("profiles")
      .select("user_id, id")
      .or(`user_id.eq.${localUserId},id.eq.${localUserId}`)
      .maybeSingle();

    if (error || !profile) return null;
    return { id: profile.user_id };
  }

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id };
}

async function createMetaTemplateHeaderHandle(options: {
  accessToken: string;
  appId: string;
  fileName: string;
  mimeType: string;
  fileBytes: Uint8Array;
}) {
  const sessionUrl = new URL(`https://graph.facebook.com/v22.0/${options.appId}/uploads`);
  sessionUrl.searchParams.set("file_name", options.fileName);
  sessionUrl.searchParams.set("file_length", String(options.fileBytes.byteLength));
  sessionUrl.searchParams.set("file_type", options.mimeType);

  const sessionResponse = await fetch(sessionUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
    },
  });

  const sessionPayload = await sessionResponse.json().catch(() => ({}));
  const uploadSessionId = String(sessionPayload?.id || "").trim();
  if (!sessionResponse.ok || !uploadSessionId) {
    throw new Error(
      sessionPayload?.error?.error_user_msg ||
      sessionPayload?.error?.error_user_title ||
      sessionPayload?.error?.error_data?.details ||
      sessionPayload?.error?.message ||
      "Failed to create a Meta upload session.",
    );
  }

  const uploadResponse = await fetch(`https://graph.facebook.com/v22.0/${uploadSessionId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      file_offset: "0",
      "Content-Type": "application/octet-stream",
    },
    body: options.fileBytes,
  });

  const uploadPayload = await uploadResponse.json().catch(() => ({}));
  const handle = String(uploadPayload?.h || uploadPayload?.handle || "").trim();
  if (!uploadResponse.ok || !handle) {
    throw new Error(
      uploadPayload?.error?.error_user_msg ||
      uploadPayload?.error?.error_user_title ||
      uploadPayload?.error?.error_data?.details ||
      uploadPayload?.error?.message ||
      "Meta did not return a template image handle.",
    );
  }

  return handle;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json(405, { success: false, error: "Method not allowed" });
  }

  try {
    const user = await getAuthenticatedUser(req);
    if (!user?.id) {
      return json(401, { success: false, error: "Unauthorized" });
    }

    const body = await req.json().catch(() => ({}));
    const fileName = String(body?.fileName || "").trim() || `template-${Date.now()}.jpg`;
    const mimeType = String(body?.mimeType || "").trim() || "image/jpeg";
    const fileBase64 = String(body?.fileBase64 || "").trim();

    if (!fileBase64) {
      return json(400, { success: false, error: "fileBase64 is required" });
    }

    if (!mimeType.startsWith("image/")) {
      return json(400, { success: false, error: "Only image uploads are supported" });
    }

    const fileBytes = decodeBase64FilePayload(fileBase64);
    if (!fileBytes.byteLength) {
      return json(400, { success: false, error: "Uploaded file payload is empty" });
    }

    if (fileBytes.byteLength > 5 * 1024 * 1024) {
      return json(400, { success: false, error: "Image size must be 5MB or smaller" });
    }

    const { data: config, error: configError } = await admin
      .from("whatsapp_api_configs")
      .select("meta_access_token, meta_app_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (configError) {
      return json(500, { success: false, error: configError.message });
    }

    const accessToken = String(config?.meta_access_token || "").trim();
    const appId = String(config?.meta_app_id || "").trim();
    if (!accessToken || !appId) {
      return json(400, {
        success: false,
        error: "Please configure your Meta access token and App ID before uploading carousel images.",
      });
    }

    const handle = await createMetaTemplateHeaderHandle({
      accessToken,
      appId,
      fileName,
      mimeType,
      fileBytes,
    });

    return json(200, { success: true, handle });
  } catch (error) {
    return json(500, {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
