import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { clerkEmail, getCaller } from "./server/clerk-token";
import { composioHandle } from "./server/composio";
import { calendarHandle } from "./server/calendar";
import { minutesHandle } from "./server/minutes";

/** Verified caller of a local route: Clerk user id + email (from profiles), or null. */
const getLocalCaller = (token: string, env: Record<string, string>) =>
  getCaller(`Bearer ${token}`, {
    publishableKey: env.VITE_CLERK_PUBLISHABLE_KEY || "",
    clerkSecretKey: env.CLERK_SECRET_KEY || "",
  });

/** Runs a shared server/ handler (body + verified caller in, {status, body} out) as Vite middleware. */
function sharedRoute(env: Record<string, string>, handle: (body: any, callerId: string | null, origin: string) => Promise<{ status: number; body: unknown }>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
    let body: any;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: "Invalid request" }); }
    const auth = req.headers.authorization;
    const caller = typeof auth === "string" && auth.startsWith("Bearer ") ? await getLocalCaller(auth.slice(7), env) : null;
    const out = await handle(body, caller?.id ?? null, typeof req.headers.origin === "string" ? req.headers.origin : "");
    sendJson(res, out.status, out.body);
  };
}

/** Guard for admin routes that had no check: admin email or an active agency, else 401/403 sent. */
async function requireLocalAdminOrAgency(req: IncomingMessage, res: ServerResponse, env: Record<string, string>) {
  const auth = req.headers["authorization"];
  const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const caller = token ? await getLocalCaller(token, env) : null;
  if (!caller) {
    sendJson(res, 401, { error: "Unauthorized" });
    return null;
  }
  const adminEmail = (env.VITE_ADMIN_EMAIL || "saphaarelabs@gmail.com").toLowerCase();
  if (caller.email === adminEmail) return caller;
  const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const grants = await fetch(`${url}/rest/v1/agency_access_grants?select=is_active&email=eq.${encodeURIComponent(caller.email)}&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  }).then((r) => r.json()).catch(() => []);
  if (Array.isArray(grants) && grants[0]?.is_active) return caller;
  sendJson(res, 403, { error: "Admin/Agency access only" });
  return null;
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const functionAvailabilityCache = new Map<string, boolean>();
const missingWhatsappTablesByProject: Record<string, string[]> = {
  xtemzfpsnafnrdfmzwmf: [
    "whatsapp_contacts",
    "whatsapp_campaigns",
    "whatsapp_templates",
    "whatsapp_messages",
    "whatsapp_conversations",
    "whatsapp_audiences",
    "whatsapp_audience_contacts",
  ],
};

async function isCloneFunctionAvailable(supabaseUrl: string, functionName: string) {
  const cacheKey = `${supabaseUrl}::${functionName}`;
  if (functionAvailabilityCache.has(cacheKey)) {
    return functionAvailabilityCache.get(cacheKey)!;
  }

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const available = response.status !== 404;
    functionAvailabilityCache.set(cacheKey, available);
    return available;
  } catch {
    return true;
  }
}

async function invokeCloneWhatsappCampaignFunction(options: {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  userId: string;
  campaignId: string;
}) {
  const functionNames = ["send-campaign-messages", "run-whatsapp-campaign"];

  for (const functionName of functionNames) {
    const functionAvailable = await isCloneFunctionAvailable(options.supabaseUrl, functionName);
    if (!functionAvailable) continue;

    const response = await fetch(`${options.supabaseUrl}/functions/v1/${functionName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: options.supabaseServiceRoleKey,
        Authorization: `Bearer ${options.supabaseServiceRoleKey}`,
        "x-local-user-id": options.userId,
      },
      body: JSON.stringify({
        campaign_id: options.campaignId,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      return { ok: true as const, payload, functionName };
    }

    const errorText = JSON.stringify(payload).toLowerCase();
    const missingFunction =
      response.status === 404 ||
      errorText.includes("not_found") ||
      errorText.includes("not found");

    console.warn("[local send-campaign-messages] clone function failed", {
      functionName,
      status: response.status,
      payload,
    });

    if (!missingFunction) {
      return { ok: false as const, payload, functionName };
    }
  }

  return null;
}

async function resolveRelatedUserIds(
  supabaseUrl: string,
  supabaseServiceRoleKey: string,
  userId: string,
  userEmail: string,
) {
  const relatedUserIds = new Set<string>();
  if (userId) relatedUserIds.add(userId);

  if (userEmail) {
    try {
      const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { data: listedUsers, error: listUsersError } = await adminClient.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });

      if (!listUsersError) {
        for (const authUser of listedUsers.users || []) {
          if ((authUser.email || "").trim().toLowerCase() === userEmail) {
            relatedUserIds.add(authUser.id);
          }
        }
      }
    } catch (error) {
      console.warn("Falling back from auth.admin.listUsers during clone ownership resolution", error);
    }

    try {
      const headers = {
        apikey: supabaseServiceRoleKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
      };

      const [legacySmsCompletedResponse, legacySmsCampaignsResponse] = await Promise.all([
        fetch(
          `${supabaseUrl}/rest/v1/sms_completed_campaigns?select=user_id&user_email=eq.${encodeURIComponent(userEmail)}`,
          { headers },
        ),
        fetch(
          `${supabaseUrl}/rest/v1/sms_campaigns?select=user_id&user_email=eq.${encodeURIComponent(userEmail)}`,
          { headers },
        ),
      ]);

      const [legacySmsCompletedRows, legacySmsCampaignRows] = await Promise.all([
        legacySmsCompletedResponse.json().catch(() => []),
        legacySmsCampaignsResponse.json().catch(() => []),
      ]);

      if (!legacySmsCompletedResponse.ok) {
        throw new Error("Failed to resolve legacy ownership from completed SMS campaigns");
      }
      if (!legacySmsCampaignsResponse.ok) {
        throw new Error("Failed to resolve legacy ownership from SMS campaigns");
      }

      for (const row of [
        ...(Array.isArray(legacySmsCompletedRows) ? legacySmsCompletedRows : []),
        ...(Array.isArray(legacySmsCampaignRows) ? legacySmsCampaignRows : []),
      ]) {
        const legacyUserId = String(row?.user_id || "").trim();
        if (legacyUserId) relatedUserIds.add(legacyUserId);
      }
    } catch (error) {
      console.warn("Falling back from legacy email ownership resolution", error);
    }
  }

  return Array.from(relatedUserIds);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function sendNoContent(res: ServerResponse) {
  res.statusCode = 204;
  res.end();
}

function decodeBase64FilePayload(value: string) {
  return Buffer.from(value.replace(/\s/g, ""), "base64");
}

function buildRetryTemplateName(baseName: string) {
  const suffix = `carousel_${Date.now().toString().slice(-6)}`;
  const candidate = `${baseName}_${suffix}`;
  return candidate
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 512);
}

function shouldRetryCarouselNameConflict(details: any, cards: unknown[]) {
  if (!Array.isArray(cards) || cards.length === 0) return false;
  const errorPayload = details?.error && typeof details.error === "object" ? details.error : details;
  const joined = [
    errorPayload?.message,
    errorPayload?.error_user_title,
    errorPayload?.error_user_msg,
    errorPayload?.error_data?.details,
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");

  return (
    joined.includes("content is being deleted") ||
    (joined.includes("can't change the category") && joined.includes("use utility as the category"))
  );
}

async function createMetaTemplateHeaderHandle(options: {
  accessToken: string;
  appId: string;
  fileName: string;
  mimeType: string;
  fileBuffer: Buffer;
}) {
  const sessionUrl = new URL(`https://graph.facebook.com/v22.0/${options.appId}/uploads`);
  sessionUrl.searchParams.set("file_name", options.fileName);
  sessionUrl.searchParams.set("file_length", String(options.fileBuffer.byteLength));
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
    body: options.fileBuffer,
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

function supportsLocalWhatsappTable(projectId: string, tableName: string) {
  const missingTables = new Set(missingWhatsappTablesByProject[projectId] ?? []);
  return !missingTables.has(tableName);
}

function normalizeAuthMatchValue(value: unknown) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildJsonHeaders(extra?: Record<string, string>) {
  return {
    "Content-Type": "application/json",
    ...(extra || {}),
  };
}

function pcmToWavBuffer(pcmData: Uint8Array, sampleRate: number, channels: number, bitsPerSample: number) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const dataSize = pcmData.byteLength;

  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  return Buffer.concat([Buffer.from(header), Buffer.from(pcmData)]);
}

async function resolveCloudflareAccountId(apiKey: string, providedAccountId?: string) {
  const normalized = String(providedAccountId || "").trim();
  if (normalized) {
    return normalized;
  }

  const authHeaders = {
    Authorization: `Bearer ${apiKey}`,
  };

  const accountsResponse = await fetch("https://api.cloudflare.com/client/v4/accounts", {
    headers: authHeaders,
  });

  const accountsData = await accountsResponse.json().catch(() => ({}));
  if (!accountsResponse.ok) {
    throw new Error(
      accountsData?.errors?.[0]?.message ||
      accountsData?.result?.error ||
      accountsResponse.statusText ||
      "Failed to resolve Cloudflare account"
    );
  }

  const accounts = Array.isArray(accountsData?.result) ? accountsData.result : [];
  if (accounts.length === 1 && accounts[0]?.id) {
    return String(accounts[0].id);
  }
  if (accounts.length > 1) {
    throw new Error("This Cloudflare token has access to multiple accounts. Enter the Cloudflare Account ID in Settings.");
  }

  const membershipsResponse = await fetch("https://api.cloudflare.com/client/v4/memberships", {
    headers: authHeaders,
  });
  const membershipsData = await membershipsResponse.json().catch(() => ({}));
  if (membershipsResponse.ok) {
    const memberships = Array.isArray(membershipsData?.result) ? membershipsData.result : [];
    const membershipAccountIds = memberships
      .map((membership: any) => String(membership?.account?.id || "").trim())
      .filter(Boolean);

    if (membershipAccountIds.length === 1) {
      return membershipAccountIds[0];
    }
    if (membershipAccountIds.length > 1) {
      throw new Error("This Cloudflare token has access to multiple memberships. Enter the Cloudflare Account ID in Settings.");
    }
  }

  throw new Error("No Cloudflare account found for this API token. Enter the Cloudflare Account ID in Settings.");
}

function encodeCloudflareModelPath(model: string) {
  return String(model)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function parseErrorBody(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text) return response.statusText || "Unknown error";

  try {
    const json = JSON.parse(text);
    return json?.message || json?.error || json?.details || text;
  } catch {
    return text;
  }
}

function normalizeLocalWhatsappPhoneNumber(value: string) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

function resolveLocalWhatsappTemplateTokenValue(token: string, contact: Record<string, unknown>) {
  const firstName =
    String(contact.first_name ?? contact.name ?? contact.phone_number ?? "there").trim() || "there";
  const phoneNumber = String(contact.phone_number ?? "").trim() || "your number";
  const email = String(contact.email ?? "").trim() || "your email";

  const normalized = String(token || "").trim().toLowerCase();
  if (normalized === "first_name" || normalized === "name") return firstName;
  if (normalized === "phone_number") return phoneNumber;
  if (normalized === "email") return email;
  return firstName;
}

function normalizeLocalWhatsappTemplateName(name: string) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 512);
}

function extractLocalWhatsappTemplateParameters(value: string) {
  return Array.from(String(value || "").matchAll(/\{\{\s*([^}]+?)\s*\}\}/g), (match) => match[1]?.trim())
    .filter((token): token is string => Boolean(token))
    .filter((token, index, values) => values.indexOf(token) === index);
}

function buildLocalWhatsappNamedParameterExamples(bodyText: string) {
  const tokens = extractLocalWhatsappTemplateParameters(bodyText)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) return undefined;

  return {
    body_text_named_params: tokens.map((token) => ({
      param_name: token,
      example: token
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase()) || "Example Value",
    })),
  };
}

function normalizeLocalWhatsappCarouselButton(button: Record<string, any>) {
  const type = String(button?.type ?? "").trim().toUpperCase();
  const normalizedButton: Record<string, unknown> = {
    type,
    text: String(button?.text ?? "").trim(),
  };

  const value = String(button?.value ?? "").trim();
  const explicitUrl = String(button?.url ?? "").trim();
  const explicitPhoneNumber = String(button?.phone_number ?? "").trim();

  if (type === "URL") {
    if (explicitUrl) normalizedButton.url = explicitUrl;
    else if (value) normalizedButton.url = value;
  }

  if (type === "PHONE_NUMBER") {
    if (explicitPhoneNumber) normalizedButton.phone_number = explicitPhoneNumber;
    else if (value) normalizedButton.phone_number = value;
  }

  return normalizedButton;
}

function isValidLocalWhatsappCarouselButton(button: Record<string, any>) {
  const type = String(button?.type ?? "").trim().toUpperCase();
  const text = String(button?.text ?? "").trim();
  const value = String(button?.value ?? "").trim();
  const explicitUrl = String(button?.url ?? "").trim();
  const explicitPhoneNumber = String(button?.phone_number ?? "").trim();

  if (!text) return false;
  if (type === "QUICK_REPLY") return text.length <= 25;
  if (type === "URL") return Boolean(explicitUrl || value);
  if (type === "PHONE_NUMBER") return Boolean(explicitPhoneNumber || value);
  return false;
}

function buildLocalWhatsappCarouselComponents(mainBody: string, cards: Array<Record<string, any>>) {
  return [
    {
      type: "BODY",
      text: mainBody,
      example: buildLocalWhatsappNamedParameterExamples(mainBody),
    },
    {
      type: "CAROUSEL",
      cards: cards.map((card) => {
        const cardBodyText = String(card?.bodyText ?? "").trim();
        const headerHandleValue = String(card?.headerHandle ?? "").trim();
        return {
          components: [
            {
              type: "HEADER",
              format: "IMAGE",
              ...(headerHandleValue
                ? {
                    example: {
                      header_handle: [headerHandleValue],
                    },
                  }
                : {}),
            },
            {
              type: "BODY",
              text: cardBodyText,
              example: buildLocalWhatsappNamedParameterExamples(cardBodyText),
            },
            {
              type: "BUTTONS",
              buttons: Array.isArray(card?.buttons) ? card.buttons.map(normalizeLocalWhatsappCarouselButton) : [],
            },
          ],
        };
      }),
    },
  ];
}

function mapLocalWhatsappMetaButtonTypeForStorage(value: string) {
  switch (value) {
    case "url":
      return "visit_website";
    case "phone_number":
      return "call_phone";
    case "quick_reply":
      return "quick_message";
    default:
      return value;
  }
}

function mapLocalWhatsappMetaStatus(status: unknown) {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "pending") return "pending_review";
  if (normalized === "approved") return "approved";
  if (normalized === "rejected") return "rejected";
  if (normalized === "paused") return "paused";
  return "draft";
}

function parseLocalWhatsappTemplateDetails(components: Array<Record<string, any>>) {
  const normalizedComponents = components.map((component) => ({
    ...component,
    type: String(component.type ?? "").trim().toUpperCase(),
  }));

  const bodyComponent = normalizedComponents.find((component) => component.type === "BODY");
  const headerComponent = normalizedComponents.find((component) => component.type === "HEADER");
  const footerComponent = normalizedComponents.find((component) => component.type === "FOOTER");
  const buttonsComponent = normalizedComponents.find((component) => component.type === "BUTTONS");
  const carouselComponent = normalizedComponents.find((component) => component.type === "CAROUSEL");

  const bodyText = String(bodyComponent?.text ?? "").trim();
  const headerFormat = String(headerComponent?.format ?? "").trim().toLowerCase();
  const headerText = String(headerComponent?.text ?? "").trim();
  const footerText = String(footerComponent?.text ?? "").trim();
  const rawButtons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons : [];
  const buttonTypes = rawButtons.map((button) =>
    mapLocalWhatsappMetaButtonTypeForStorage(String(button?.type ?? "").trim().toLowerCase()),
  );
  const buttons = rawButtons.map((button) => {
    const originalType = String(button?.type ?? "").trim().toLowerCase();
    const mappedType = mapLocalWhatsappMetaButtonTypeForStorage(originalType);

    return {
      type: mappedType,
      text: String(button?.text ?? "").trim(),
      label: String(button?.text ?? "").trim(),
      url: typeof button?.url === "string" ? button.url : undefined,
      phone_number: typeof button?.phone_number === "string" ? button.phone_number : undefined,
      meta_type: originalType,
    };
  });

  return {
    bodyText,
    headerEnabled: Boolean(headerComponent),
    headerType: headerFormat || (headerText ? "text" : null),
    headerText,
    footerEnabled: Boolean(footerText),
    footerText,
    buttonsEnabled: buttons.length > 0,
    buttonTypes,
    buttons,
    parameterTokens: extractLocalWhatsappTemplateParameters(bodyText),
    carouselCards: Array.isArray(carouselComponent?.cards) ? carouselComponent.cards : [],
    templateType: carouselComponent ? "carousel" : "standard",
  };
}

function buildLocalWhatsappBodyParameters(bodyText: string) {
  return Array.from(String(bodyText || "").matchAll(/\{\{\s*([^}]+?)\s*\}\}/g), (match, index) => {
    const token = String(match[1] ?? "").trim();
    return {
      index: /^\d+$/.test(token) ? Number.parseInt(token, 10) : index + 1,
      placeholder: match[0],
      name: token,
    };
  }).filter((param) => Boolean(param.name));
}

function getLocalWhatsappBodyParameterToken(param: unknown) {
  if (typeof param === "string") return param.trim();
  if (param && typeof param === "object") {
    const candidate = param as { name?: unknown; placeholder?: unknown };
    if (typeof candidate.name === "string" && candidate.name.trim()) return candidate.name.trim();
    if (typeof candidate.placeholder === "string" && candidate.placeholder.trim()) {
      return candidate.placeholder.replace(/\{\{|\}\}|\s/g, "");
    }
  }
  return String(param ?? "").trim();
}

function parseLocalWhatsappMetaTemplateStructure(template: Record<string, any>) {
  const components = Array.isArray(template?.components) ? template.components : [];
  const structure: Record<string, any> = {
    name: String(template?.name ?? ""),
    language: String(template?.language ?? "en_US"),
    hasHeader: false,
    headerType: null,
    headerHandleId: null,
    headerImageUrl: null,
    bodyParameters: [],
    hasCarousel: false,
    carouselCards: [],
    previewBody: "",
  };

  const bodyComponent = components.find((component: any) => String(component?.type ?? "").trim().toUpperCase() === "BODY");
  const headerComponent = components.find((component: any) => String(component?.type ?? "").trim().toUpperCase() === "HEADER");
  const carouselComponent = components.find((component: any) => String(component?.type ?? "").trim().toUpperCase() === "CAROUSEL");

  const bodyText = String(bodyComponent?.text ?? "").trim();
  if (bodyText) {
    structure.previewBody = bodyText;
    structure.bodyParameters = buildLocalWhatsappBodyParameters(bodyText);
  }

  const headerFormat = String(headerComponent?.format ?? "").trim().toLowerCase();
  if (["image", "video", "document"].includes(headerFormat)) {
    const headerReference = String(headerComponent?.example?.header_handle?.[0] ?? "").trim();
    structure.hasHeader = true;
    structure.headerType = headerFormat;
    if (/^https?:\/\//i.test(headerReference)) {
      structure.headerImageUrl = headerReference;
    } else if (headerReference) {
      structure.headerHandleId = headerReference;
    }
  }

  if (carouselComponent && Array.isArray(carouselComponent.cards)) {
    structure.hasCarousel = true;
    structure.carouselCards = carouselComponent.cards.map((card: any, index: number) => {
      const cardComponents = Array.isArray(card?.components) ? card.components : [];
      const cardHeader = cardComponents.find((component: any) => String(component?.type ?? "").trim().toUpperCase() === "HEADER");
      const cardBody = cardComponents.find((component: any) => String(component?.type ?? "").trim().toUpperCase() === "BODY");
      const cardButtons = cardComponents.find((component: any) => String(component?.type ?? "").trim().toUpperCase() === "BUTTONS");
      const cardBodyText = String(cardBody?.text ?? "").trim();
      const headerReference = String(cardHeader?.example?.header_handle?.[0] ?? "").trim();

      return {
        index,
        hasHeader: Boolean(cardHeader),
        headerFormat: String(cardHeader?.format ?? "").trim().toLowerCase() || null,
        headerMediaId: /^https?:\/\//i.test(headerReference) ? null : (headerReference || null),
        headerImageUrl: /^https?:\/\//i.test(headerReference) ? headerReference : null,
        bodyText: cardBodyText || null,
        bodyParameters: cardBodyText ? buildLocalWhatsappBodyParameters(cardBodyText) : [],
        hasButtons: Boolean(cardButtons),
        buttons: Array.isArray(cardButtons?.buttons) ? cardButtons.buttons : [],
      };
    });
  }

  return structure;
}

async function fetchCanonicalLocalWhatsappTemplateStructure(
  metaBusinessAccountId: string,
  metaAccessToken: string,
  templateName: string,
  languageCode: string,
) {
  if (!metaBusinessAccountId || !metaAccessToken || !templateName) return null;

  const response = await fetch(
    `https://graph.facebook.com/v22.0/${metaBusinessAccountId}/message_templates` +
      `?name=${encodeURIComponent(templateName)}` +
      `&fields=id,name,status,category,language,components`,
    {
      headers: {
        Authorization: `Bearer ${metaAccessToken}`,
      },
    },
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        payload?.error?.error_user_msg ||
        "Failed to fetch template structure from Meta",
    );
  }

  const templates = Array.isArray(payload?.data) ? payload.data : [];
  const exactMatches = templates.filter((template: Record<string, any>) => template?.name === templateName);
  const matchedTemplate =
    exactMatches.find((template: Record<string, any>) => template?.language === languageCode) ??
    exactMatches[0] ??
    null;

  return matchedTemplate ? parseLocalWhatsappMetaTemplateStructure(matchedTemplate) : null;
}

function buildLocalWhatsappMediaValue(mediaReference: string) {
  return /^https?:\/\//i.test(mediaReference)
    ? { link: mediaReference }
    : { id: mediaReference };
}

function dedupeLocalWhatsappRows<T>(rows: T[], getKey: (row: T) => string) {
  const map = new Map<string, T>();
  for (const row of rows) {
    map.set(getKey(row), row);
  }
  return Array.from(map.values());
}

async function fetchAllLocalWhatsappMetaTemplates(metaBusinessAccountId: string, metaAccessToken: string) {
  const templates: Array<Record<string, any>> = [];
  let nextUrl = `https://graph.facebook.com/v22.0/${metaBusinessAccountId}/message_templates?limit=100&fields=id,name,status,category,language,components`;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${metaAccessToken}`,
      },
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          payload?.error?.error_user_msg ||
          "Failed to fetch WhatsApp templates from Meta",
      );
    }

    const pageData = Array.isArray(payload?.data) ? payload.data : [];
    templates.push(...pageData);
    nextUrl = String(payload?.paging?.next || "").trim();
  }

  return templates;
}

function buildLocalWhatsappTemplatePayload(
  phone: string,
  templateName: string,
  templateLang: string,
  templateStructure: Record<string, unknown> | null | undefined,
  contact: Record<string, unknown>,
) {
  const payload: any = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: {
        code: templateLang || "en_US",
      },
    },
  };

  if (!templateStructure) {
    return payload;
  }

  const components: any[] = [];
  const hasHeader = Boolean(templateStructure.hasHeader);
  const headerHandleId = String(templateStructure.headerHandleId ?? "").trim();
  const headerType = String(templateStructure.headerType ?? "").trim();

  if (hasHeader && headerHandleId && headerType) {
    components.push({
      type: "header",
      parameters: [
        {
          type: headerType,
          [headerType]: {
            id: headerHandleId,
          },
        },
      ],
    });
  }

  const bodyParameters = Array.isArray(templateStructure.bodyParameters)
    ? templateStructure.bodyParameters
    : [];

  if (bodyParameters.length > 0) {
    components.push({
      type: "body",
      parameters: bodyParameters.map((param) => {
        const token = getLocalWhatsappBodyParameterToken(param);
        const parameter: Record<string, unknown> = {
          type: "text",
          text: resolveLocalWhatsappTemplateTokenValue(token, contact),
        };

        if (token && !/^\d+$/.test(token)) {
          parameter.parameter_name = token;
        }

        return parameter;
      }),
    });
  }

  const carouselCards = Array.isArray((templateStructure as any).carouselCards)
    ? (templateStructure as any).carouselCards
    : [];

  if (Boolean((templateStructure as any).hasCarousel) && carouselCards.length > 0) {
    const cards = carouselCards.map((card: Record<string, any>, index: number) => {
      const cardComponents: Array<Record<string, unknown>> = [];
      const headerFormat = String(card?.headerFormat ?? "").trim().toLowerCase();
      const headerReference =
        String(card?.headerMediaId ?? "").trim() ||
        String(card?.headerImageUrl ?? "").trim();

      if (card?.hasHeader && ["image", "video", "document"].includes(headerFormat) && headerReference) {
        cardComponents.push({
          type: "header",
          parameters: [
            {
              type: headerFormat,
              [headerFormat]: buildLocalWhatsappMediaValue(headerReference),
            },
          ],
        });
      }

      const cardBodyParameters = Array.isArray(card?.bodyParameters)
        ? card.bodyParameters
        : buildLocalWhatsappBodyParameters(String(card?.bodyText ?? ""));

      if (cardBodyParameters.length > 0) {
        cardComponents.push({
          type: "body",
          parameters: cardBodyParameters.map((param: any) => {
            const token = String(param?.name ?? param ?? "").trim();
            const parameter: Record<string, unknown> = {
              type: "text",
              text: resolveLocalWhatsappTemplateTokenValue(token, contact),
            };

            if (token && !/^\d+$/.test(token)) {
              parameter.parameter_name = token;
            }

            return parameter;
          }),
        });
      }

      return {
        card_index: Number(card?.index ?? index),
        components: cardComponents,
      };
    }).filter((card: Record<string, unknown>) => Array.isArray(card.components) && card.components.length > 0);

    if (cards.length > 0) {
      components.push({
        type: "carousel",
        cards,
      });
    }
  }

  if (components.length > 0) {
    payload.template.components = components;
  }

  return payload;
}

function renderLocalWhatsappTemplate(body: string, contact: Record<string, unknown>) {
  const firstName =
    String(contact.first_name ?? contact.name ?? contact.phone_number ?? "there").trim() || "there";
  const phoneNumber = String(contact.phone_number ?? "").trim();
  const email = String(contact.email ?? "").trim();

  return body
    .replace(/\{\{\s*first_name\s*\}\}/gi, firstName)
    .replace(/\{\{\s*name\s*\}\}/gi, firstName)
    .replace(/\{\s*name\s*\}/gi, firstName)
    .replace(/\{\{\s*phone_number\s*\}\}/gi, phoneNumber || "your number")
    .replace(/\{\{\s*email\s*\}\}/gi, email || "your email");
}

const GEMINI_LIVE_BRIDGE_PATH = "/api/local/gemini-live";
const DEFAULT_GEMINI_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const DEFAULT_GEMINI_LIVE_VOICE = "Kore";
const GEMINI_NATIVE_VOICES = new Set([
  "Kore", "Aoede", "Leda", "Autonoe", "Erinome", "Laomedeia", "Callirrhoe", "Despina",
  "Puck", "Charon", "Fenrir", "Orus", "Vale", "Zephyr", "Umbriel",
  "Schedar", "Achird", "Sadachbia", "Sadaltager", "Iapetus",
]);

function resolveGeminiLiveModel(rawModel: unknown) {
  const normalized = String(rawModel || "").trim();
  // Keep the localhost A2A demo on the currently documented native-audio Live model.
  // Saved experimental IDs like gemini-3.1-flash-live-preview can close the Live socket
  // before setup completes when the API key/project does not have access.
  if (normalized === DEFAULT_GEMINI_LIVE_MODEL) return normalized;
  return DEFAULT_GEMINI_LIVE_MODEL;
}

function resolveGeminiLiveVoice(rawVoice: unknown) {
  const normalized = String(rawVoice || "").trim();
  return GEMINI_NATIVE_VOICES.has(normalized) ? normalized : DEFAULT_GEMINI_LIVE_VOICE;
}

function readBase64Pcm16(bytes: Uint8Array) {
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return Buffer.from(out, "binary").toString("base64");
}

const DEFAULT_RATE_PER_MINUTE = 0.1;
const FREE_SIGNUP_SECONDS = 300;
// Note: This is used at build time. Use VITE_ADMIN_EMAIL env var for dev/prod
const ADMIN_EMAIL = process.env.VITE_ADMIN_EMAIL || "saphaarelabs@gmail.com";

async function fetchSingleRow(
  supabaseUrl: string,
  supabaseServiceRoleKey: string,
  table: string,
  query: string,
) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
    },
  });
  const rows = await response.json().catch(() => []);
  if (!response.ok) {
    throw new Error(`Failed to load ${table}`);
  }
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

async function ensureLocalMinuteBalance(
  supabaseUrl: string,
  supabaseServiceRoleKey: string,
  userId: string,
) {
  let balance = await fetchSingleRow(
    supabaseUrl,
    supabaseServiceRoleKey,
    "user_minute_balances",
    `user_id=eq.${encodeURIComponent(userId)}&select=*`,
  );

  if (!balance) {
    const createResponse = await fetch(`${supabaseUrl}/rest/v1/user_minute_balances`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseServiceRoleKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        user_id: userId,
        available_seconds: FREE_SIGNUP_SECONDS,
        enterprise_rate_per_minute: DEFAULT_RATE_PER_MINUTE,
      }),
    });
    const createdRows = await createResponse.json().catch(() => []);
    if (!createResponse.ok) {
      throw new Error("Failed to initialize minute balance");
    }
    balance = Array.isArray(createdRows) ? createdRows[0] ?? null : null;

    await fetch(`${supabaseUrl}/rest/v1/minute_transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseServiceRoleKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id: userId,
        kind: "signup_credit",
        source: "free",
        seconds_delta: FREE_SIGNUP_SECONDS,
        rate_per_minute: DEFAULT_RATE_PER_MINUTE,
        amount: 0,
        notes: "Automatic free signup minutes",
      }),
    });
  }

  return balance;
}

async function isLocalUnlimitedAdmin(
  supabaseUrl: string,
  supabaseServiceRoleKey: string,
  userId: string,
) {
  // Clerk's verified email, never profiles (users can edit their own profile row).
  void supabaseUrl; void supabaseServiceRoleKey;
  return (await clerkEmail(userId, process.env.CLERK_SECRET_KEY ?? "")) === ADMIN_EMAIL.toLowerCase();
}

async function requireLocalPositiveBalance(
  supabaseUrl: string,
  supabaseServiceRoleKey: string,
  userId: string,
) {
  if (await isLocalUnlimitedAdmin(supabaseUrl, supabaseServiceRoleKey, userId)) {
    return {
      user_id: userId,
      available_seconds: Number.POSITIVE_INFINITY,
      enterprise_rate_per_minute: DEFAULT_RATE_PER_MINUTE,
    };
  }
  const balance = await ensureLocalMinuteBalance(supabaseUrl, supabaseServiceRoleKey, userId);
  if (!balance || Number(balance.available_seconds || 0) <= 0) {
    throw new Error("No minutes left. Add minutes before starting another call.");
  }
  return balance;
}

function resolveEffectiveMaxDurationSeconds(
  configuredMaxDuration: unknown,
  availableSeconds: unknown,
) {
  const configured = Math.max(1, Number(configuredMaxDuration ?? 300) || 300);
  const available = Math.floor(Number(availableSeconds));
  if (!Number.isFinite(available) || available <= 0) return configured;
  return Math.max(1, Math.min(configured, available));
}

async function creditLocalEnterpriseMinutes(
  supabaseUrl: string,
  supabaseServiceRoleKey: string,
  userId: string,
  ratePerMinute: number,
  purchaseAmount: number,
) {
  const creditedMinutes = Math.floor(purchaseAmount / ratePerMinute);
  if (creditedMinutes <= 0) {
    throw new Error("Purchase amount is too low for the selected enterprise rate.");
  }

  const creditedSeconds = creditedMinutes * 60;
  const balance = await ensureLocalMinuteBalance(supabaseUrl, supabaseServiceRoleKey, userId);
  const currentSeconds = Number(balance?.available_seconds || 0);
  const nextSeconds = currentSeconds + creditedSeconds;

  const updateResponse = await fetch(`${supabaseUrl}/rest/v1/user_minute_balances?user_id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      available_seconds: nextSeconds,
      enterprise_rate_per_minute: ratePerMinute,
      last_enterprise_amount: purchaseAmount,
      last_enterprise_minutes: creditedMinutes,
      updated_at: new Date().toISOString(),
    }),
  });
  const updatedRows = await updateResponse.json().catch(() => []);
  if (!updateResponse.ok) {
    throw new Error("Failed to update user minute balance");
  }

  await fetch(`${supabaseUrl}/rest/v1/minute_transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      kind: "enterprise_credit",
      source: "direct",
      seconds_delta: creditedSeconds,
      rate_per_minute: ratePerMinute,
      amount: purchaseAmount,
      notes: "Admin enterprise credit",
    }),
  });

  return {
    creditedMinutes,
    creditedSeconds,
    availableSeconds: nextSeconds,
    balance: Array.isArray(updatedRows) ? updatedRows[0] ?? null : null,
  };
}

async function deductLocalCallMinutes(
  supabaseUrl: string,
  supabaseServiceRoleKey: string,
  userId: string,
  callLogId: string,
  durationSeconds: number,
  kind: "demo_deduction" | "live_deduction",
) {
  if (await isLocalUnlimitedAdmin(supabaseUrl, supabaseServiceRoleKey, userId)) {
    await fetch(`${supabaseUrl}/rest/v1/call_logs?id=eq.${encodeURIComponent(callLogId)}&user_id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseServiceRoleKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        billing_status: "charged",
        billing_source: "admin_unlimited",
        billed_seconds: 0,
        billed_minutes: 0,
        billed_rate_per_minute: 0,
        billed_amount: 0,
      }),
    });

    return {
      billedSeconds: 0,
      unlimitedAdmin: true,
    };
  }

  const callLog = await fetchSingleRow(
    supabaseUrl,
    supabaseServiceRoleKey,
    "call_logs",
    `id=eq.${encodeURIComponent(callLogId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,billing_status`,
  );

  if (callLog?.billing_status === "charged") {
    return null;
  }

  const billedSeconds = Math.max(0, Number(durationSeconds || 0));
  const billedMinutes = Math.ceil(billedSeconds / 60);
  const balance = await ensureLocalMinuteBalance(supabaseUrl, supabaseServiceRoleKey, userId);
  const ratePerMinute = Number(balance?.enterprise_rate_per_minute || DEFAULT_RATE_PER_MINUTE);
  const availableSeconds = Number(balance?.available_seconds || 0);
  const remainingSeconds = Math.max(0, availableSeconds - billedSeconds);
  const billedAmount = Number((billedMinutes * ratePerMinute).toFixed(2));

  const balanceUpdateResponse = await fetch(`${supabaseUrl}/rest/v1/user_minute_balances?user_id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      available_seconds: remainingSeconds,
      updated_at: new Date().toISOString(),
    }),
  });
  const updatedBalanceRows = await balanceUpdateResponse.json().catch(() => []);
  if (!balanceUpdateResponse.ok) {
    throw new Error(`Failed to update minute balance: ${await parseErrorBody(balanceUpdateResponse)}`);
  }
  const updatedBalance = Array.isArray(updatedBalanceRows) ? updatedBalanceRows[0] ?? null : null;
  if (!updatedBalance) {
    throw new Error("Failed to update minute balance: no balance row was updated");
  }

  const transactionResponse = await fetch(`${supabaseUrl}/rest/v1/minute_transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      call_log_id: callLogId,
      kind,
      source: "direct",
      seconds_delta: -billedSeconds,
      rate_per_minute: ratePerMinute,
      amount: billedAmount,
      notes: "Automatic call deduction",
    }),
  });
  if (!transactionResponse.ok) {
    throw new Error(`Failed to insert minute transaction: ${await parseErrorBody(transactionResponse)}`);
  }

  const callLogUpdateResponse = await fetch(`${supabaseUrl}/rest/v1/call_logs?id=eq.${encodeURIComponent(callLogId)}&user_id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      billing_status: "charged",
      billing_source: "direct",
      billed_seconds: billedSeconds,
      billed_minutes: billedMinutes,
      billed_rate_per_minute: ratePerMinute,
      billed_amount: billedAmount,
    }),
  });
  const updatedCallLogRows = await callLogUpdateResponse.json().catch(() => []);
  if (!callLogUpdateResponse.ok) {
    throw new Error(`Failed to mark call log as billed: ${await parseErrorBody(callLogUpdateResponse)}`);
  }
  if (!Array.isArray(updatedCallLogRows) || !updatedCallLogRows[0]?.id) {
    throw new Error("Failed to mark call log as billed: no call log row was updated");
  }

  return {
    availableSeconds: Number(updatedBalance.available_seconds ?? remainingSeconds),
    billedSeconds,
    billedMinutes,
    billedAmount,
  };
}

function coerceIsoDate(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function insertTelnyxCallState(
  supabaseUrl: string,
  supabaseServiceRoleKey: string | undefined,
  payload: {
    call_control_id: string;
    join_url: string;
    telnyx_api_key: string;
    agent_id?: string | null;
    user_id?: string | null;
  },
) {
  if (!supabaseServiceRoleKey) {
    return;
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/telnyx_call_state`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to store Telnyx call state: ${errorText}`);
  }
}

function buildTelnyxCallBody(
  phoneConfig: any,
  recipientNumber: string,
  telnyxConnectionId: string,
  streamUrl: string,
  webhookUrl?: string,
) {
  const body: Record<string, unknown> = {
    connection_id: telnyxConnectionId,
    to: recipientNumber,
    from: phoneConfig.phone_number,
    timeout_secs: 30,
  };

  if (webhookUrl) {
    body.webhook_url = webhookUrl;
    return body;
  }

  // Local clone fallback: Telnyx can attach media streaming directly at call creation.
  body.stream_url = streamUrl;
  body.stream_track = "inbound_track";
  body.stream_bidirectional_mode = "rtp";
  body.stream_codec = "PCMU";
  body.stream_bidirectional_codec = "PCMU";
  body.stream_bidirectional_sampling_rate = 8000;
  body.stream_bidirectional_target_legs = "self";
  return body;
}

function normalizeUltravoxLanguageHint(languageHint: unknown) {
  const value = String(languageHint || "").trim();
  if (!value) return "en";

  const normalized = value.toLowerCase();
  const map: Record<string, string> = {
    english: "en",
    en: "en",
    "en-us": "en",
    "en-gb": "en",
    hindi: "hi",
    hi: "hi",
    "hi-in": "hi",
    telugu: "te",
    te: "te",
    "te-in": "te",
    tamil: "ta",
    ta: "ta",
    "ta-in": "ta",
    kannada: "kn",
    kn: "kn",
    "kn-in": "kn",
    malayalam: "ml",
    ml: "ml",
    "ml-in": "ml",
  };

  return map[normalized] || value;
}

function normalizeUltravoxCallData(callData: any, messagesData: any) {
  let duration: number | null = null;
  if (typeof callData?.billedDuration === "string") {
    const match = callData.billedDuration.match(/^([\d.]+)s$/);
    if (match) duration = Math.round(parseFloat(match[1]));
  }
  if (duration === null && callData?.joined && callData?.ended) {
    duration = Math.round((new Date(callData.ended).getTime() - new Date(callData.joined).getTime()) / 1000);
  }

  const messages = Array.isArray(messagesData?.results)
    ? messagesData.results
    : Array.isArray(messagesData)
    ? messagesData
    : [];

  const transcript = messages
    .filter((message: any) => typeof message?.text === "string" && message.text.trim().length > 0)
    .map((message: any) => {
      const role = message.role === "MESSAGE_ROLE_AGENT"
        ? "agent"
        : message.role === "MESSAGE_ROLE_USER"
        ? "user"
        : typeof message.role === "string" && message.role.startsWith("MESSAGE_ROLE_")
        ? message.role.replace("MESSAGE_ROLE_", "").toLowerCase()
        : message.role || "system";

      return {
        role,
        text: message.text,
        timestamp:
          message.wallClockTimespan?.start ||
          message.timespan?.start ||
          message.created ||
          message.callStageMessageIndex ||
          null,
      };
    });

  let status = callData?.ended ? "completed" : "in-progress";
  if (!callData?.joined && !callData?.ended) status = "initiated";
  if (callData?.endReason === "busy" || callData?.endReason === "voicemail") status = callData.endReason;
  if (callData?.endReason === "error" || callData?.endReason === "failed") status = "failed";

  return {
    duration,
    started_at: callData?.joined || callData?.created || null,
    ended_at: callData?.ended || null,
    status,
    summary: callData?.shortSummary || callData?.summary || null,
    transcript: transcript.length > 0 ? transcript : null,
  };
}

async function buildUltravoxCallBody(
  ultravoxApiKey: string,
  agent: any,
  systemPrompt: string,
  selectedTools: any[],
  medium: any,
  effectiveMaxDurationSeconds: number,
) {
  const dedupedSelectedTools = selectedTools.filter((tool, index, list) => {
    const toolName = tool?.temporaryTool?.modelToolName;
    if (!toolName) return true;
    return list.findIndex((candidate) => candidate?.temporaryTool?.modelToolName === toolName) === index;
  });

  if (agent.ultravox_agent_id) {
    const response = await fetch(`https://api.ultravox.ai/api/agents/${agent.ultravox_agent_id}`, {
      headers: { "X-API-Key": ultravoxApiKey },
    });

    if (response.ok) {
      const agentData = await response.json();
      const template = agentData?.callTemplate;
      if (template) {
        const callBody: Record<string, unknown> = {
          systemPrompt: systemPrompt || template.systemPrompt,
          temperature: Number(agent.temperature ?? template.temperature ?? 0.7),
          model: template.model,
          voice: template.voice,
          externalVoice: template.externalVoice,
          languageHint: normalizeUltravoxLanguageHint(agent.language_hint || template.languageHint || "en"),
          initialMessages: template.initialMessages,
          joinTimeout: template.joinTimeout,
          maxDuration: `${effectiveMaxDurationSeconds}s`,
          timeExceededMessage: template.timeExceededMessage,
          inactivityMessages: template.inactivityMessages,
          selectedTools: dedupedSelectedTools.length > 0 ? dedupedSelectedTools : template.selectedTools,
          medium,
          recordingEnabled: template.recordingEnabled,
          transcriptOptional: template.transcriptOptional,
          initialOutputMedium: template.initialOutputMedium,
          vadSettings: template.vadSettings,
          firstSpeakerSettings: template.firstSpeakerSettings,
          experimentalSettings: template.experimentalSettings,
          metadata: template.metadata,
          initialState: template.initialState,
          dataConnection: template.dataConnection,
          callbacks: template.callbacks,
          voiceOverrides: template.voiceOverrides,
        };

        return Object.fromEntries(
          Object.entries(callBody).filter(([, value]) => value !== undefined && value !== null),
        );
      }
    }
  }

  let modelName = agent.model || "fixie-ai/ultravox-v0.7";
  if (modelName && !String(modelName).includes("/")) {
    modelName = `fixie-ai/${modelName}`;
  }

  return {
    systemPrompt,
    model: modelName,
    voice: agent.voice,
    temperature: Number(agent.temperature),
    firstSpeakerSettings: {
      user: {
        fallback: {
          delay: "2s",
          text: `Hello, this is ${agent.name || "Vibe AI"} calling.`,
        },
      },
    },
    medium,
    languageHint: normalizeUltravoxLanguageHint(agent.language_hint || "en"),
    maxDuration: `${effectiveMaxDurationSeconds}s`,
    ...(dedupedSelectedTools.length > 0 ? { selectedTools: dedupedSelectedTools } : {}),
  };
}

async function buildUltravoxDemoCallBody(
  ultravoxApiKey: string,
  agent: any,
  systemPrompt: string,
  selectedTools: any[],
  effectiveMaxDurationSeconds: number,
) {
  const dedupedSelectedTools = selectedTools.filter((tool, index, list) => {
    const toolName = tool?.temporaryTool?.modelToolName;
    if (!toolName) return true;
    return list.findIndex((candidate) => candidate?.temporaryTool?.modelToolName === toolName) === index;
  });

  if (agent.ultravox_agent_id) {
    const response = await fetch(`https://api.ultravox.ai/api/agents/${agent.ultravox_agent_id}`, {
      headers: { "X-API-Key": ultravoxApiKey },
    });

    if (response.ok) {
      const agentData = await response.json();
      const template = agentData?.callTemplate;
      if (template) {
        return Object.fromEntries(
          Object.entries({
            systemPrompt: systemPrompt || template.systemPrompt,
            temperature: Number(agent.temperature ?? template.temperature ?? 0.7),
            model: template.model,
            voice: template.voice,
            externalVoice: template.externalVoice,
            languageHint: normalizeUltravoxLanguageHint(agent.language_hint || template.languageHint || "en"),
            initialMessages: template.initialMessages,
            joinTimeout: template.joinTimeout,
            maxDuration: `${effectiveMaxDurationSeconds}s`,
            timeExceededMessage: template.timeExceededMessage,
            inactivityMessages: template.inactivityMessages,
            selectedTools: dedupedSelectedTools.length > 0 ? dedupedSelectedTools : template.selectedTools,
            recordingEnabled: template.recordingEnabled,
            transcriptOptional: template.transcriptOptional,
            initialOutputMedium: template.initialOutputMedium,
            vadSettings: template.vadSettings,
            firstSpeakerSettings: template.firstSpeakerSettings,
            experimentalSettings: template.experimentalSettings,
            metadata: template.metadata,
            initialState: template.initialState,
            dataConnection: template.dataConnection,
            callbacks: template.callbacks,
            voiceOverrides: template.voiceOverrides,
          }).filter(([, value]) => value !== undefined && value !== null),
        );
      }
    }
  }

  let modelName = agent.model || "fixie-ai/ultravox-v0.7";
  if (modelName && !String(modelName).includes("/")) {
    modelName = `fixie-ai/${modelName}`;
  }

  const callBody: Record<string, unknown> = {
    systemPrompt,
    model: modelName,
    voice: agent.voice,
    temperature: Number(agent.temperature),
    firstSpeakerSettings: agent.first_speaker === "FIRST_SPEAKER_AGENT" ? { agent: {} } : { user: {} },
    languageHint: normalizeUltravoxLanguageHint(agent.language_hint || "en"),
    maxDuration: `${effectiveMaxDurationSeconds}s`,
  };
  if (dedupedSelectedTools.length > 0) {
    callBody.selectedTools = dedupedSelectedTools;
  }
  return callBody;
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  process.env.CLERK_SECRET_KEY ??= env.CLERK_SECRET_KEY; // server-only, for verified-email admin checks

  return {
    server: {
      host: "127.0.0.1",
      port: 5173,
      // Voice agent (services/voice-agent) behind the app's own origin: /voice-agent/* -> :8787/*
      proxy: {
        "/voice-agent": { target: "http://127.0.0.1:8787", ws: true, rewrite: (p) => p.replace(/^\/voice-agent/, "") },
      },
      hmr: {
        overlay: false,
      },
    },
    plugins: [
      react(),
      {
        name: "local-outbound-call-route",
        configureServer(server) {
          // CRM Integrations via Composio: per-user sessions, Connect Links, connection status, one test call.
          server.middlewares.use("/api/local/composio", sharedRoute(env, (body, id, origin) => composioHandle(body, id, origin, env.COMPOSIO_API_KEY || "")),
          );
          server.middlewares.use("/api/local/cloudflare-ai", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const { accountId, apiKey, model, prompt } = await readJsonBody(req);

              if (!apiKey || !model || !prompt) {
                sendJson(res, 400, { error: "apiKey, model, and prompt are required" });
                return;
              }

              const resolvedAccountId = await resolveCloudflareAccountId(String(apiKey), accountId);

              const response = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(resolvedAccountId)}/ai/run/${encodeCloudflareModelPath(String(model))}`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${String(apiKey)}`,
                  },
                  body: JSON.stringify({
                    temperature: 0.1,
                    messages: [
                      {
                        role: "system",
                        content: "Return valid JSON only. Do not use markdown fences.",
                      },
                      {
                        role: "user",
                        content: String(prompt),
                      },
                    ],
                    max_tokens: 2048,
                  }),
                }
              );

              const data = await response.json().catch(() => ({}));
              if (!response.ok) {
                sendJson(res, response.status, {
                  error:
                    data?.error?.message ||
                    data?.errors?.[0]?.message ||
                    data?.result?.error ||
                    response.statusText ||
                    "Cloudflare AI request failed",
                  details: data,
                });
                return;
              }

              const content = Array.isArray(data?.choices?.[0]?.message?.content)
                ? data.choices[0].message.content
                    .map((item: any) => (typeof item?.text === "string" ? item.text : ""))
                    .join("")
                    .trim()
                : typeof data?.choices?.[0]?.message?.content === "string"
                  ? data.choices[0].message.content.trim()
                  : typeof data?.result?.response === "string"
                    ? data.result.response.trim()
                    : typeof data?.response === "string"
                      ? data.response.trim()
                  : "";

              sendJson(res, 200, { content, raw: data, accountId: resolvedAccountId });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/ultravox-call-details", async (req, res) => {
            if (req.method !== "GET") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const url = new URL(req.url || "", "http://localhost");
              const callId = url.searchParams.get("callId");
              const ultravoxApiKey = env.VITE_ULTRAVOX_API_KEY || env.ULTRAVOX_API_KEY;

              if (!callId) {
                sendJson(res, 400, { error: "callId is required" });
                return;
              }
              if (!ultravoxApiKey) {
                sendJson(res, 500, { error: "Ultravox API key is not configured" });
                return;
              }

              const [callResponse, messagesResponse] = await Promise.all([
                fetch(`https://api.ultravox.ai/api/calls/${callId}`, {
                  headers: { "X-API-Key": ultravoxApiKey },
                }),
                fetch(`https://api.ultravox.ai/api/calls/${callId}/messages?mode=in_call&pageSize=500`, {
                  headers: { "X-API-Key": ultravoxApiKey },
                }),
              ]);

              const callData = await callResponse.json().catch(() => ({}));
              const messagesData = await messagesResponse.json().catch(() => ({}));

              if (!callResponse.ok) {
                if (callResponse.status === 404) {
                  sendNoContent(res);
                  return;
                }
                sendJson(res, 200, {
                  unavailable: true,
                  error: callData?.message || callData?.error || "Failed to fetch Ultravox call",
                });
                return;
              }

              if (!messagesResponse.ok) {
                sendJson(res, 200, {
                  ...normalizeUltravoxCallData(callData, []),
                  unavailable: true,
                  error: messagesData?.message || messagesData?.error || "Failed to fetch Ultravox transcript",
                });
                return;
              }

              sendJson(res, 200, normalizeUltravoxCallData(callData, messagesData));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 200, { unavailable: true, error: message });
            }
          });

          server.middlewares.use("/api/local/outbound-call", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const {
                agent,
                phoneConfig,
                recipientNumber,
                userId,
              } = await readJsonBody(req);

              const resolvedUserId =
                userId ||
                agent?.user_id ||
                phoneConfig?.user_id ||
                null;

              if (!agent || !phoneConfig || !recipientNumber || !resolvedUserId) {
                sendJson(res, 400, { error: "agent, phoneConfig, recipientNumber and userId are required" });
                return;
              }

              const ultravoxApiKey = env.VITE_ULTRAVOX_API_KEY || env.ULTRAVOX_API_KEY;
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const geminiApiKey = env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY;
              const sarvamApiKey = env.SARVAM_API_KEY;
              if (!ultravoxApiKey) {
                sendJson(res, 500, { error: "Ultravox API key is not configured" });
                return;
              }
              if (!supabaseUrl) {
                sendJson(res, 500, { error: "Supabase URL is not configured" });
                return;
              }

              const balance = await requireLocalPositiveBalance(supabaseUrl, supabaseServiceRoleKey!, resolvedUserId);
              const effectiveMaxDurationSeconds = resolveEffectiveMaxDurationSeconds(
                agent.max_duration,
                balance.available_seconds,
              );

              const provider = phoneConfig.provider || "twilio";
              const aiProvider = agent.ai_provider || "ultravox";
              const telnyxWebhookUrl =
                provider === "telnyx" && await isCloneFunctionAvailable(supabaseUrl, "handle-telnyx-webhook")
                  ? `${supabaseUrl}/functions/v1/handle-telnyx-webhook`
                  : undefined;
              let providerCallId = "";
              let outboundAiCallId = "";

              if (aiProvider === "gemini") {
                if (!geminiApiKey) {
                  sendJson(res, 500, { error: "Gemini API key is not configured" });
                  return;
                }

                const bridgeUrl = `${supabaseUrl}/functions/v1/gemini-voice-bridge`.replace("https://", "wss://");
                const telnyxBridgeUrl = `${supabaseUrl}/functions/v1/gemini-voice-bridge?agent_id=${agent.id}&provider=telnyx`.replace("https://", "wss://");

                if (provider === "telnyx") {
                  const telnyxApiKey = String(phoneConfig.telnyx_api_key || "").trim();
                  const telnyxConnectionId = String(phoneConfig.telnyx_connection_id || "").trim();
                  if (!telnyxApiKey || !telnyxConnectionId) {
                    sendJson(res, 400, { error: "Telnyx API key or connection ID is missing" });
                    return;
                  }

                  const telnyxResponse = await fetch("https://api.telnyx.com/v2/calls", {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${telnyxApiKey}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(buildTelnyxCallBody(
                      phoneConfig,
                      recipientNumber,
                      telnyxConnectionId,
                      telnyxBridgeUrl,
                      telnyxWebhookUrl,
                    )),
                  });

                  const telnyxData = await telnyxResponse.json();
                  if (!telnyxResponse.ok) {
                    sendJson(res, 500, { error: telnyxData?.errors?.[0]?.detail || "Failed to place Telnyx call" });
                    return;
                  }

                  providerCallId = telnyxData?.data?.call_control_id || "";
                  await insertTelnyxCallState(supabaseUrl, supabaseServiceRoleKey, {
                    call_control_id: providerCallId,
                    join_url: telnyxBridgeUrl,
                    telnyx_api_key: telnyxApiKey,
                    agent_id: agent.id || null,
                    user_id: agent.user_id || phoneConfig.user_id || null,
                  });
                  outboundAiCallId = providerCallId;
                } else {
                  const twilioAccountSid = String(phoneConfig.twilio_account_sid || "").trim();
                  const twilioAuthToken = String(phoneConfig.twilio_auth_token || "").trim();
                  if (!twilioAccountSid || !twilioAuthToken) {
                    sendJson(res, 400, { error: "Twilio Account SID or Auth Token is missing" });
                    return;
                  }

                  const twiml = `<Response><Connect><Stream url="${bridgeUrl}"><Parameter name="agent_id" value="${agent.id}"/></Stream></Connect></Response>`;
                  const twilioResponse = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Calls.json`, {
                    method: "POST",
                    headers: {
                      Authorization: `Basic ${Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString("base64")}`,
                      "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: new URLSearchParams({
                      To: recipientNumber,
                      From: phoneConfig.phone_number,
                      Twiml: twiml,
                    }).toString(),
                  });

                  const twilioData = await twilioResponse.json();
                  if (!twilioResponse.ok) {
                    sendJson(res, 500, { error: twilioData?.message || "Failed to place Twilio call" });
                    return;
                  }

                  providerCallId = twilioData?.sid || "";
                  outboundAiCallId = providerCallId;
                }
              } else if (aiProvider === "sarvam") {
                if (!sarvamApiKey) {
                  sendJson(res, 500, { error: "Sarvam API key is not configured" });
                  return;
                }

                const bridgeUrl = `${supabaseUrl}/functions/v1/sarvam-voice-bridge`.replace("https://", "wss://");
                const telnyxBridgeUrl = `${supabaseUrl}/functions/v1/sarvam-voice-bridge?agent_id=${agent.id}&provider=telnyx`.replace("https://", "wss://");

                if (provider === "telnyx") {
                  const telnyxApiKey = String(phoneConfig.telnyx_api_key || "").trim();
                  const telnyxConnectionId = String(phoneConfig.telnyx_connection_id || "").trim();
                  if (!telnyxApiKey || !telnyxConnectionId) {
                    sendJson(res, 400, { error: "Telnyx API key or connection ID is missing" });
                    return;
                  }

                  const telnyxResponse = await fetch("https://api.telnyx.com/v2/calls", {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${telnyxApiKey}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(buildTelnyxCallBody(
                      phoneConfig,
                      recipientNumber,
                      telnyxConnectionId,
                      telnyxBridgeUrl,
                      telnyxWebhookUrl,
                    )),
                  });

                  const telnyxData = await telnyxResponse.json();
                  if (!telnyxResponse.ok) {
                    sendJson(res, 500, { error: telnyxData?.errors?.[0]?.detail || "Failed to place Telnyx call" });
                    return;
                  }

                  providerCallId = telnyxData?.data?.call_control_id || "";
                  await insertTelnyxCallState(supabaseUrl, supabaseServiceRoleKey, {
                    call_control_id: providerCallId,
                    join_url: telnyxBridgeUrl,
                    telnyx_api_key: telnyxApiKey,
                    agent_id: agent.id || null,
                    user_id: agent.user_id || phoneConfig.user_id || null,
                  });
                  outboundAiCallId = providerCallId;
                } else {
                  const twilioAccountSid = String(phoneConfig.twilio_account_sid || "").trim();
                  const twilioAuthToken = String(phoneConfig.twilio_auth_token || "").trim();
                  if (!twilioAccountSid || !twilioAuthToken) {
                    sendJson(res, 400, { error: "Twilio Account SID or Auth Token is missing" });
                    return;
                  }

                  const twiml = `<Response><Connect><Stream url="${bridgeUrl}"><Parameter name="agent_id" value="${agent.id}"/><Parameter name="provider" value="twilio"/></Stream></Connect></Response>`;
                  const twilioResponse = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Calls.json`, {
                    method: "POST",
                    headers: {
                      Authorization: `Basic ${Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString("base64")}`,
                      "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: new URLSearchParams({
                      To: recipientNumber,
                      From: phoneConfig.phone_number,
                      Twiml: twiml,
                    }).toString(),
                  });

                  const twilioData = await twilioResponse.json();
                  if (!twilioResponse.ok) {
                    sendJson(res, 500, { error: twilioData?.message || "Failed to place Twilio call" });
                    return;
                  }

                  providerCallId = twilioData?.sid || "";
                  outboundAiCallId = providerCallId;
                }
              } else {
                const serviceHeaders = {
                  apikey: supabaseServiceRoleKey!,
                  Authorization: `Bearer ${supabaseServiceRoleKey!}`,
                };
                const fetchOptionalRows = async (url: string) => {
                  const response = await fetch(url, { headers: serviceHeaders });
                  const data = await response.json().catch(() => []);
                  if (!response.ok) {
                    console.error("[local outbound call] optional fetch failed", { url, data });
                    return [];
                  }
                  return Array.isArray(data) ? data : [];
                };

                const [kbItems, agentTools, appointmentTools, forwardingNumbers] = await Promise.all([
                  fetchOptionalRows(
                    `${supabaseUrl}/rest/v1/knowledge_base_items?agent_id=eq.${encodeURIComponent(agent.id)}&select=*`,
                  ),
                  fetchOptionalRows(
                    `${supabaseUrl}/rest/v1/agent_tools?agent_id=eq.${encodeURIComponent(agent.id)}&is_active=eq.true&select=*`,
                  ),
                  fetchOptionalRows(
                    `${supabaseUrl}/rest/v1/appointment_tools?agent_id=eq.${encodeURIComponent(agent.id)}&is_active=eq.true&select=*,calendar_integrations(*)`,
                  ),
                  fetchOptionalRows(
                    `${supabaseUrl}/rest/v1/call_forwarding_numbers?agent_id=eq.${encodeURIComponent(agent.id)}&select=*&order=priority.asc`,
                  ),
                ]);

                let systemPrompt = agent.system_prompt || "";
                const now = new Date();
                systemPrompt += `\n\n--- CURRENT DATE & TIME ---\nToday is ${now.toISOString().split("T")[0]} (${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}). Current time (UTC): ${now.toISOString()}.\n`;
                if (Array.isArray(kbItems) && kbItems.length > 0) {
                  systemPrompt += "\n\n--- KNOWLEDGE BASE ---\n";
                  for (const item of kbItems) {
                    if (item?.content) systemPrompt += `\n## ${item.title}\n${item.content}\n`;
                    else if (item?.website_url) systemPrompt += `\n## ${item.title}\nRefer to: ${item.website_url}\n`;
                  }
                }

                const KNOWN_VALUE_MAP: Record<string, string> = {
                  "call.id": "KNOWN_PARAM_CALL_ID",
                  "call.stage_id": "KNOWN_PARAM_CALL_STAGE_ID",
                  "call.state": "KNOWN_PARAM_CALL_STATE",
                  "call.conversation_history": "KNOWN_PARAM_CONVERSATION_HISTORY",
                  "call.sample_rate": "KNOWN_PARAM_CALL_SAMPLE_RATE",
                };
                const END_BEHAVIOR_MAP: Record<string, string> = {
                  "Speaks": "AGENT_TEXT_BEHAVIOR_AGENT_SPEAKS",
                  "Listens": "AGENT_TEXT_BEHAVIOR_AGENT_LISTENS",
                  "Speaks Once": "AGENT_TEXT_BEHAVIOR_AGENT_SPEAKS_ONCE",
                };
                const locationToUltravox = (loc: string) => {
                  if (loc === "header") return "PARAMETER_LOCATION_HEADER";
                  if (loc === "query") return "PARAMETER_LOCATION_QUERY";
                  return "PARAMETER_LOCATION_BODY";
                };
                const selectedTools: any[] = [];

                if (Array.isArray(agentTools)) {
                  for (const tool of agentTools) {
                    const dynamicParameters: any[] = [];
                    const automaticParameters: any[] = [];
                    if (Array.isArray(tool.parameters)) {
                      for (const p of tool.parameters as any[]) {
                        if (p.paramType === "automatic") {
                          automaticParameters.push({
                            name: p.name,
                            location: locationToUltravox(p.location),
                            knownValue: KNOWN_VALUE_MAP[p.knownValue] || p.knownValue,
                          });
                        } else {
                          dynamicParameters.push({
                            name: p.name,
                            location: locationToUltravox(p.location),
                            schema: p.schema || { type: p.type || "string", description: p.description || "" },
                            required: !!p.required,
                          });
                        }
                      }
                    }

                    const staticParameters: any[] = [];
                    if (tool.http_headers && typeof tool.http_headers === "object") {
                      for (const [headerName, headerValue] of Object.entries(tool.http_headers as Record<string, string>)) {
                        if (headerName && headerValue) {
                          staticParameters.push({
                            name: headerName,
                            location: "PARAMETER_LOCATION_HEADER",
                            value: headerValue,
                          });
                        }
                      }
                    }
                    if (tool.http_body_template && typeof tool.http_body_template === "object") {
                      for (const [key, value] of Object.entries(tool.http_body_template as Record<string, any>)) {
                        if (key.startsWith("__")) continue;
                        staticParameters.push({
                          name: key,
                          location: "PARAMETER_LOCATION_BODY",
                          value: String(value),
                        });
                      }
                    }

                    const bodyMeta = (tool.http_body_template as Record<string, any>) || {};
                    const temporaryTool: any = {
                      modelToolName: tool.name,
                      description: tool.description,
                      dynamicParameters,
                      http: {
                        baseUrlPattern: tool.http_url,
                        httpMethod: tool.http_method,
                      },
                    };
                    if (staticParameters.length > 0) temporaryTool.staticParameters = staticParameters;
                    if (automaticParameters.length > 0) temporaryTool.automaticParameters = automaticParameters;
                    if (bodyMeta.__agentEndBehavior && END_BEHAVIOR_MAP[bodyMeta.__agentEndBehavior]) {
                      temporaryTool.defaultReaction = END_BEHAVIOR_MAP[bodyMeta.__agentEndBehavior];
                    }
                    if (bodyMeta.__staticResponse) {
                      temporaryTool.staticResponse = bodyMeta.__staticResponse;
                    }
                    selectedTools.push({ temporaryTool });
                  }
                }

                const activeAppointmentTools = Array.isArray(appointmentTools)
                  ? appointmentTools.filter((apptTool: any) => apptTool?.calendar_integrations?.is_active !== false)
                  : [];

                if (activeAppointmentTools.length > 0) {
                  const checkAvailabilityUrl = `${supabaseUrl}/functions/v1/check-calendar-availability`;
                  const bookAppointmentUrl = `${supabaseUrl}/functions/v1/book-calendar-appointment`;

                  for (const apptTool of activeAppointmentTools) {
                    const integration = apptTool.calendar_integrations;
                    if (!integration) continue;

                    const enabledDays = Object.entries(apptTool.business_hours as Record<string, any>)
                      .filter(([_, v]: any) => v.enabled)
                      .map(([day, v]: any) => `${day}: ${v.start}-${v.end}`)
                      .join(", ");
                    const typesList = (apptTool.appointment_types as any[]).map((t: any) => `${t.name} (${t.duration}min)`).join(", ");

                    systemPrompt += `\n\n--- APPOINTMENT TOOL: ${apptTool.name} ---`;
                    systemPrompt += `\nProvider: ${apptTool.provider}`;
                    systemPrompt += `\nBusiness Hours: ${enabledDays}`;
                    systemPrompt += `\nAppointment Types: ${typesList}`;
                    systemPrompt += `\nUse check_availability_${apptTool.name.replace(/[^a-zA-Z0-9]/g, "_")} to check calendar availability.`;
                    systemPrompt += `\nUse book_appointment_${apptTool.name.replace(/[^a-zA-Z0-9]/g, "_")} to book an appointment.\n`;

                    const toolNameSuffix = apptTool.name.replace(/[^a-zA-Z0-9]/g, "_");
                    const authHeaders = [{ name: "x-ultravox-tool-key", location: "PARAMETER_LOCATION_HEADER", value: ultravoxApiKey }];

                    selectedTools.push({
                      temporaryTool: {
                        modelToolName: `check_availability_${toolNameSuffix}`,
                        description: `Check calendar availability for ${apptTool.name}. Returns available time slots for a given date.`,
                        dynamicParameters: [
                          { name: "date", location: "PARAMETER_LOCATION_BODY", schema: { type: "string", description: "Date to check availability (YYYY-MM-DD format)" }, required: true },
                          { name: "duration_minutes", location: "PARAMETER_LOCATION_BODY", schema: { type: "number", description: "Desired meeting duration in minutes" }, required: false },
                        ],
                        http: { baseUrlPattern: checkAvailabilityUrl, httpMethod: "POST" },
                        staticParameters: [
                          { name: "provider", location: "PARAMETER_LOCATION_BODY", value: apptTool.provider },
                          { name: "integration_id", location: "PARAMETER_LOCATION_BODY", value: integration.id },
                          ...authHeaders,
                        ],
                      },
                    });

                    selectedTools.push({
                      temporaryTool: {
                        modelToolName: `book_appointment_${toolNameSuffix}`,
                        description: `Book an appointment using ${apptTool.name}. Schedule a meeting at a specific date and time.`,
                        dynamicParameters: [
                          { name: "start_time", location: "PARAMETER_LOCATION_BODY", schema: { type: "string", description: "Start time in ISO 8601 format" }, required: true },
                          { name: "end_time", location: "PARAMETER_LOCATION_BODY", schema: { type: "string", description: "End time in ISO 8601 format. Optional if duration_minutes is provided" }, required: false },
                          { name: "duration_minutes", location: "PARAMETER_LOCATION_BODY", schema: { type: "number", description: "Duration in minutes if end_time is omitted" }, required: false },
                          { name: "attendee_name", location: "PARAMETER_LOCATION_BODY", schema: { type: "string", description: "Name of the person booking" }, required: true },
                          { name: "attendee_email", location: "PARAMETER_LOCATION_BODY", schema: { type: "string", description: "Email of the person booking" }, required: false },
                          { name: "attendee_phone", location: "PARAMETER_LOCATION_BODY", schema: { type: "string", description: "Phone number of the person booking" }, required: false },
                          { name: "notes", location: "PARAMETER_LOCATION_BODY", schema: { type: "string", description: "Additional notes" }, required: false },
                        ],
                        http: { baseUrlPattern: bookAppointmentUrl, httpMethod: "POST" },
                        staticParameters: [
                          { name: "provider", location: "PARAMETER_LOCATION_BODY", value: apptTool.provider },
                          { name: "integration_id", location: "PARAMETER_LOCATION_BODY", value: integration.id },
                          ...authHeaders,
                        ],
                      },
                    });
                  }
                }

                if (Array.isArray(forwardingNumbers) && forwardingNumbers.length > 0) {
                  const numbersList = forwardingNumbers
                    .map((fn: any, i: number) => `${i + 1}. ${fn.phone_number}${fn.label ? ` (${fn.label})` : ""}`)
                    .join(", ");
                  systemPrompt += `\n\n--- CALL FORWARDING ---`;
                  systemPrompt += `\nYou can transfer the caller to a human agent if they request it or if you cannot help them.`;
                  systemPrompt += `\nAvailable transfer destinations (in priority order): ${numbersList}`;
                  systemPrompt += `\nAlways confirm with the caller before transferring.\n`;
                }

                const medium = provider === "telnyx" ? { telnyx: {} } : { twilio: {} };
                const ultravoxBody = await buildUltravoxCallBody(
                  ultravoxApiKey,
                  agent,
                  systemPrompt,
                  selectedTools,
                  medium,
                  effectiveMaxDurationSeconds,
                );

                const ultravoxResponse = await fetch("https://api.ultravox.ai/api/calls", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-API-Key": ultravoxApiKey,
                  },
                  body: JSON.stringify(ultravoxBody),
                });

                const ultravoxRaw = await ultravoxResponse.text();
                const ultravoxData = (() => {
                  if (!ultravoxRaw) return {};
                  try {
                    return JSON.parse(ultravoxRaw);
                  } catch {
                    return {};
                  }
                })();
                if (!ultravoxResponse.ok) {
                  sendJson(res, 500, {
                    error: ultravoxData?.message || ultravoxData?.error || "Failed to create Ultravox call",
                    details: ultravoxData?.details || ultravoxData || ultravoxRaw,
                  });
                  return;
                }

                const joinUrl = ultravoxData.joinUrl as string;
                outboundAiCallId = ultravoxData.callId as string;

                if (provider === "telnyx") {
                  const telnyxApiKey = String(phoneConfig.telnyx_api_key || "").trim();
                  const telnyxConnectionId = String(phoneConfig.telnyx_connection_id || "").trim();
                  if (!telnyxApiKey || !telnyxConnectionId) {
                    sendJson(res, 400, { error: "Telnyx API key or connection ID is missing" });
                    return;
                  }

                  const telnyxResponse = await fetch("https://api.telnyx.com/v2/calls", {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${telnyxApiKey}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(buildTelnyxCallBody(
                      phoneConfig,
                      recipientNumber,
                      telnyxConnectionId,
                      joinUrl,
                      telnyxWebhookUrl,
                    )),
                  });

                  const telnyxData = await telnyxResponse.json();
                  if (!telnyxResponse.ok) {
                    sendJson(res, 500, { error: telnyxData?.errors?.[0]?.detail || "Failed to place Telnyx call" });
                    return;
                  }

                  providerCallId = telnyxData?.data?.call_control_id || "";
                  await insertTelnyxCallState(supabaseUrl, supabaseServiceRoleKey, {
                    call_control_id: providerCallId,
                    join_url: joinUrl,
                    telnyx_api_key: telnyxApiKey,
                    agent_id: agent.id || null,
                    user_id: agent.user_id || phoneConfig.user_id || null,
                  });
                } else {
                  const twilioAccountSid = String(phoneConfig.twilio_account_sid || "").trim();
                  const twilioAuthToken = String(phoneConfig.twilio_auth_token || "").trim();
                  if (!twilioAccountSid || !twilioAuthToken) {
                    sendJson(res, 400, { error: "Twilio Account SID or Auth Token is missing" });
                    return;
                  }

                  const twiml = `<Response><Connect><Stream url="${joinUrl}" /></Connect></Response>`;
                  const twilioResponse = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Calls.json`, {
                    method: "POST",
                    headers: {
                      Authorization: `Basic ${Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString("base64")}`,
                      "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: new URLSearchParams({
                      To: recipientNumber,
                      From: phoneConfig.phone_number,
                      Twiml: twiml,
                    }).toString(),
                  });

                  const twilioData = await twilioResponse.json();
                  if (!twilioResponse.ok) {
                    sendJson(res, 500, { error: twilioData?.message || "Failed to place Twilio call" });
                    return;
                  }

                  providerCallId = twilioData?.sid || "";
                }
              }

              sendJson(res, 200, {
                success: true,
                providerCallId,
                ultravoxCallId: outboundAiCallId,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/create-demo-call", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              let stage = "read-body";
              const { agentId, userId } = await readJsonBody(req);
              const ultravoxApiKey = env.VITE_ULTRAVOX_API_KEY || env.ULTRAVOX_API_KEY;
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

              if (!agentId || !userId) {
                sendJson(res, 400, { error: "agentId and userId are required" });
                return;
              }
              if (!ultravoxApiKey) {
                sendJson(res, 500, { error: "Ultravox API key is not configured" });
                return;
              }
              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              const balance = await requireLocalPositiveBalance(supabaseUrl, supabaseServiceRoleKey, userId);

              stage = "load-agent";
              const agentResponse = await fetch(
                `${supabaseUrl}/rest/v1/agents?id=eq.${encodeURIComponent(agentId)}&user_id=eq.${encodeURIComponent(userId)}&select=*`,
                {
                  headers: {
                    apikey: supabaseServiceRoleKey,
                    Authorization: `Bearer ${supabaseServiceRoleKey}`,
                  },
                },
              );
              const agentRows = await agentResponse.json().catch(() => []);
              const agent = Array.isArray(agentRows) ? agentRows[0] : null;

              if (!agentResponse.ok || !agent) {
                sendJson(res, 404, {
                  error: "Agent not found",
                  stage,
                  details: Array.isArray(agentRows) ? null : agentRows,
                });
                return;
              }

              const effectiveMaxDurationSeconds = resolveEffectiveMaxDurationSeconds(
                agent.max_duration,
                balance.available_seconds,
              );

              const serviceHeaders = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };
              const fetchOptionalRows = async (nextStage: string, url: string) => {
                stage = nextStage;
                const response = await fetch(url, { headers: serviceHeaders });
                const data = await response.json().catch(() => []);
                if (!response.ok) {
                  console.error(`[local demo call] optional fetch failed at ${nextStage}`, data);
                  return [];
                }
                return Array.isArray(data) ? data : [];
              };

              const kbItems = await fetchOptionalRows(
                "load-kb",
                `${supabaseUrl}/rest/v1/knowledge_base_items?agent_id=eq.${encodeURIComponent(agent.id)}&select=*`,
              );
              const agentTools = await fetchOptionalRows(
                "load-agent-tools",
                `${supabaseUrl}/rest/v1/agent_tools?agent_id=eq.${encodeURIComponent(agent.id)}&is_active=eq.true&select=*`,
              );
              const appointmentTools = await fetchOptionalRows(
                "load-appointment-tools",
                `${supabaseUrl}/rest/v1/appointment_tools?agent_id=eq.${encodeURIComponent(agent.id)}&is_active=eq.true&select=*,calendar_integrations(*)`,
              );
              const forwardingNumbers = await fetchOptionalRows(
                "load-forwarding",
                `${supabaseUrl}/rest/v1/call_forwarding_numbers?agent_id=eq.${encodeURIComponent(agent.id)}&select=*&order=priority.asc`,
              );

              let systemPrompt = agent.system_prompt || "";
              const now = new Date();
              systemPrompt += `\n\n--- CURRENT DATE & TIME ---\nToday is ${now.toISOString().split("T")[0]} (${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}). Current time (UTC): ${now.toISOString()}.\n`;
              if (Array.isArray(kbItems) && kbItems.length > 0) {
                systemPrompt += "\n\n--- KNOWLEDGE BASE ---\n";
                for (const item of kbItems) {
                  if (item?.content) systemPrompt += `\n## ${item.title}\n${item.content}\n`;
                  else if (item?.website_url) systemPrompt += `\n## ${item.title}\nRefer to: ${item.website_url}\n`;
                }
              }

              const KNOWN_VALUE_MAP: Record<string, string> = {
                "call.id": "KNOWN_PARAM_CALL_ID",
                "call.stage_id": "KNOWN_PARAM_CALL_STAGE_ID",
                "call.state": "KNOWN_PARAM_CALL_STATE",
                "call.conversation_history": "KNOWN_PARAM_CONVERSATION_HISTORY",
                "call.sample_rate": "KNOWN_PARAM_CALL_SAMPLE_RATE",
              };
              const END_BEHAVIOR_MAP: Record<string, string> = {
                "Speaks": "AGENT_TEXT_BEHAVIOR_AGENT_SPEAKS",
                "Listens": "AGENT_TEXT_BEHAVIOR_AGENT_LISTENS",
                "Speaks Once": "AGENT_TEXT_BEHAVIOR_AGENT_SPEAKS_ONCE",
              };
              const locationToUltravox = (loc: string) => {
                if (loc === "header") return "PARAMETER_LOCATION_HEADER";
                if (loc === "query") return "PARAMETER_LOCATION_QUERY";
                return "PARAMETER_LOCATION_BODY";
              };
              const selectedTools: any[] = [];

              if (Array.isArray(agentTools)) {
                for (const tool of agentTools) {
                  const dynamicParameters: any[] = [];
                  const automaticParameters: any[] = [];
                  if (Array.isArray(tool.parameters)) {
                    for (const p of tool.parameters as any[]) {
                      if (p.paramType === "automatic") {
                        automaticParameters.push({
                          name: p.name,
                          location: locationToUltravox(p.location),
                          knownValue: KNOWN_VALUE_MAP[p.knownValue] || p.knownValue,
                        });
                      } else {
                        dynamicParameters.push({
                          name: p.name,
                          location: locationToUltravox(p.location),
                          schema: p.schema || { type: p.type || "string", description: p.description || "" },
                          required: !!p.required,
                        });
                      }
                    }
                  }

                  const staticParameters: any[] = [];
                  if (tool.http_headers && typeof tool.http_headers === "object") {
                    for (const [headerName, headerValue] of Object.entries(tool.http_headers as Record<string, string>)) {
                      if (headerName && headerValue) {
                        staticParameters.push({
                          name: headerName,
                          location: "PARAMETER_LOCATION_HEADER",
                          value: headerValue,
                        });
                      }
                    }
                  }
                  if (tool.http_body_template && typeof tool.http_body_template === "object") {
                    for (const [key, value] of Object.entries(tool.http_body_template as Record<string, any>)) {
                      if (key.startsWith("__")) continue;
                      staticParameters.push({
                        name: key,
                        location: "PARAMETER_LOCATION_BODY",
                        value: String(value),
                      });
                    }
                  }

                  const bodyMeta = (tool.http_body_template as Record<string, any>) || {};
                  const temporaryTool: any = {
                    modelToolName: tool.name,
                    description: tool.description,
                    dynamicParameters,
                    http: {
                      baseUrlPattern: tool.http_url,
                      httpMethod: tool.http_method,
                    },
                  };
                  if (staticParameters.length > 0) temporaryTool.staticParameters = staticParameters;
                  if (automaticParameters.length > 0) temporaryTool.automaticParameters = automaticParameters;
                  if (bodyMeta.__agentEndBehavior && END_BEHAVIOR_MAP[bodyMeta.__agentEndBehavior]) {
                    temporaryTool.defaultReaction = END_BEHAVIOR_MAP[bodyMeta.__agentEndBehavior];
                  }
                  if (bodyMeta.__staticResponse) {
                    temporaryTool.staticResponse = bodyMeta.__staticResponse;
                  }
                  selectedTools.push({ temporaryTool });
                }
              }

              const activeAppointmentTools = Array.isArray(appointmentTools)
                ? appointmentTools.filter((apptTool: any) => apptTool?.calendar_integrations?.is_active !== false)
                : [];

              if (activeAppointmentTools.length > 0) {
                const checkAvailabilityUrl = `${supabaseUrl}/functions/v1/check-calendar-availability`;
                const bookAppointmentUrl = `${supabaseUrl}/functions/v1/book-calendar-appointment`;

                for (const apptTool of activeAppointmentTools) {
                  const integration = apptTool?.calendar_integrations;
                  if (!integration) continue;

                  const enabledDays = Object.entries((apptTool.business_hours || {}) as Record<string, any>)
                    .filter(([_, v]: any) => v.enabled)
                    .map(([day, v]: any) => `${day}: ${v.start}-${v.end}`)
                    .join(", ");
                  const typesList = Array.isArray(apptTool.appointment_types)
                    ? apptTool.appointment_types.map((t: any) => `${t.name} (${t.duration}min)`).join(", ")
                    : "";

                  systemPrompt += `\n\n--- APPOINTMENT TOOL: ${apptTool.name} ---`;
                  systemPrompt += `\nProvider: ${apptTool.provider}`;
                  systemPrompt += `\nBusiness Hours: ${enabledDays}`;
                  systemPrompt += `\nAppointment Types: ${typesList}`;
                  systemPrompt += `\nUse check_availability_${String(apptTool.name).replace(/[^a-zA-Z0-9]/g, "_")} to check calendar availability.`;
                  systemPrompt += `\nUse book_appointment_${String(apptTool.name).replace(/[^a-zA-Z0-9]/g, "_")} to book an appointment.\n`;

                  const toolNameSuffix = String(apptTool.name).replace(/[^a-zA-Z0-9]/g, "_");
                  const authHeaders = [{ name: "x-ultravox-tool-key", location: "PARAMETER_LOCATION_HEADER", value: ultravoxApiKey }];

                  selectedTools.push({
                    temporaryTool: {
                      modelToolName: `check_availability_${toolNameSuffix}`,
                      description: `Check calendar availability for ${apptTool.name}. Returns available time slots for a given date.`,
                      dynamicParameters: [
                        { name: "date", location: "PARAMETER_LOCATION_BODY", schema: { type: "string", description: "Date to check availability (YYYY-MM-DD format)" }, required: true },
                        { name: "duration_minutes", location: "PARAMETER_LOCATION_BODY", schema: { type: "number", description: "Desired meeting duration in minutes" }, required: false },
                      ],
                      http: { baseUrlPattern: checkAvailabilityUrl, httpMethod: "POST" },
                      staticParameters: [
                        { name: "provider", location: "PARAMETER_LOCATION_BODY", value: apptTool.provider },
                        { name: "integration_id", location: "PARAMETER_LOCATION_BODY", value: integration.id },
                        ...authHeaders,
                      ],
                    },
                  });

                  selectedTools.push({
                    temporaryTool: {
                      modelToolName: `book_appointment_${toolNameSuffix}`,
                      description: `Book an appointment using ${apptTool.name}. Schedule a meeting at a specific date and time.`,
                      dynamicParameters: [
                        { name: "start_time", location: "PARAMETER_LOCATION_BODY", schema: { type: "string", description: "Start time in ISO 8601 format" }, required: true },
                        { name: "end_time", location: "PARAMETER_LOCATION_BODY", schema: { type: "string", description: "End time in ISO 8601 format. Optional if duration_minutes is provided" }, required: false },
                        { name: "duration_minutes", location: "PARAMETER_LOCATION_BODY", schema: { type: "number", description: "Duration in minutes if end_time is omitted" }, required: false },
                        { name: "attendee_name", location: "PARAMETER_LOCATION_BODY", schema: { type: "string", description: "Name of the person booking" }, required: true },
                        { name: "attendee_email", location: "PARAMETER_LOCATION_BODY", schema: { type: "string", description: "Email of the person booking" }, required: false },
                        { name: "attendee_phone", location: "PARAMETER_LOCATION_BODY", schema: { type: "string", description: "Phone number of the person booking" }, required: false },
                        { name: "notes", location: "PARAMETER_LOCATION_BODY", schema: { type: "string", description: "Additional notes" }, required: false },
                      ],
                      http: { baseUrlPattern: bookAppointmentUrl, httpMethod: "POST" },
                      staticParameters: [
                        { name: "provider", location: "PARAMETER_LOCATION_BODY", value: apptTool.provider },
                        { name: "integration_id", location: "PARAMETER_LOCATION_BODY", value: integration.id },
                        ...authHeaders,
                      ],
                    },
                  });
                }
              }

              if (Array.isArray(forwardingNumbers) && forwardingNumbers.length > 0) {
                const numbersList = forwardingNumbers.map((fn: any, i: number) => `${i + 1}. ${fn.phone_number}${fn.label ? ` (${fn.label})` : ""}`).join(", ");
                systemPrompt += `\n\n--- CALL FORWARDING ---`;
                systemPrompt += `\nYou can transfer the caller to a human agent if they request it or if you cannot help them.`;
                systemPrompt += `\nAvailable transfer destinations (in priority order): ${numbersList}`;
                systemPrompt += `\nAlways confirm with the caller before transferring.\n`;
              }

              stage = "build-ultravox-body";
              const ultravoxBody = await buildUltravoxDemoCallBody(
                ultravoxApiKey,
                agent,
                systemPrompt,
                selectedTools,
                effectiveMaxDurationSeconds,
              );
              stage = "create-ultravox-call";
              const ultravoxResponse = await fetch("https://api.ultravox.ai/api/calls", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-API-Key": ultravoxApiKey,
                },
                body: JSON.stringify(ultravoxBody),
              });
              const ultravoxRaw = await ultravoxResponse.text();
              const ultravoxData = (() => {
                if (!ultravoxRaw) return {};
                try {
                  return JSON.parse(ultravoxRaw);
                } catch {
                  return {};
                }
              })();

              if (!ultravoxResponse.ok) {
                sendJson(res, 500, {
                  error: ultravoxData?.message || ultravoxData?.error || "Failed to create demo call",
                  stage,
                  details: ultravoxData?.details || ultravoxData || ultravoxRaw,
                });
                return;
              }

              stage = "create-call-log";
              const logResponse = await fetch(`${supabaseUrl}/rest/v1/call_logs`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  apikey: supabaseServiceRoleKey,
                  Authorization: `Bearer ${supabaseServiceRoleKey}`,
                  Prefer: "return=representation",
                },
                body: JSON.stringify({
                  user_id: userId,
                  agent_id: agent.id,
                  direction: "demo",
                  caller_number: "browser-demo",
                  recipient_number: null,
                  ultravox_call_id: ultravoxData.callId || null,
                  started_at: new Date().toISOString(),
                  status: "initiated",
                }),
              });
              const logRows = await logResponse.json().catch(() => []);
              if (!logResponse.ok || !Array.isArray(logRows) || !logRows[0]?.id) {
                sendJson(res, 500, {
                  error: "Failed to create demo call log",
                  stage,
                  details: logRows,
                });
                return;
              }

              sendJson(res, 200, {
                success: true,
                joinUrl: ultravoxData.joinUrl,
                callId: ultravoxData.callId || null,
                logId: logRows[0].id,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.error("[local demo call] fatal error", error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/create-firebrand-demo-call", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const {
                userId,
                source,
                persona,
                role,
                industry,
                owner,
                voice,
                voiceLanguage,
                callType,
                turn,
                difficulty,
                description,
                tags,
                systemPrompt,
              } = await readJsonBody(req);
              const ultravoxApiKey = env.VITE_ULTRAVOX_API_KEY || env.ULTRAVOX_API_KEY;
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

              if (!userId || !persona) {
                sendJson(res, 400, { error: "userId and persona are required" });
                return;
              }
              if (!ultravoxApiKey) {
                sendJson(res, 500, { error: "Ultravox API key is not configured" });
                return;
              }
              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              const balance = await requireLocalPositiveBalance(supabaseUrl, supabaseServiceRoleKey, userId);
              const effectiveMaxDurationSeconds = resolveEffectiveMaxDurationSeconds(300, balance.available_seconds);

              const syntheticAgent = {
                id: null,
                name: String(persona),
                model: "fixie-ai/ultravox-v0.7",
                voice: String(voice || "Mark"),
                temperature: 0.7,
                first_speaker: String(turn || "").toLowerCase().includes("you start")
                  ? "FIRST_SPEAKER_USER"
                  : "FIRST_SPEAKER_AGENT",
                language_hint: String(voiceLanguage || "").toLowerCase().includes("spanish") ? "es" : "en",
                ultravox_agent_id: null,
              };

              const rawSystemPrompt = String(systemPrompt || "").trim();
              const baseSystemPrompt = rawSystemPrompt || [
                `${String(persona)} here.`,
                role ? `${String(role)}${industry ? ` in ${String(industry)}` : ""}.` : null,
                description ? String(description) : null,
              ].filter(Boolean).join(" ");
              const runtimeVoiceGuardrails = [
                "Speak naturally as the assigned persona and respond only with spoken dialogue.",
                "Do not narrate sound effects, stage directions, actions, gestures, or scene setup.",
                "Never say phrases like 'phone rings', 'pause', 'smiles', 'laughs', 'sighs', or describe non-verbal actions.",
                "Do not announce who is speaking or format responses like a script.",
                "If the prompt includes non-spoken cues or scene directions, treat them as context only and do not say them aloud.",
              ].join(" ");
              const composedSystemPrompt = `${baseSystemPrompt}\n\nRuntime rules: ${runtimeVoiceGuardrails}`.trim();

              const ultravoxBody = await buildUltravoxDemoCallBody(
                ultravoxApiKey,
                syntheticAgent,
                composedSystemPrompt,
                [],
                effectiveMaxDurationSeconds,
              );

              const ultravoxResponse = await fetch("https://api.ultravox.ai/api/calls", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-API-Key": ultravoxApiKey,
                },
                body: JSON.stringify(ultravoxBody),
              });
              const ultravoxRaw = await ultravoxResponse.text();
              const ultravoxData = (() => {
                if (!ultravoxRaw) return {};
                try {
                  return JSON.parse(ultravoxRaw);
                } catch {
                  return {};
                }
              })();

              if (!ultravoxResponse.ok) {
                sendJson(res, 500, {
                  error: ultravoxData?.message || ultravoxData?.error || "Failed to create training demo call",
                  details: ultravoxData?.details || ultravoxData || ultravoxRaw,
                });
                return;
              }

              const logResponse = await fetch(`${supabaseUrl}/rest/v1/call_logs`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  apikey: supabaseServiceRoleKey,
                  Authorization: `Bearer ${supabaseServiceRoleKey}`,
                  Prefer: "return=representation",
                },
                body: JSON.stringify({
                  user_id: userId,
                  agent_id: null,
                  direction: "demo",
                  caller_number: "training-browser-demo",
                  recipient_number: null,
                  ultravox_call_id: ultravoxData.callId || null,
                  started_at: new Date().toISOString(),
                  status: "initiated",
                  billing_source: String(source || "practice").toLowerCase() === "agent" ? "firebrand_agent" : "firebrand_practice",
                  summary: `${String(source || "practice").toLowerCase() === "agent" ? "Firebrand agent" : "Firebrand practice"}: ${String(persona)}`,
                }),
              });
              const logRows = await logResponse.json().catch(() => []);
              if (!logResponse.ok || !Array.isArray(logRows) || !logRows[0]?.id) {
                sendJson(res, 500, {
                  error: "Failed to create training demo call log",
                  details: logRows,
                });
                return;
              }

              sendJson(res, 200, {
                success: true,
                joinUrl: ultravoxData.joinUrl,
                callId: ultravoxData.callId || null,
                logId: logRows[0].id,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.error("[local firebrand demo call] fatal error", error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/finalize-demo-call", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const { logId, userId, status, endedAt, duration, transcript, ultravoxCallId } = await readJsonBody(req);
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

              if (!logId || !userId) {
                sendJson(res, 400, { error: "logId and userId are required" });
                return;
              }
              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              const existingCallLog = await fetchSingleRow(
                supabaseUrl,
                supabaseServiceRoleKey,
                "call_logs",
                `id=eq.${encodeURIComponent(logId)}&user_id=eq.${encodeURIComponent(userId)}&direction=eq.demo&select=id,started_at,ended_at,duration,billing_status`,
              );

              if (!existingCallLog?.id) {
                sendJson(res, 404, { error: "Demo call log not found" });
                return;
              }

              const endedAtIso = typeof endedAt === "string" && endedAt ? endedAt : new Date().toISOString();
              const parsedStartedAt = coerceIsoDate(existingCallLog.started_at);
              const parsedEndedAt = coerceIsoDate(endedAtIso);
              const requestedDuration = Math.max(0, Number(duration || 0));
              const computedDuration =
                parsedStartedAt && parsedEndedAt
                  ? Math.max(0, Math.round((parsedEndedAt.getTime() - parsedStartedAt.getTime()) / 1000))
                  : 0;
              const resolvedDuration = Math.max(
                requestedDuration,
                computedDuration,
                Math.max(0, Number(existingCallLog.duration || 0)),
              );

              const updatePayload: Record<string, unknown> = {
                status: status || "completed",
                ended_at: endedAtIso,
                duration: resolvedDuration,
                transcript: transcript || [],
              };
              if (ultravoxCallId) {
                updatePayload.ultravox_call_id = ultravoxCallId;
              }

              const response = await fetch(`${supabaseUrl}/rest/v1/call_logs?id=eq.${encodeURIComponent(logId)}&user_id=eq.${encodeURIComponent(userId)}&direction=eq.demo`, {
                method: "PATCH",
                headers: {
                  "Content-Type": "application/json",
                  apikey: supabaseServiceRoleKey,
                  Authorization: `Bearer ${supabaseServiceRoleKey}`,
                  Prefer: "return=minimal",
                },
                body: JSON.stringify(updatePayload),
              });

              if (!response.ok) {
                const errorText = await response.text();
                sendJson(res, 500, { error: `Failed to finalize demo call: ${errorText}` });
                return;
              }

              const deduction = await deductLocalCallMinutes(
                supabaseUrl,
                supabaseServiceRoleKey,
                userId,
                logId,
                resolvedDuration,
                "demo_deduction",
              );

              sendJson(res, 200, { success: true, deduction });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          const geminiLiveBridge = new WebSocketServer({ noServer: true });
          let geminiLiveBridgeAttached = false;

          geminiLiveBridge.on("connection", async (browserSocket, req) => {
            const requestUrl = new URL(req.url || GEMINI_LIVE_BRIDGE_PATH, `http://${req.headers.host || "localhost"}`);
            const agentId = String(requestUrl.searchParams.get("agentId") || "").trim();
            const userId = String(requestUrl.searchParams.get("userId") || "").trim();

            const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
            const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
            const geminiApiKey = env.GEMINI_API_KEY;

            if (!supabaseUrl || !supabaseServiceRoleKey || !geminiApiKey) {
              browserSocket.send(JSON.stringify({ type: "error", message: "Gemini live bridge is not configured." }));
              browserSocket.close();
              return;
            }

            if (!agentId || !userId) {
              browserSocket.send(JSON.stringify({ type: "error", message: "agentId and userId are required." }));
              browserSocket.close();
              return;
            }

            let upstreamReady = false;
            let closed = false;
            let demoWebhookEvent: (event: string, payload: Record<string, unknown>) => Promise<void> = async () => undefined;
            const bufferedFrames: string[] = [];

            const cleanup = (message?: string) => {
              if (closed) return;
              closed = true;
              const safeMessage = message ? String(message).slice(0, 120) : "Gemini Live socket closed.";
              void demoWebhookEvent("call.ended", { agent_id: agentId, user_id: userId, reason: safeMessage, channel: "demo" });
              if (message && browserSocket.readyState === WebSocket.OPEN) {
                browserSocket.send(JSON.stringify({ type: "error", message: safeMessage }));
              }
              try {
                if (browserSocket.readyState === WebSocket.OPEN) browserSocket.close(1011, safeMessage);
                else browserSocket.close();
              } catch {}
              try { upstream.close(); } catch {}
            };

            const agent = await fetchSingleRow(
              supabaseUrl,
              supabaseServiceRoleKey,
              "agents",
              `id=eq.${encodeURIComponent(agentId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,name,system_prompt,model,voice,temperature,language_hint,first_speaker`,
            ).catch(() => null);

            if (!agent) {
              browserSocket.send(JSON.stringify({ type: "error", message: "Selected Gemini agent was not found." }));
              browserSocket.close();
              return;
            }

            const headers: Record<string, string> = { apikey: supabaseServiceRoleKey, Authorization: `Bearer ${supabaseServiceRoleKey}` };
            const [toolsRes, kbRes, apptRes, webhookRes] = await Promise.all([
              fetch(`${supabaseUrl}/rest/v1/agent_tools?agent_id=eq.${encodeURIComponent(agentId)}&is_active=eq.true&select=*`, { headers }),
              fetch(`${supabaseUrl}/rest/v1/knowledge_base_items?agent_id=eq.${encodeURIComponent(agentId)}&select=title,content,website_url`, { headers }),
              fetch(`${supabaseUrl}/rest/v1/appointment_tools?agent_id=eq.${encodeURIComponent(agentId)}&is_active=eq.true&select=*,calendar_integrations(*)`, { headers }),
              fetch(`${supabaseUrl}/rest/v1/webhooks?agent_id=eq.${encodeURIComponent(agentId)}&is_active=eq.true&select=*`, { headers }),
            ]);

            const agentTools = toolsRes.ok ? await toolsRes.json().catch(() => []) : [];
            const kbItems = kbRes.ok ? await kbRes.json().catch(() => []) : [];
            const appointmentTools = apptRes.ok ? await apptRes.json().catch(() => []) : [];
            const webhooks = webhookRes.ok ? await webhookRes.json().catch(() => []) : [];

            demoWebhookEvent = async (event, payload) => {
              if (!Array.isArray(webhooks) || webhooks.length === 0) return;
              await Promise.allSettled(webhooks.map(async (webhook: any) => {
                if (!webhook?.is_active || (Array.isArray(webhook.events) && !webhook.events.includes(event))) return;
                const webhookHeaders: Record<string, string> = { "Content-Type": "application/json" };
                if (webhook.secret) webhookHeaders["X-Webhook-Secret"] = String(webhook.secret);
                await fetch(String(webhook.url), {
                  method: "POST",
                  headers: webhookHeaders,
                  body: JSON.stringify({ event, timestamp: new Date().toISOString(), ...payload }),
                });
              }));
            };

            const model = resolveGeminiLiveModel(agent.model);
            const voice = resolveGeminiLiveVoice(agent.voice);
            const activeAppointmentTools = Array.isArray(appointmentTools)
              ? appointmentTools.filter((appointmentTool: any) => appointmentTool?.calendar_integrations?.is_active !== false)
              : [];
            console.log(`[gemini-live] agent=${agentId} savedModel=${agent.model || ""} liveModel=${model} voice=${voice} tools=${Array.isArray(agentTools) ? agentTools.length : 0} appt=${activeAppointmentTools.length} kb=${Array.isArray(kbItems) ? kbItems.length : 0}`);
            const temperature = Number(agent.temperature ?? 0.7);
            let systemPrompt = String(agent.system_prompt || "You are a helpful AI voice assistant. Respond naturally and keep replies concise.").trim();
            if (Array.isArray(kbItems) && kbItems.length > 0) {
              systemPrompt += `

--- KNOWLEDGE BASE ---`;
              for (const item of kbItems) {
                if (item?.content) systemPrompt += `
## ${item.title || "Knowledge"}
${item.content}`;
                else if (item?.website_url) systemPrompt += `
## ${item.title || "Knowledge"}
Refer to: ${item.website_url}`;
              }
            }
            if (activeAppointmentTools.length > 0) {
              for (const appointmentTool of activeAppointmentTools) {
                const hours = Object.entries((appointmentTool.business_hours || {}) as Record<string, any>)
                  .filter(([, value]) => Boolean((value as any)?.enabled))
                  .map(([day, value]) => `${day}: ${(value as any).start}-${(value as any).end}`)
                  .join(", ");
                const appointmentTypes = Array.isArray(appointmentTool.appointment_types)
                  ? appointmentTool.appointment_types.map((type: any) => `${type.name} (${type.duration}min)`).join(", ")
                  : "";
                systemPrompt += `

--- APPOINTMENT TOOL: ${appointmentTool.name || "Appointment"} ---
Provider: ${appointmentTool.provider || "calendar"}
Business Hours: ${hours || "not configured"}
Appointment Types: ${appointmentTypes || "not configured"}`;
              }
            }
            const bridgePrompt = `${systemPrompt}

Keep replies short and conversational for a live voice call. Wait for the user to speak first and then respond naturally. Use tools when needed, but do not mention internal tool names.`;
            const customToolMap = new Map<string, any>();
            if (Array.isArray(agentTools)) {
              for (const tool of agentTools) {
                if (tool?.name) customToolMap.set(String(tool.name), tool);
              }
            }
            const buildToolDeclarations = () => {
              const declarations: any[] = [];
              if (activeAppointmentTools.length > 0) {
                declarations.push({
                  name: "check_calendar_availability",
                  description: "Check available appointment time slots for a given date.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      date: { type: "STRING", description: "Date in YYYY-MM-DD format." },
                      duration_minutes: { type: "NUMBER", description: "Duration in minutes. Default 30." },
                    },
                    required: ["date"],
                  },
                });
                declarations.push({
                  name: "book_appointment",
                  description: "Book an appointment at a specific date and time.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      start_time: { type: "STRING", description: "Start time in ISO 8601 format." },
                      end_time: { type: "STRING", description: "End time in ISO 8601 format." },
                      attendee_name: { type: "STRING", description: "Name of the person booking." },
                      attendee_email: { type: "STRING", description: "Email if provided." },
                      attendee_phone: { type: "STRING", description: "Phone number if provided." },
                      notes: { type: "STRING", description: "Additional notes." },
                    },
                    required: ["start_time", "attendee_name"],
                  },
                });
              }
              for (const tool of customToolMap.values()) {
                const properties: Record<string, any> = {};
                const required: string[] = [];
                if (Array.isArray(tool.parameters)) {
                  for (const param of tool.parameters) {
                    if (param.paramType === "automatic") continue;
                    const schema = param.schema || {};
                    properties[param.name] = {
                      type: String(schema.type || param.type || "string").toUpperCase(),
                      description: schema.description || param.description || "",
                    };
                    if (param.required) required.push(param.name);
                  }
                }
                declarations.push({
                  name: tool.name,
                  description: tool.description || `Run ${tool.name}`,
                  parameters: { type: "OBJECT", properties, required },
                });
              }
              return declarations;
            };
            const executeCustomTool = async (tool: any, args: Record<string, any>) => {
              let toolUrl = String(tool.http_url || "");
              const mergedArgs: Record<string, any> = { ...args };
              if (Array.isArray(tool.parameters)) {
                for (const param of tool.parameters) {
                  if (param.paramType !== "automatic") continue;
                  if (param.knownValue === "call.id") mergedArgs[param.name] = `demo-${agentId}-${Date.now()}`;
                  if (param.knownValue === "agent.id") mergedArgs[param.name] = agentId;
                  if (param.knownValue === "user.id") mergedArgs[param.name] = userId;
                }
              }
              for (const [key, value] of Object.entries(mergedArgs)) {
                toolUrl = toolUrl.replace(`{{${key}}}`, encodeURIComponent(String(value)));
              }
              let body: string | undefined;
              if (String(tool.http_method || "GET").toUpperCase() !== "GET") {
                const bodyObj: Record<string, any> = { ...(tool.http_body_template || {}) };
                delete bodyObj.__agentEndBehavior;
                delete bodyObj.__staticResponse;
                if (Array.isArray(tool.parameters)) {
                  for (const param of tool.parameters) {
                    if ((param.location === "body" || !param.location) && mergedArgs[param.name] !== undefined) {
                      bodyObj[param.name] = mergedArgs[param.name];
                    }
                  }
                }
                for (const [key, value] of Object.entries(mergedArgs)) {
                  if (!(key in bodyObj)) bodyObj[key] = value;
                }
                body = JSON.stringify(bodyObj);
              }
              const fetchHeaders: Record<string, string> = { "Content-Type": "application/json", ...(tool.http_headers || {}) };
              if (Array.isArray(tool.parameters)) {
                for (const param of tool.parameters) {
                  if (param.paramType === "automatic" && param.location === "header" && mergedArgs[param.name]) {
                    fetchHeaders[param.name] = String(mergedArgs[param.name]);
                  }
                }
              }
              const response = await fetch(toolUrl, {
                method: String(tool.http_method || "GET").toUpperCase(),
                headers: fetchHeaders,
                body: String(tool.http_method || "GET").toUpperCase() !== "GET" ? body : undefined,
              });
              return await response.json().catch(() => ({ status: response.status, statusText: response.statusText }));
            };
            const executeDemoTool = async (functionName: string, args: Record<string, any>) => {
              if (functionName === "check_calendar_availability") {
                const appointmentTool = activeAppointmentTools[0] || null;
                const calendar = appointmentTool?.calendar_integrations;
                if (!calendar?.id) return { error: "No calendar integration configured" };
                const response = await fetch(`${supabaseUrl}/functions/v1/check-calendar-availability`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", apikey: supabaseServiceRoleKey, Authorization: `Bearer ${supabaseServiceRoleKey}`, "x-local-user-id": userId },
                  body: JSON.stringify({
                    provider: calendar.provider,
                    integration_id: calendar.id,
                    date: args.date,
                    duration_minutes: args.duration_minutes || 30,
                  }),
                });
                return await response.json().catch(() => ({ status: response.status, statusText: response.statusText }));
              }
              if (functionName === "book_appointment") {
                const appointmentTool = activeAppointmentTools[0] || null;
                const calendar = appointmentTool?.calendar_integrations;
                if (!calendar?.id) return { error: "No calendar integration configured" };
                const response = await fetch(`${supabaseUrl}/functions/v1/book-calendar-appointment`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", apikey: supabaseServiceRoleKey, Authorization: `Bearer ${supabaseServiceRoleKey}`, "x-local-user-id": userId },
                  body: JSON.stringify({
                    provider: appointmentTool.provider || calendar.provider,
                    integration_id: calendar.id,
                    start_time: args.start_time,
                    end_time: args.end_time,
                    attendee_name: args.attendee_name,
                    attendee_email: args.attendee_email,
                    attendee_phone: args.attendee_phone,
                    notes: args.notes,
                  }),
                });
                return await response.json().catch(() => ({ status: response.status, statusText: response.statusText }));
              }
              const customTool = customToolMap.get(functionName);
              if (customTool) return await executeCustomTool(customTool, args);
              return { error: `Unknown tool: ${functionName}` };
            };
            const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(geminiApiKey)}`;
            const upstream = new WebSocket(geminiUrl);

            upstream.on("open", () => {
              const setup = {
                setup: {
                  model: `models/${model}`,
                  systemInstruction: {
                    parts: [{ text: bridgePrompt }],
                  },
                  generationConfig: {
                    responseModalities: ["AUDIO"],
                    temperature,
                    speechConfig: {
                      voiceConfig: {
                        prebuiltVoiceConfig: {
                          voiceName: voice,
                        },
                      },
                    },
                  },
                  realtimeInputConfig: {
                    automaticActivityDetection: {
                      disabled: false,
                    },
                  },
                  inputAudioTranscription: {},
                  outputAudioTranscription: {},
                } as Record<string, unknown>,
              };
              const functionDeclarations = buildToolDeclarations();
              if (functionDeclarations.length > 0) {
                (setup.setup as Record<string, unknown>).tools = [{ functionDeclarations }];
                console.log(`[gemini-live] registered ${functionDeclarations.length} demo tools`);
              }
              upstream.send(JSON.stringify(setup));
            });

            upstream.on("message", async (data, isBinary) => {
              try {
                const raw = isBinary ? Buffer.from(data).toString("utf8") : String(data);
                const message = JSON.parse(raw);

                if (message.error) {
                  cleanup(message.error.message || "Gemini Live error.");
                  return;
                }

                if (message.setupComplete || message.sessionUpdated || message.sessionResumptionUpdate) {
                  upstreamReady = true;
                  void demoWebhookEvent("call.started", { agent_id: agentId, user_id: userId, channel: "demo" });
                  if (browserSocket.readyState === WebSocket.OPEN) {
                    browserSocket.send(JSON.stringify({ type: "ready" }));
                  }
                  while (bufferedFrames.length && upstream.readyState === WebSocket.OPEN) {
                    upstream.send(bufferedFrames.shift());
                  }
                  return;
                }

                const toolCall = message.toolCall;
                if (toolCall?.functionCalls && Array.isArray(toolCall.functionCalls)) {
                  const functionResponses = [];
                  for (const functionCall of toolCall.functionCalls) {
                    const result = await executeDemoTool(String(functionCall.name), functionCall.args || {});
                    functionResponses.push({
                      id: functionCall.id,
                      name: functionCall.name,
                      response: { result },
                    });
                  }
                  if (upstream.readyState === WebSocket.OPEN) {
                    upstream.send(JSON.stringify({ toolResponse: { functionResponses } }));
                  }
                  return;
                }

                const serverContent = message.serverContent || {};
                const inputText = serverContent.inputTranscription?.text || serverContent.input_transcription?.text || serverContent.inputTranscriptionResult?.text;
                if (inputText && browserSocket.readyState === WebSocket.OPEN) {
                  browserSocket.send(JSON.stringify({ type: "input_transcript", text: String(inputText), isFinal: true }));
                }

                const outputText = serverContent.outputTranscription?.text || serverContent.output_transcription?.text || serverContent.outputTranscriptionResult?.text;
                if (outputText && browserSocket.readyState === WebSocket.OPEN) {
                  browserSocket.send(JSON.stringify({ type: "output_transcript", text: String(outputText), isFinal: false }));
                }

                const parts = serverContent.modelTurn?.parts;
                if (Array.isArray(parts) && browserSocket.readyState === WebSocket.OPEN) {
                  for (const part of parts) {
                    if (part?.inlineData?.data && String(part.inlineData.mimeType || "").includes("audio/pcm")) {
                      browserSocket.send(JSON.stringify({
                        type: "audio",
                        data: String(part.inlineData.data),
                        mimeType: String(part.inlineData.mimeType || "audio/pcm;rate=24000"),
                      }));
                    }
                  }
                }

                if (serverContent.turnComplete && browserSocket.readyState === WebSocket.OPEN) {
                  browserSocket.send(JSON.stringify({ type: "turn_complete" }));
                }
              } catch (error) {
                cleanup(error instanceof Error ? error.message : String(error));
              }
            });

            upstream.on("close", (code, reasonBuffer) => {
              const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString("utf8") : String(reasonBuffer || "");
              const message = reason || `Gemini Live socket closed before setup completed (code=${code}).`;
              console.warn(`[gemini-live] upstream closed code=${code} reason=${reason || "<empty>"}`);
              cleanup(message);
            });

            upstream.on("error", (error) => {
              cleanup(error instanceof Error ? error.message : String(error));
            });

            browserSocket.on("message", (raw) => {
              try {
                const payload = JSON.parse(String(raw));
                if (payload?.type !== "audio" || !payload.data) return;

                const frame = JSON.stringify({
                  realtimeInput: {
                    mediaChunks: [{
                      mimeType: String(payload.mimeType || "audio/pcm;rate=16000"),
                      data: String(payload.data),
                    }],
                  },
                });

                if (!upstreamReady || upstream.readyState !== WebSocket.OPEN) {
                  bufferedFrames.push(frame);
                  return;
                }

                upstream.send(frame);
              } catch (error) {
                cleanup(error instanceof Error ? error.message : String(error));
              }
            });

            browserSocket.on("close", () => cleanup());
            browserSocket.on("error", () => cleanup());
          });

          if (server.httpServer && !geminiLiveBridgeAttached) {
            geminiLiveBridgeAttached = true;
            server.httpServer.on("upgrade", (req, socket, head) => {
              const requestUrl = new URL(req.url || GEMINI_LIVE_BRIDGE_PATH, `http://${req.headers.host || "localhost"}`);
              if (requestUrl.pathname !== GEMINI_LIVE_BRIDGE_PATH) {
                return;
              }

              geminiLiveBridge.handleUpgrade(req, socket, head, (ws) => {
                geminiLiveBridge.emit("connection", ws, req);
              });
            });
          }

          server.middlewares.use("/api/local/demo-provider-turn", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const { provider, agent_id, userId, query, state, messages } = await readJsonBody(req);

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!agent_id || !userId) {
                sendJson(res, 400, { error: "agent_id and userId are required" });
                return;
              }

              const response = await fetch(`${supabaseUrl}/functions/v1/demo-provider-turn`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  apikey: supabaseServiceRoleKey,
                  Authorization: `Bearer ${supabaseServiceRoleKey}`,
                  "x-demo-user-id": String(userId),
                },
                body: JSON.stringify({ provider, agent_id, query, state, messages }),
              });

              const data = await response.json().catch(() => ({}));
              sendJson(res, response.status, data);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/sms-campaign-data", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const projectId = String(env.VITE_SUPABASE_PROJECT_ID || "").trim();
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();
              const userEmail = String(body?.userEmail || "").trim();
              const action = String(body?.action || "").trim();

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!userId && !userEmail) {
                sendJson(res, 400, { error: "userId or userEmail is required" });
                return;
              }

              const headers = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };

              if (action === "upsert-template") {
                const templateId = String(body?.templateId || "").trim();
                const name = String(body?.name || "").trim();
                const category = String(body?.category || "").trim();
                const message = String(body?.message || "").trim();
                const linkedTags = Array.isArray(body?.linkedTags)
                  ? body.linkedTags.filter((value: unknown): value is string => typeof value === "string")
                  : [];

                const relatedUserIds = await resolveRelatedUserIds(
                  supabaseUrl,
                  supabaseServiceRoleKey,
                  userId,
                  userEmail,
                );
                const userIdList = relatedUserIds.map((id) => `"${id}"`).join(",");

                if (!name || !category || !message) {
                  sendJson(res, 400, { error: "name, category, and message are required" });
                  return;
                }

                if (templateId) {
                  const existingResponse = await fetch(
                    `${supabaseUrl}/rest/v1/sms_templates?select=id&limit=1&id=eq.${encodeURIComponent(templateId)}&user_id=in.(${userIdList})`,
                    { headers },
                  );
                  const existingPayload = await existingResponse.json().catch(() => []);
                  if (!existingResponse.ok) {
                    sendJson(res, 500, { error: "Failed to load SMS template", details: existingPayload });
                    return;
                  }
                  const existing = Array.isArray(existingPayload) ? existingPayload[0] || null : null;
                  if (!existing?.id) {
                    sendJson(res, 404, { error: "SMS template not found" });
                    return;
                  }

                  const updateResponse = await fetch(
                    `${supabaseUrl}/rest/v1/sms_templates?id=eq.${encodeURIComponent(existing.id)}`,
                    {
                      method: "PATCH",
                      headers: {
                        ...headers,
                        Prefer: "return=representation",
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({
                        user_id: userId,
                        user_email: userEmail,
                        name,
                        category,
                        message,
                        linked_tags: linkedTags,
                      }),
                    },
                  );
                  const updatePayload = await updateResponse.json().catch(() => []);
                  if (!updateResponse.ok) {
                    sendJson(res, 500, { error: "Failed to update SMS template", details: updatePayload });
                    return;
                  }
                  sendJson(res, 200, { template: Array.isArray(updatePayload) ? updatePayload[0] || null : updatePayload });
                  return;
                }

                const insertResponse = await fetch(`${supabaseUrl}/rest/v1/sms_templates`, {
                  method: "POST",
                  headers: {
                    ...headers,
                    Prefer: "return=representation",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    user_id: userId,
                    user_email: userEmail,
                    name,
                    category,
                    message,
                    linked_tags: linkedTags,
                  }),
                });
                const insertPayload = await insertResponse.json().catch(() => []);
                if (!insertResponse.ok) {
                  sendJson(res, 500, { error: "Failed to create SMS template", details: insertPayload });
                  return;
                }
                sendJson(res, 200, { template: Array.isArray(insertPayload) ? insertPayload[0] || null : insertPayload });
                return;
              }

              if (action === "run-campaign") {
                const campaignId = String(body?.campaign_id || "").trim();
                const templateId = String(body?.template_id || "").trim();
                const phoneConfigId = String(body?.phone_config_id || "").trim();
                const selectedContactIndexes = Array.isArray(body?.selected_contact_indexes)
                  ? body.selected_contact_indexes.filter((value: unknown): value is number => typeof value === "number")
                  : [];

                if (!userId) {
                  sendJson(res, 400, { error: "userId is required" });
                  return;
                }
                if (!campaignId || !templateId || !phoneConfigId) {
                  sendJson(res, 400, { error: "campaign_id, template_id, and phone_config_id are required" });
                  return;
                }

                const relatedUserIds = await resolveRelatedUserIds(
                  supabaseUrl,
                  supabaseServiceRoleKey,
                  userId,
                  userEmail,
                );
                const userIdList = relatedUserIds.map((id) => `"${id}"`).join(",");

                const [campaignResponse, templateResponse, phoneConfigResponse] = await Promise.all([
                  fetch(
                    `${supabaseUrl}/rest/v1/sms_campaigns?select=*&limit=1&id=eq.${encodeURIComponent(campaignId)}&user_id=in.(${userIdList})`,
                    { headers },
                  ),
                  fetch(
                    `${supabaseUrl}/rest/v1/sms_templates?select=*&limit=1&id=eq.${encodeURIComponent(templateId)}&user_id=in.(${userIdList})`,
                    { headers },
                  ),
                  fetch(
                    `${supabaseUrl}/rest/v1/phone_configs?select=*&limit=1&id=eq.${encodeURIComponent(phoneConfigId)}&user_id=in.(${userIdList})&is_active=eq.true`,
                    { headers },
                  ),
                ]);

                const [campaignPayload, templatePayload, phoneConfigPayload] = await Promise.all([
                  campaignResponse.json().catch(() => []),
                  templateResponse.json().catch(() => []),
                  phoneConfigResponse.json().catch(() => []),
                ]);

                if (!campaignResponse.ok) {
                  sendJson(res, 500, { error: "Failed to load SMS campaign", details: campaignPayload });
                  return;
                }
                if (!templateResponse.ok) {
                  sendJson(res, 500, { error: "Failed to load SMS template", details: templatePayload });
                  return;
                }
                if (!phoneConfigResponse.ok) {
                  sendJson(res, 500, { error: "Failed to load connected mobile number", details: phoneConfigPayload });
                  return;
                }

                const campaign = Array.isArray(campaignPayload) ? campaignPayload[0] || null : null;
                const template = Array.isArray(templatePayload) ? templatePayload[0] || null : null;
                const phoneConfig = Array.isArray(phoneConfigPayload) ? phoneConfigPayload[0] || null : null;

                if (!campaign) {
                  sendJson(res, 404, { error: "SMS campaign not found" });
                  return;
                }
                if (!template) {
                  sendJson(res, 404, { error: "SMS template not found" });
                  return;
                }
                if (!phoneConfig) {
                  sendJson(res, 404, { error: "Connected mobile number not found" });
                  return;
                }

                const normalizePhone = (raw: unknown) => {
                  const value = String(raw || "").trim();
                  if (!value) return "";
                  const digits = value.replace(/\D/g, "");
                  if (!digits) return "";
                  return value.startsWith("+") ? `+${digits}` : `+${digits}`;
                };

                const normalizeSender = (raw: unknown) => {
                  const value = String(raw || "").trim();
                  if (!value) return "";
                  if (/^[A-Za-z][A-Za-z0-9]{2,10}$/.test(value)) return value;
                  return normalizePhone(value);
                };

                const isInternationalRecipient = (phone: string) => !!phone && !phone.startsWith("+1");

                const getContactValue = (contact: Record<string, unknown>, token: string) => {
                  const normalized = token.replace(/[_\s]+/g, "").toLowerCase();
                  for (const [key, value] of Object.entries(contact)) {
                    const candidate = key.replace(/[_\s]+/g, "").toLowerCase();
                    if (candidate === normalized) return value;
                  }
                  return undefined;
                };

                const renderTemplate = (message: string, contact: Record<string, unknown>) =>
                  message.replace(/<<\s*([^>]+?)\s*>>/g, (_, token: string) => {
                    const value = getContactValue(contact, token);
                    if (value == null || typeof value === "object") return "";
                    return String(value);
                  }).trim();

                const getRecipientNumber = (contact: Record<string, unknown>) => {
                  const keys = ["phone_number", "phone number", "phone", "Phone", "mobile", "Mobile", "number"];
                  for (const key of keys) {
                    const value = getContactValue(contact, key);
                    const normalized = normalizePhone(value);
                    if (normalized) return normalized;
                  }
                  return "";
                };

                const sendViaTelnyx = async (config: any, to: string, text: string) => {
                  const apiKey = String(config.telnyx_api_key || "").trim();
                  if (!apiKey) throw new Error("Telnyx API key missing");

                  const recipient = normalizePhone(to);
                  const senderNumber = normalizePhone(config.phone_number);
                  const from = normalizeSender(senderNumber);
                  if (!from) throw new Error("Telnyx phone number missing");

                  const senderConfigResponse = await fetch(`https://api.telnyx.com/v2/messaging_phone_numbers/${encodeURIComponent(senderNumber)}`, {
                    method: "GET",
                    headers: {
                      Authorization: `Bearer ${apiKey}`,
                      "Content-Type": "application/json",
                    },
                  });
                  const senderConfigPayload = await senderConfigResponse.json().catch(() => ({}));
                  if (!senderConfigResponse.ok) {
                    throw new Error(
                      senderConfigPayload?.errors?.[0]?.detail ||
                      senderConfigPayload?.error ||
                      "Failed to verify Telnyx messaging phone number",
                    );
                  }

                  const smsFeatures =
                    senderConfigPayload?.data?.features?.sms ||
                    senderConfigPayload?.data?.record?.features?.sms ||
                    null;
                  if (isInternationalRecipient(recipient) && smsFeatures?.international_outbound === false) {
                    throw new Error("This Telnyx SMS number does not support international outbound messaging. Use an international-enabled Telnyx sender for this recipient.");
                  }

                  const smsPayload: Record<string, unknown> = { from, to: recipient, text };

                  const resp = await fetch("https://api.telnyx.com/v2/messages", {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${apiKey}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(smsPayload),
                  });
                  const respPayload = await resp.json().catch(() => ({}));
                  if (!resp.ok) {
                    throw new Error(respPayload?.errors?.[0]?.detail || respPayload?.error || "Telnyx SMS failed");
                  }
                  return respPayload?.data?.id || null;
                };

                const sendViaTwilio = async (config: any, to: string, text: string) => {
                  const sid = String(config.twilio_account_sid || "").trim();
                  const token = String(config.twilio_auth_token || "").trim();
                  if (!sid || !token) throw new Error("Twilio credentials missing");

                  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
                  const twilioBody = new URLSearchParams({
                    From: config.phone_number,
                    To: to,
                    Body: text,
                  });

                  const resp = await fetch(url, {
                    method: "POST",
                    headers: {
                      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
                      "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: twilioBody.toString(),
                  });
                  const respPayload = await resp.json().catch(() => ({}));
                  if (!resp.ok) {
                    throw new Error(respPayload?.message || respPayload?.error_message || "Twilio SMS failed");
                  }
                  return respPayload?.sid || null;
                };

                const allContacts = Array.isArray(campaign.extracted_contacts) ? campaign.extracted_contacts as Array<Record<string, unknown>> : [];
                const selectedContacts = selectedContactIndexes
                  .filter((index) => index >= 0 && index < allContacts.length)
                  .map((index) => allContacts[index]);

                if (!selectedContacts.length) {
                  sendJson(res, 400, { error: "No valid contacts selected" });
                  return;
                }

                const startedAt = new Date().toISOString();
                const outcomes: Array<Record<string, unknown>> = [];
                let sentCount = 0;
                let failedCount = 0;

                for (const [index, contact] of selectedContacts.entries()) {
                  const recipientNumber = getRecipientNumber(contact);
                  const renderedMessage = renderTemplate(String(template.message || ""), contact);

                  if (!recipientNumber || !renderedMessage) {
                    failedCount += 1;
                    outcomes.push({
                      contact_index: index,
                      recipient_number: recipientNumber || null,
                      rendered_message: renderedMessage,
                      status: "failed",
                      error: !recipientNumber ? "Recipient phone number missing" : "Rendered message is empty",
                      contact,
                    });
                    continue;
                  }

                  try {
                    const providerMessageId = phoneConfig.provider === "telnyx"
                      ? await sendViaTelnyx(phoneConfig, recipientNumber, renderedMessage)
                      : await sendViaTwilio(phoneConfig, recipientNumber, renderedMessage);

                    sentCount += 1;
                    outcomes.push({
                      contact_index: index,
                      recipient_number: recipientNumber,
                      rendered_message: renderedMessage,
                      status: "sent",
                      provider: phoneConfig.provider,
                      provider_message_id: providerMessageId,
                      contact,
                    });
                  } catch (error) {
                    failedCount += 1;
                    outcomes.push({
                      contact_index: index,
                      recipient_number: recipientNumber,
                      rendered_message: renderedMessage,
                      status: "failed",
                      error: error instanceof Error ? error.message : String(error),
                      provider: phoneConfig.provider,
                      contact,
                    });
                  }
                }

                const completedPayload = {
                  source_campaign_id: campaign.id,
                  user_id: userId,
                  user_email: userEmail || campaign.user_email,
                  name: campaign.name,
                  template_id: template.id,
                  template_name: template.name,
                  phone_config_id: phoneConfig.id,
                  sender_phone_number: phoneConfig.phone_number,
                  status: failedCount === selectedContacts.length ? "failed" : "completed",
                  total_contacts: selectedContacts.length,
                  sent_count: sentCount,
                  failed_count: failedCount,
                  selected_contacts: selectedContacts,
                  outcomes,
                  started_at: startedAt,
                  completed_at: new Date().toISOString(),
                };

                const insertCompletedResponse = await fetch(`${supabaseUrl}/rest/v1/sms_completed_campaigns`, {
                  method: "POST",
                  headers: {
                    ...headers,
                    Prefer: "return=representation",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(completedPayload),
                });
                const completedInsertPayload = await insertCompletedResponse.json().catch(() => []);
                if (!insertCompletedResponse.ok) {
                  sendJson(res, 500, { error: "Failed to save completed SMS campaign", details: completedInsertPayload });
                  return;
                }

                await fetch(`${supabaseUrl}/rest/v1/sms_campaigns?id=eq.${encodeURIComponent(campaign.id)}`, {
                  method: "PATCH",
                  headers: {
                    ...headers,
                    Prefer: "return=minimal",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ status: "completed", template_id: template.id }),
                });

                sendJson(res, 200, {
                  success: true,
                  completed_campaign: Array.isArray(completedInsertPayload) ? completedInsertPayload[0] || null : completedInsertPayload,
                  sent_count: sentCount,
                  failed_count: failedCount,
                });
                return;
              }

              const loadRows = async (table, selectClause) => {
                const clauses = [];
                if (userId) clauses.push(`user_id.eq.${encodeURIComponent(userId)}`);
                if (userEmail) clauses.push(`user_email.eq.${encodeURIComponent(userEmail)}`);
                const query = clauses.length ? `or=(${clauses.join(",")})&order=created_at.desc` : 'order=created_at.desc';
                const response = await fetch(`${supabaseUrl}/rest/v1/${table}?select=${encodeURIComponent(selectClause)}&${query}`, {
                  headers,
                });
                if (!response.ok) {
                  const data = await response.json().catch(() => ({}));
                  throw new Error(data?.message || data?.error || `Failed to load ${table}`);
                }
                return await response.json().catch(() => []);
              };

              const GMAIL_CHANNEL_MARKER = "__magicteams_channel";
              const GMAIL_TEMPLATE_FALLBACK_CATEGORY = "gmail:email";

              const isGmailFallbackCampaign = (campaign: any) => {
                const contacts = Array.isArray(campaign?.extracted_contacts) ? campaign.extracted_contacts : [];
                return contacts.some((contact: any) => {
                  const metadata = contact?.metadata;
                  return !!metadata && typeof metadata === "object" && metadata?.[GMAIL_CHANNEL_MARKER] === "gmail";
                });
              };

              const isGmailFallbackCompletedCampaign = (campaign: any) => {
                const contacts = Array.isArray(campaign?.selected_contacts) ? campaign.selected_contacts : [];
                const outcomes = Array.isArray(campaign?.outcomes) ? campaign.outcomes : [];

                return contacts.some((contact: any) => {
                  const metadata = contact?.metadata;
                  return !!metadata && typeof metadata === "object" && metadata?.[GMAIL_CHANNEL_MARKER] === "gmail";
                }) || outcomes.some((outcome: any) => outcome?.[GMAIL_CHANNEL_MARKER] === "gmail");
              };

              const [campaigns, completed, templates] = await Promise.all([
                loadRows("sms_campaigns", "*"),
                loadRows("sms_completed_campaigns", "*"),
                loadRows("sms_templates", "id,user_id,user_email,name,category,message,linked_tags,created_at"),
              ]);

              sendJson(res, 200, {
                campaigns: Array.isArray(campaigns) ? campaigns.filter((campaign) => !isGmailFallbackCampaign(campaign)) : [],
                completed: Array.isArray(completed) ? completed.filter((campaign) => !isGmailFallbackCompletedCampaign(campaign)) : [],
                templates: Array.isArray(templates) ? templates.filter((template: any) => template?.category !== GMAIL_TEMPLATE_FALLBACK_CATEGORY) : [],
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/dashboard-data", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();
              const userEmail = String(body?.userEmail || "").trim().toLowerCase();

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              if (!userId && !userEmail) {
                sendJson(res, 400, { error: "userId or userEmail is required" });
                return;
              }

              const userIds = await resolveRelatedUserIds(
                supabaseUrl,
                supabaseServiceRoleKey,
                userId,
                userEmail,
              );
              if (userIds.length === 0) {
                sendJson(res, 200, { callLogs: [], smsCompletedCampaigns: [] });
                return;
              }

              const headers = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };

              const callLogsQuery = `select=${encodeURIComponent("id, started_at, duration, billed_amount, direction, caller_number, recipient_number, agent_id, agents(name)")}&user_id=in.(${userIds.map((id) => `"${id}"`).join(",")})&order=started_at.desc`;
              const smsClauses = [
                ...userIds.map((id) => `user_id.eq.${encodeURIComponent(id)}`),
                ...(userEmail ? [`user_email.eq.${encodeURIComponent(userEmail)}`] : []),
              ];
              const smsQuery = `select=${encodeURIComponent("id, started_at, completed_at, total_contacts, sent_count, failed_count, outcomes")}&or=(${smsClauses.join(",")})&order=started_at.desc`;

              const [callLogsResponse, smsResponse] = await Promise.all([
                fetch(`${supabaseUrl}/rest/v1/call_logs?${callLogsQuery}`, { headers }),
                fetch(`${supabaseUrl}/rest/v1/sms_completed_campaigns?${smsQuery}`, { headers }),
              ]);

              const [callLogsData, smsData] = await Promise.all([
                callLogsResponse.json().catch(() => []),
                smsResponse.json().catch(() => []),
              ]);

              if (!callLogsResponse.ok) {
                throw new Error(callLogsData?.message || callLogsData?.error || "Failed to load call logs");
              }

              if (!smsResponse.ok) {
                throw new Error(smsData?.message || smsData?.error || "Failed to load SMS campaign history");
              }

              sendJson(res, 200, {
                callLogs: Array.isArray(callLogsData) ? callLogsData : [],
                smsCompletedCampaigns: Array.isArray(smsData) ? smsData : [],
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/voice-space-data", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();
              const userEmail = String(body?.userEmail || "").trim().toLowerCase();
              const agentId = String(body?.agentId || "").trim();

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              if (!userId && !userEmail) {
                sendJson(res, 400, { error: "userId or userEmail is required" });
                return;
              }

              const userIds = await resolveRelatedUserIds(
                supabaseUrl,
                supabaseServiceRoleKey,
                userId,
                userEmail,
              );

              if (userIds.length === 0) {
                sendJson(res, 200, {
                  relatedUserIds: [],
                  agents: [],
                  phoneConfigs: [],
                  calendarIntegrations: [],
                  callLogs: [],
                });
                return;
              }

              const headers = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };
              const userIdList = userIds.map((id) => `"${id}"`).join(",");

              const fetchOptionalRows = async (url: string, label: string) => {
                const response = await fetch(url, { headers });
                const payload = await response.json().catch(() => []);
                if (!response.ok) {
                  console.error("[local voice-space-data] optional fetch failed", { label, url, payload });
                  return [];
                }
                return Array.isArray(payload) ? payload : [];
              };

              const [agentsResponse, phoneConfigsResponse] = await Promise.all([
                fetch(`${supabaseUrl}/rest/v1/agents?select=*&user_id=in.(${userIdList})&order=created_at.desc`, { headers }),
                fetch(`${supabaseUrl}/rest/v1/phone_configs?select=*&user_id=in.(${userIdList})&order=created_at.desc`, { headers }),
              ]);
              const [agentsData, phoneConfigsData] = await Promise.all([
                agentsResponse.json().catch(() => []),
                phoneConfigsResponse.json().catch(() => []),
              ]);

              if (!agentsResponse.ok) throw new Error((agentsData as any)?.message || (agentsData as any)?.error || "Failed to load agents");
              if (!phoneConfigsResponse.ok) throw new Error((phoneConfigsData as any)?.message || (phoneConfigsData as any)?.error || "Failed to load phone configs");

              const [calendarData, callLogsData, forwardingData] = await Promise.all([
                fetchOptionalRows(
                  `${supabaseUrl}/rest/v1/calendar_integrations?select=id,user_id,provider,display_name,api_key,access_token,refresh_token,token_expires_at,calendar_id,is_active,config,created_at&user_id=in.(${userIdList})&order=created_at.asc`,
                  "calendarIntegrations",
                ),
                fetchOptionalRows(
                  `${supabaseUrl}/rest/v1/call_logs?select=${encodeURIComponent("*,agents(name)")}&user_id=in.(${userIdList})&order=started_at.desc`,
                  "callLogs",
                ),
                agentId
                  ? fetchOptionalRows(
                      `${supabaseUrl}/rest/v1/call_forwarding_numbers?select=id,phone_number,label,priority,agent_id,user_id&agent_id=eq.${encodeURIComponent(agentId)}&user_id=in.(${userIdList})&order=priority.asc`,
                      "forwardingNumbers",
                    )
                  : Promise.resolve([]),
              ]);

              sendJson(res, 200, {
                relatedUserIds: userIds,
                agents: Array.isArray(agentsData) ? agentsData : [],
                phoneConfigs: Array.isArray(phoneConfigsData) ? phoneConfigsData : [],
                calendarIntegrations: Array.isArray(calendarData) ? calendarData : [],
                callLogs: Array.isArray(callLogsData) ? callLogsData : [],
                forwardingNumbers: Array.isArray(forwardingData) ? forwardingData : [],
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use(
            "/api/local/minutes",
            sharedRoute(env, (body, id) => minutesHandle(body, id, { supabaseUrl: env.VITE_SUPABASE_URL || env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY })),
          );
          server.middlewares.use(
            "/api/local/calendar-integrations",
            sharedRoute(env, (body, id) => calendarHandle(body, id, { supabaseUrl: env.VITE_SUPABASE_URL || env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY })),
          );

          server.middlewares.use("/api/local/ghl-oauth", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const ghlClientId = env.GHL_CLIENT_ID || "";
              const ghlClientSecret = env.GHL_CLIENT_SECRET || "";
              const ghlScopes =
                env.GHL_SCOPES ||
                "calendars.readonly calendars/events.readonly calendars.write calendars/events.write";
              const body = await readJsonBody(req);
              const action = String(body?.action || "").trim();
              const userId = String(body?.userId || "").trim();
              const userEmail = String(body?.userEmail || "").trim().toLowerCase();

              if (!ghlClientId || !ghlClientSecret) {
                sendJson(res, 500, { error: "GoHighLevel OAuth is not configured locally. Add GHL_CLIENT_ID and GHL_CLIENT_SECRET to .env." });
                return;
              }

              if (action === "authorize_url") {
                const redirectUri = String(body?.redirect_uri || "").trim();
                const state = String(body?.state || "").trim();
                if (!redirectUri || !state) {
                  sendJson(res, 400, { error: "redirect_uri and state are required." });
                  return;
                }

                const authorizeUrl = new URL("https://marketplace.gohighlevel.com/oauth/chooselocation");
                authorizeUrl.searchParams.set("response_type", "code");
                authorizeUrl.searchParams.set("redirect_uri", redirectUri);
                authorizeUrl.searchParams.set("client_id", ghlClientId);
                authorizeUrl.searchParams.set("scope", ghlScopes);
                authorizeUrl.searchParams.set("state", state);
                authorizeUrl.searchParams.set("user_type", "Location");
                authorizeUrl.searchParams.set("loginWindowOpenMode", "self");
                sendJson(res, 200, { success: true, url: authorizeUrl.toString() });
                return;
              }

              if (action !== "exchange_code") {
                sendJson(res, 400, { error: "Unsupported action." });
                return;
              }

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!userId && !userEmail) {
                sendJson(res, 400, { error: "userId or userEmail is required" });
                return;
              }

              const code = String(body?.code || "").trim();
              const redirectUri = String(body?.redirect_uri || "").trim();
              if (!code || !redirectUri) {
                sendJson(res, 400, { error: "code and redirect_uri are required." });
                return;
              }

              const tokenResponse = await fetch("https://services.leadconnectorhq.com/oauth/token", {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                  Accept: "application/json",
                },
                body: new URLSearchParams({
                  client_id: ghlClientId,
                  client_secret: ghlClientSecret,
                  grant_type: "authorization_code",
                  code,
                  redirect_uri: redirectUri,
                  user_type: "Location",
                }),
              });
              const tokenPayload = await tokenResponse.json().catch(() => ({}));
              if (!tokenResponse.ok || !tokenPayload?.access_token) {
                sendJson(res, tokenResponse.ok ? 500 : tokenResponse.status, {
                  error: tokenPayload?.message || tokenPayload?.error || "Failed to exchange GoHighLevel authorization code.",
                  details: tokenPayload,
                });
                return;
              }

              const locationId =
                tokenPayload.locationId ||
                tokenPayload.location_id ||
                tokenPayload.companyId ||
                tokenPayload.company_id ||
                "";
              let calendars: any[] = [];
              if (locationId) {
                const calendarsResponse = await fetch(
                  `https://services.leadconnectorhq.com/calendars/?locationId=${encodeURIComponent(locationId)}`,
                  {
                    headers: {
                      Authorization: `Bearer ${tokenPayload.access_token}`,
                      Version: "2021-04-15",
                      Accept: "application/json",
                    },
                  },
                );
                const calendarsPayload = await calendarsResponse.json().catch(() => ({}));
                if (!calendarsResponse.ok) {
                  sendJson(res, calendarsResponse.status, {
                    error: calendarsPayload?.message || calendarsPayload?.error || "Failed to load GoHighLevel calendars.",
                    details: calendarsPayload,
                  });
                  return;
                }

                calendars = Array.isArray(calendarsPayload?.calendars)
                  ? calendarsPayload.calendars
                  : Array.isArray(calendarsPayload?.data?.calendars)
                    ? calendarsPayload.data.calendars
                    : Array.isArray(calendarsPayload?.data)
                      ? calendarsPayload.data
                      : [];
              }

              const headers = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };
              const relatedUserIds = await resolveRelatedUserIds(
                supabaseUrl,
                supabaseServiceRoleKey,
                userId,
                userEmail,
              );
              const userIdList = relatedUserIds.map((id) => `"${id}"`).join(",");
              const existingResponse = await fetch(
                `${supabaseUrl}/rest/v1/calendar_integrations?select=id,config&provider=eq.gohighlevel&user_id=in.(${userIdList})&limit=1`,
                { headers },
              );
              const existingPayload = await existingResponse.json().catch(() => []);
              if (!existingResponse.ok) {
                sendJson(res, 500, { error: "Failed to load existing GoHighLevel integration", details: existingPayload });
                return;
              }

              const existing = Array.isArray(existingPayload) ? existingPayload[0] || null : null;
              const primaryCalendar = calendars[0] || null;
              const expiresAt = tokenPayload.expires_in
                ? new Date(Date.now() + Number(tokenPayload.expires_in) * 1000).toISOString()
                : null;
              const integrationPayload = {
                user_id: userId,
                provider: "gohighlevel",
                display_name:
                  primaryCalendar?.name ||
                  primaryCalendar?.title ||
                  (locationId ? `GoHighLevel (${locationId})` : "GoHighLevel"),
                api_key: null,
                access_token: tokenPayload.access_token,
                refresh_token: tokenPayload.refresh_token || null,
                token_expires_at: expiresAt,
                calendar_id: primaryCalendar?.id || primaryCalendar?._id || null,
                is_active: true,
                config: {
                  ...((existing?.config && typeof existing.config === "object") ? existing.config : {}),
                  oauth_connected: true,
                  location_id: locationId || null,
                  company_id: tokenPayload.companyId || tokenPayload.company_id || null,
                  user_type: tokenPayload.userType || tokenPayload.user_type || "Location",
                  scope: tokenPayload.scope || ghlScopes,
                  calendars: calendars.slice(0, 25).map((calendar: any) => ({
                    id: calendar.id || calendar._id || "",
                    name: calendar.name || calendar.title || "Untitled calendar",
                  })),
                },
              };

              const requestUrl = existing?.id
                ? `${supabaseUrl}/rest/v1/calendar_integrations?id=eq.${encodeURIComponent(existing.id)}`
                : `${supabaseUrl}/rest/v1/calendar_integrations`;
              const requestMethod = existing?.id ? "PATCH" : "POST";
              const saveResponse = await fetch(requestUrl, {
                method: requestMethod,
                headers: {
                  ...headers,
                  Prefer: "return=representation",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(integrationPayload),
              });
              const savePayload = await saveResponse.json().catch(() => []);
              if (!saveResponse.ok) {
                sendJson(res, 500, { error: "Failed to save GoHighLevel integration", details: savePayload });
                return;
              }

              sendJson(res, 200, {
                success: true,
                display_name: integrationPayload.display_name,
                calendar_id: integrationPayload.calendar_id,
                location_id: locationId || null,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/platform-voices", async (req, res) => {
            if (req.method !== "GET") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const ultravoxApiKey = env.ULTRAVOX_API_KEY || env.VITE_ULTRAVOX_API_KEY;
              if (!ultravoxApiKey) {
                sendJson(res, 500, { error: "ULTRAVOX_API_KEY not configured" });
                return;
              }

              const headers = buildJsonHeaders({ "X-API-Key": ultravoxApiKey });
              const voices: unknown[] = [];
              let nextUrl: string | null = "https://api.ultravox.ai/api/voices?pageSize=100";

              while (nextUrl) {
                const response = await fetch(nextUrl, { headers });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                  console.error("[local platform-voices] upstream fetch failed", { payload, nextUrl });
                  sendJson(res, 200, { voices: [] });
                  return;
                }
                voices.push(...(Array.isArray(payload?.results) ? payload.results : []));
                nextUrl = typeof payload?.next === "string" && payload.next ? payload.next : null;
              }

              sendJson(res, 200, { voices });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.error("[local platform-voices] route failed", error);
              sendJson(res, 200, { voices: [], warning: message });
            }
          });

          server.middlewares.use("/api/local/platform-voice-preview", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const body = await readJsonBody(req);
              const provider = String(body?.provider || "ultravox").trim().toLowerCase();
              const voiceId = String(body?.voiceId || "").trim();
              const fallbackPreviewUrl = String(body?.previewUrl || "").trim();
              const providedApiKey = String(body?.apiKey || "").trim();

              if (provider === "ultravox") {
                const ultravoxApiKey = env.ULTRAVOX_API_KEY || env.VITE_ULTRAVOX_API_KEY;
                if (!ultravoxApiKey) {
                  sendJson(res, 500, { error: "ULTRAVOX_API_KEY not configured" });
                  return;
                }

                let previewUrl = fallbackPreviewUrl;
                if (!previewUrl && voiceId) {
                  const voiceResponse = await fetch(`https://api.ultravox.ai/api/voices/${encodeURIComponent(voiceId)}`, {
                    headers: buildJsonHeaders({ "X-API-Key": ultravoxApiKey }),
                  });
                  const voicePayload = await voiceResponse.json().catch(() => ({}));
                  if (!voiceResponse.ok) {
                    throw new Error(voicePayload?.error || "Failed to load voice preview metadata");
                  }
                  previewUrl = String(
                    voicePayload.previewUrl ||
                    voicePayload.previewMp3Url ||
                    voicePayload.previewWavUrl ||
                    voicePayload.audioPreviewUrl ||
                    voicePayload.sampleUrl ||
                    "",
                  ).trim();
                }

                if (!previewUrl) {
                  sendJson(res, 404, { error: "Preview unavailable for this voice" });
                  return;
                }

                const previewResponse = await fetch(previewUrl, {
                  headers: { "X-API-Key": ultravoxApiKey },
                });
                if (!previewResponse.ok) {
                  throw new Error(await previewResponse.text().catch(() => "Failed to fetch voice preview audio"));
                }
                res.statusCode = 200;
                res.setHeader("Content-Type", previewResponse.headers.get("content-type") || "audio/mpeg");
                res.setHeader("Cache-Control", "private, max-age=3600");
                res.end(Buffer.from(await previewResponse.arrayBuffer()));
                return;
              }

              if (provider === "gemini") {
                const geminiApiKey = providedApiKey || env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY;
                if (!geminiApiKey) {
                  sendJson(res, 500, { error: "GEMINI_API_KEY not configured" });
                  return;
                }

                const response = await fetch(
                  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${encodeURIComponent(geminiApiKey)}`,
                  {
                    method: "POST",
                    headers: buildJsonHeaders(),
                    body: JSON.stringify({
                      systemInstruction: {
                        parts: [{ text: "You are a text-to-speech engine. Return audio only. Never return text." }],
                      },
                      contents: [{ role: "user", parts: [{ text: "Say exactly: Hello, this is a preview of this Gemini voice from Vibe AI." }] }],
                      generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                          voiceConfig: {
                            prebuiltVoiceConfig: {
                              voiceName: voiceId || "Kore",
                            },
                          },
                        },
                      },
                    }),
                  },
                );
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                  throw new Error(payload?.error?.message || "Failed to generate Gemini preview");
                }

                const audioPart = Array.isArray(payload?.candidates?.[0]?.content?.parts)
                  ? payload.candidates[0].content.parts.find((part: any) => part?.inlineData?.data)
                  : null;
                const audioBase64 = audioPart?.inlineData?.data;
                if (!audioBase64) {
                  throw new Error("Gemini preview audio was empty");
                }

                const pcmBytes = Uint8Array.from(Buffer.from(String(audioBase64), "base64"));
                const wavBytes = pcmToWavBuffer(pcmBytes, 24000, 1, 16);
                res.statusCode = 200;
                res.setHeader("Content-Type", "audio/wav");
                res.setHeader("Cache-Control", "private, max-age=3600");
                res.end(wavBytes);
                return;
              }

              if (provider === "sarvam") {
                const sarvamApiKey = env.SARVAM_API_KEY;
                if (!sarvamApiKey) {
                  sendJson(res, 500, { error: "SARVAM_API_KEY not configured" });
                  return;
                }

                const response = await fetch("https://api.sarvam.ai/text-to-speech", {
                  method: "POST",
                  headers: buildJsonHeaders({ "api-subscription-key": sarvamApiKey }),
                  body: JSON.stringify({
                    text: "Hello, this is a preview of this Sarvam AI voice from Vibe AI.",
                    target_language_code: "en-IN",
                    speaker: voiceId || "shubh",
                    model: "bulbul:v3",
                    audio_format: "wav",
                    speech_sample_rate: 24000,
                  }),
                });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                  throw new Error(payload?.error?.message || payload?.message || "Failed to generate Sarvam preview");
                }

                const audioBase64 = payload?.audios?.[0];
                if (!audioBase64) {
                  throw new Error("Sarvam preview audio was empty");
                }

                res.statusCode = 200;
                res.setHeader("Content-Type", "audio/wav");
                res.setHeader("Cache-Control", "private, max-age=3600");
                res.end(Buffer.from(String(audioBase64), "base64"));
                return;
              }

              sendJson(res, 400, { error: "Unsupported provider" });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/sync-ultravox-agent", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabasePublishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
              const body = await readJsonBody(req);
              const agentId = String(body?.agentId || "").trim();
              const accessToken = String(body?.accessToken || "").trim();

              if (!supabaseUrl || !supabasePublishableKey) {
                sendJson(res, 500, { error: "Supabase client credentials are not configured" });
                return;
              }
              if (!agentId || !accessToken) {
                sendJson(res, 400, { error: "agentId and accessToken are required" });
                return;
              }

              const response = await fetch(`${supabaseUrl}/functions/v1/sync-ultravox-agent`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  apikey: supabasePublishableKey,
                  Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ agent_id: agentId }),
              });
              const payload = await response.json().catch(() => ({}));
              if (response.status === 404 || payload?.code === "NOT_FOUND") {
                sendJson(res, 200, {
                  skipped: true,
                  error: "Clone project is missing sync-ultravox-agent. The agent was saved locally, but Ultravox sync cannot run until that edge function is deployed on the clone project.",
                });
                return;
              }
              sendJson(res, response.ok ? 200 : response.status, payload);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/create-agent-tool", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabasePublishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
              const body = await readJsonBody(req);
              const accessToken = String(body?.accessToken || "").trim();
              const payload = body?.payload && typeof body.payload === "object" ? body.payload : null;

              if (!supabaseUrl || !supabasePublishableKey) {
                sendJson(res, 500, { error: "Supabase client credentials are not configured" });
                return;
              }
              if (!accessToken || !payload) {
                sendJson(res, 400, { error: "accessToken and payload are required" });
                return;
              }

              const response = await fetch(`${supabaseUrl}/functions/v1/create-agent-tool`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  apikey: supabasePublishableKey,
                  Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify(payload),
              });
              const responsePayload = await response.json().catch(() => ({}));
              sendJson(res, response.ok ? 200 : response.status, responsePayload);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/delete-ultravox-agent", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabasePublishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
              const body = await readJsonBody(req);
              const agentId = String(body?.agentId || "").trim();
              const accessToken = String(body?.accessToken || "").trim();

              if (!supabaseUrl || !supabasePublishableKey) {
                sendJson(res, 500, { error: "Supabase client credentials are not configured" });
                return;
              }
              if (!agentId || !accessToken) {
                sendJson(res, 400, { error: "agentId and accessToken are required" });
                return;
              }

              const response = await fetch(`${supabaseUrl}/functions/v1/delete-ultravox-agent`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  apikey: supabasePublishableKey,
                  Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ agent_id: agentId }),
              });
              const payload = await response.json().catch(() => ({}));
              if (response.status === 404 || payload?.code === "NOT_FOUND") {
                sendJson(res, 200, {
                  skipped: true,
                  error: "Clone project is missing delete-ultravox-agent. The local agent record can still be removed, but Ultravox cleanup cannot run until that edge function is deployed on the clone project.",
                });
                return;
              }
              sendJson(res, response.ok ? 200 : response.status, payload);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/process-knowledge", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabasePublishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
              const body = await readJsonBody(req);
              const knowledgeItemId = String(body?.knowledgeItemId || "").trim();
              const accessToken = String(body?.accessToken || "").trim();

              if (!supabaseUrl || !supabasePublishableKey) {
                sendJson(res, 500, { error: "Supabase client credentials are not configured" });
                return;
              }
              if (!knowledgeItemId || !accessToken) {
                sendJson(res, 400, { error: "knowledgeItemId and accessToken are required" });
                return;
              }

              const response = await fetch(`${supabaseUrl}/functions/v1/process-knowledge`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  apikey: supabasePublishableKey,
                  Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ knowledge_item_id: knowledgeItemId }),
              });
              const payload = await response.json().catch(() => ({}));
              if (response.status === 404 || payload?.code === "NOT_FOUND") {
                sendJson(res, 200, {
                  skipped: true,
                  error: "Clone project is missing process-knowledge. The knowledge item was saved locally, but background extraction cannot run until that edge function is deployed on the clone project.",
                });
                return;
              }
              sendJson(res, response.ok ? 200 : response.status, payload);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/voice-campaign-data", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();
              const userEmail = String(body?.userEmail || "").trim().toLowerCase();
              const campaignId = String(body?.campaignId || "").trim();

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              const userIds = await resolveRelatedUserIds(
                supabaseUrl,
                supabaseServiceRoleKey,
                userId,
                userEmail,
              );

              if (userIds.length === 0) {
                sendJson(res, 200, { campaigns: [], agents: [], phoneConfigs: [], campaignPhoneConfigs: [], contacts: [], callOutcomes: [], callLogs: [] });
                return;
              }

              const headers = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };
              const userIdList = userIds.map((id) => `"${id}"`).join(",");

              if (!campaignId) {
                const [campaignsResponse, agentsResponse, phoneConfigsResponse, campaignPhonesResponse, contactsResponse, outcomesResponse, callLogsResponse, dncResponse] = await Promise.all([
                  fetch(`${supabaseUrl}/rest/v1/campaigns?select=*&user_id=in.(${userIdList})&order=created_at.desc`, { headers }),
                  fetch(`${supabaseUrl}/rest/v1/agents?select=id,name&user_id=in.(${userIdList})`, { headers }),
                  fetch(`${supabaseUrl}/rest/v1/phone_configs?select=id,phone_number,friendly_name,provider,channel,user_id&user_id=in.(${userIdList})&is_active=eq.true`, { headers }),
                  fetch(`${supabaseUrl}/rest/v1/campaign_phone_configs?select=campaign_id,phone_config_id,sort_order&order=sort_order.asc`, { headers }),
                  fetch(`${supabaseUrl}/rest/v1/contacts?select=*&order=created_at.asc`, { headers }),
                  fetch(`${supabaseUrl}/rest/v1/call_outcomes?select=*&order=call_timestamp.desc`, { headers }),
                  fetch(`${supabaseUrl}/rest/v1/call_logs?select=id,recipient_number,caller_number,status,duration,started_at,ended_at,summary,transcript,ultravox_call_id,agent_id,direction,user_id&user_id=in.(${userIdList})&order=started_at.desc`, { headers }),
                  fetch(`${supabaseUrl}/rest/v1/do_not_call?select=phone_number`, { headers }),
                ]);

                const [campaigns, agents, phoneConfigs, campaignPhoneConfigs, contacts, callOutcomes, callLogs, doNotCall] = await Promise.all([
                  campaignsResponse.json().catch(() => []),
                  agentsResponse.json().catch(() => []),
                  phoneConfigsResponse.json().catch(() => []),
                  campaignPhonesResponse.json().catch(() => []),
                  contactsResponse.json().catch(() => []),
                  outcomesResponse.json().catch(() => []),
                  callLogsResponse.json().catch(() => []),
                  dncResponse.json().catch(() => []),
                ]);

                if (!campaignsResponse.ok) throw new Error(campaigns?.message || campaigns?.error || "Failed to load campaigns");
                if (!agentsResponse.ok) throw new Error(agents?.message || agents?.error || "Failed to load agents");
                if (!phoneConfigsResponse.ok) throw new Error(phoneConfigs?.message || phoneConfigs?.error || "Failed to load phone configs");
                if (!campaignPhonesResponse.ok) throw new Error(campaignPhoneConfigs?.message || campaignPhoneConfigs?.error || "Failed to load campaign phone configs");
                if (!contactsResponse.ok) throw new Error(contacts?.message || contacts?.error || "Failed to load contacts");
                if (!outcomesResponse.ok) throw new Error(callOutcomes?.message || callOutcomes?.error || "Failed to load call outcomes");
                if (!callLogsResponse.ok) throw new Error(callLogs?.message || callLogs?.error || "Failed to load call logs");
                if (!dncResponse.ok) throw new Error(doNotCall?.message || doNotCall?.error || "Failed to load DNC entries");

                sendJson(res, 200, {
                  campaigns: Array.isArray(campaigns) ? campaigns : [],
                  agents: Array.isArray(agents) ? agents : [],
                  phoneConfigs: Array.isArray(phoneConfigs) ? phoneConfigs : [],
                  campaignPhoneConfigs: Array.isArray(campaignPhoneConfigs) ? campaignPhoneConfigs : [],
                  contacts: Array.isArray(contacts) ? contacts : [],
                  callOutcomes: Array.isArray(callOutcomes) ? callOutcomes : [],
                  callLogs: Array.isArray(callLogs) ? callLogs : [],
                  doNotCall: Array.isArray(doNotCall) ? doNotCall : [],
                });
                return;
              }

              const [contactsResponse, outcomesResponse, callLogsResponse] = await Promise.all([
                fetch(`${supabaseUrl}/rest/v1/contacts?select=*&campaign_id=eq.${encodeURIComponent(campaignId)}&order=created_at.asc`, { headers }),
                fetch(`${supabaseUrl}/rest/v1/call_outcomes?select=*&campaign_id=eq.${encodeURIComponent(campaignId)}&order=created_at.desc`, { headers }),
                fetch(`${supabaseUrl}/rest/v1/call_logs?select=id,recipient_number,caller_number,status,duration,started_at,ended_at,summary,transcript,ultravox_call_id,agent_id,direction,user_id&user_id=in.(${userIdList})&direction=eq.outbound&order=started_at.desc`, { headers }),
              ]);

              const [contacts, callOutcomes, callLogs] = await Promise.all([
                contactsResponse.json().catch(() => []),
                outcomesResponse.json().catch(() => []),
                callLogsResponse.json().catch(() => []),
              ]);

              if (!contactsResponse.ok) throw new Error(contacts?.message || contacts?.error || "Failed to load campaign contacts");
              if (!outcomesResponse.ok) throw new Error(callOutcomes?.message || callOutcomes?.error || "Failed to load campaign outcomes");
              if (!callLogsResponse.ok) throw new Error(callLogs?.message || callLogs?.error || "Failed to load campaign call logs");

              sendJson(res, 200, {
                contacts: Array.isArray(contacts) ? contacts : [],
                callOutcomes: Array.isArray(callOutcomes) ? callOutcomes : [],
                callLogs: Array.isArray(callLogs) ? callLogs : [],
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/sync-campaign-phone-configs", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const campaignId = String(body?.campaignId || "").trim();
              const requestedUserId = String(body?.userId || "").trim();
              const phoneIds = Array.isArray(body?.phoneIds)
                ? body.phoneIds.map((value: unknown) => String(value || "").trim()).filter(Boolean)
                : [];

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              if (!campaignId) {
                sendJson(res, 400, { error: "campaignId is required" });
                return;
              }

              const headers = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };

              const campaignRowsResponse = await fetch(
                `${supabaseUrl}/rest/v1/campaigns?id=eq.${encodeURIComponent(campaignId)}&select=id,user_id&limit=1`,
                { headers },
              );
              const campaignRows = await campaignRowsResponse.json().catch(() => []);
              if (!campaignRowsResponse.ok) {
                throw new Error((campaignRows as any)?.message || (campaignRows as any)?.error || "Failed to load campaign owner");
              }

              const campaignOwnerId = Array.isArray(campaignRows) ? String(campaignRows[0]?.user_id || "").trim() : "";
              const effectiveUserId = requestedUserId || campaignOwnerId;
              if (!effectiveUserId) {
                sendJson(res, 400, { error: "Unable to resolve campaign owner" });
                return;
              }

              const deleteResponse = await fetch(
                `${supabaseUrl}/rest/v1/campaign_phone_configs?campaign_id=eq.${encodeURIComponent(campaignId)}`,
                {
                  method: "DELETE",
                  headers: {
                    ...headers,
                    Prefer: "return=minimal",
                  },
                },
              );
              if (!deleteResponse.ok) {
                const deletePayload = await deleteResponse.json().catch(() => ({}));
                throw new Error(deletePayload?.message || deletePayload?.error || "Failed to clear campaign phone configs");
              }

              if (phoneIds.length > 0) {
                const rows = phoneIds.map((phoneId, index) => ({
                  user_id: effectiveUserId,
                  campaign_id: campaignId,
                  phone_config_id: phoneId,
                  sort_order: index,
                }));

                const insertResponse = await fetch(
                  `${supabaseUrl}/rest/v1/campaign_phone_configs?on_conflict=campaign_id,phone_config_id`,
                  {
                    method: "POST",
                    headers: {
                      ...headers,
                      "Content-Type": "application/json",
                      Prefer: "resolution=merge-duplicates,return=minimal",
                    },
                    body: JSON.stringify(rows),
                  },
                );
                if (!insertResponse.ok) {
                  const insertPayload = await insertResponse.json().catch(() => ({}));
                  throw new Error(insertPayload?.message || insertPayload?.error || "Failed to save campaign phone configs");
                }
              }

              sendJson(res, 200, { success: true });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/repair-cloned-auth-user", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const email = String(body?.email || "").trim().toLowerCase();
              const password = String(body?.password || "");

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!email || !password) {
                sendJson(res, 400, { error: "Email and password are required" });
                return;
              }

              const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
                auth: { persistSession: false, autoRefreshToken: false },
              });
              const { data: listedUsers, error: listUsersError } = await adminClient.auth.admin.listUsers({
                page: 1,
                perPage: 1000,
              });
              if (listUsersError) {
                throw listUsersError;
              }
              const existingUser = (listedUsers.users || []).find(
                (authUser) => String(authUser.email || "").trim().toLowerCase() === email,
              );
              if (existingUser?.id) {
                sendJson(res, 200, { repaired: false, reason: "auth_user_exists" });
                return;
              }

              const headers = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };
              const profilesResponse = await fetch(
                `${supabaseUrl}/rest/v1/profiles?select=id,user_id,full_name&limit=1000`,
                { headers },
              );
              const profiles = await profilesResponse.json().catch(() => []);
              if (!profilesResponse.ok) {
                throw new Error((profiles as any)?.message || (profiles as any)?.error || "Failed to load cloned profiles");
              }

              const emailLocal = normalizeAuthMatchValue(email.split("@")[0]);
              const matchingProfile = (Array.isArray(profiles) ? profiles : []).find((profile: any) => {
                const normalizedName = normalizeAuthMatchValue(profile?.full_name);
                return normalizedName && normalizedName === emailLocal;
              });

              if (!matchingProfile?.user_id) {
                sendJson(res, 404, {
                  error: "This email is not present in cloned Auth, and no matching cloned profile was found to restore it.",
                });
                return;
              }

              const { data: createdUser, error: createUserError } = await adminClient.auth.admin.createUser({
                id: String(matchingProfile.user_id),
                email,
                password,
                email_confirm: true,
                user_metadata: {
                  full_name: matchingProfile.full_name || email,
                },
              });
              if (createUserError) {
                throw createUserError;
              }

              sendJson(res, 200, {
                repaired: true,
                userId: createdUser.user?.id || matchingProfile.user_id,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/run-sms-campaign", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!userId) {
                sendJson(res, 400, { error: "userId is required" });
                return;
              }

              const response = await fetch(`${supabaseUrl}/functions/v1/run-sms-campaign`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  apikey: supabaseServiceRoleKey,
                  Authorization: `Bearer ${supabaseServiceRoleKey}`,
                  "x-local-user-id": userId,
                },
                body: JSON.stringify({
                  campaign_id: body?.campaign_id,
                  template_id: body?.template_id,
                  phone_config_id: body?.phone_config_id,
                  selected_contact_indexes: body?.selected_contact_indexes,
                }),
              });

              const data = await response.json().catch(() => ({}));
              sendJson(res, response.status, data);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/whatsapp-campaigns", async (req, res) => {
            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
                auth: { persistSession: false, autoRefreshToken: false },
              });

              const canReadTable = async (tableName: string) => {
                const { error } = await admin.from(tableName).select("id", { head: true, count: "exact" }).limit(1);
                return !error;
              };

              if (req.method === "GET") {
                const requestUrl = new URL(req.url || "", "http://127.0.0.1:5173");
                const userId = String(requestUrl.searchParams.get("userId") || "").trim();
                if (!userId) {
                  sendJson(res, 400, { error: "userId is required" });
                  return;
                }

                const [hasWhatsappCampaigns, hasAudienceCampaigns] = await Promise.all([
                  canReadTable("whatsapp_campaigns"),
                  canReadTable("audience_campaigns"),
                ]);

                const campaignResults = await Promise.all([
                  hasWhatsappCampaigns
                    ? admin.from("whatsapp_campaigns").select("*").eq("user_id", userId).order("created_at", { ascending: false })
                    : Promise.resolve({ data: [], error: null }),
                  hasAudienceCampaigns
                    ? admin.from("audience_campaigns").select("*").eq("user_id", userId).order("created_at", { ascending: false })
                    : Promise.resolve({ data: [], error: null }),
                ]);

                const whatsappCampaignsResult = campaignResults[0];
                const audienceCampaignsResult = campaignResults[1];

                const firstError = whatsappCampaignsResult.error ?? audienceCampaignsResult.error;
                if (firstError && !whatsappCampaignsResult.data?.length && !audienceCampaignsResult.data?.length) {
                  sendJson(res, 500, { error: firstError.message });
                  return;
                }

                const mergedById = new Map<string, any>();
                for (const campaign of whatsappCampaignsResult.data ?? []) {
                  if (campaign?.id) {
                    mergedById.set(String(campaign.id), campaign);
                  }
                }
                for (const campaign of audienceCampaignsResult.data ?? []) {
                  if (campaign?.id && !mergedById.has(String(campaign.id))) {
                    mergedById.set(String(campaign.id), campaign);
                  }
                }

                const campaigns = Array.from(mergedById.values()).sort((left: any, right: any) => {
                  const leftTime = left?.created_at ? new Date(left.created_at).getTime() : 0;
                  const rightTime = right?.created_at ? new Date(right.created_at).getTime() : 0;
                  return rightTime - leftTime;
                });

                sendJson(res, 200, { campaigns });
                return;
              }

              if (req.method === "POST") {
                const body = await readJsonBody(req);
                const userId = String(body?.userId || "").trim();
                const name = String(body?.name || "").trim();
                const audienceId = String(body?.audience_id || "").trim();
                const templateId = String(body?.template_id || "").trim();

                if (!userId) {
                  sendJson(res, 400, { error: "userId is required" });
                  return;
                }
                if (!name) {
                  sendJson(res, 400, { error: "name is required" });
                  return;
                }
                if (!audienceId) {
                  sendJson(res, 400, { error: "audience_id is required" });
                  return;
                }
                if (!templateId) {
                  sendJson(res, 400, { error: "template_id is required" });
                  return;
                }

                const { data: audience, error: audienceError } = await admin
                  .from("audience_segments")
                  .select("id")
                  .eq("id", audienceId)
                  .eq("user_id", userId)
                  .maybeSingle();

                if (audienceError) {
                  sendJson(res, 500, { error: audienceError.message });
                  return;
                }
                if (!audience?.id) {
                  sendJson(res, 400, { error: "Audience not found" });
                  return;
                }

                const fullInsertPayload = {
                  user_id: userId,
                  name,
                  description: String(body?.description || "").trim() || null,
                  audience_id: audienceId,
                  template_id: templateId,
                  template_name: body?.template_name ?? null,
                  template_language: body?.template_language ?? "en_US",
                  template_structure: body?.template_structure ?? null,
                  status: body?.status ?? "draft",
                };

                let data: any = null;
                let error: any = null;

                {
                  const result = await admin
                    .from("audience_campaigns")
                    .insert(fullInsertPayload)
                    .select("*")
                    .single();
                  data = result.data;
                  error = result.error;
                }

                const missingColumnMessage = String(error?.message || "").toLowerCase();
                if (
                  error &&
                  (missingColumnMessage.includes("template_language") ||
                    missingColumnMessage.includes("template_structure") ||
                    missingColumnMessage.includes("template_name"))
                ) {
                  const fallbackResult = await admin
                    .from("audience_campaigns")
                    .insert({
                      user_id: userId,
                      name,
                      description: String(body?.description || "").trim() || null,
                      audience_id: audienceId,
                      template_id: templateId,
                      status: body?.status ?? "draft",
                    })
                    .select("*")
                    .single();
                  data = fallbackResult.data;
                  error = fallbackResult.error;
                }

                if (error) {
                  sendJson(res, 500, { error: error.message });
                  return;
                }

                sendJson(res, 200, { campaign: data });
                return;
              }

              if (req.method === "PATCH") {
                const body = await readJsonBody(req);
                const userId = String(body?.userId || "").trim();
                const campaignId = String(body?.campaignId || body?.id || "").trim();
                const audienceId = String(body?.audience_id || "").trim();
                const templateId = String(body?.template_id || "").trim();

                if (!userId) {
                  sendJson(res, 400, { error: "userId is required" });
                  return;
                }
                if (!campaignId) {
                  sendJson(res, 400, { error: "campaignId is required" });
                  return;
                }
                if (!audienceId) {
                  sendJson(res, 400, { error: "audience_id is required" });
                  return;
                }
                if (!templateId) {
                  sendJson(res, 400, { error: "template_id is required" });
                  return;
                }

                const updatePayload = {
                  audience_id: audienceId,
                  template_id: templateId,
                  template_name: body?.template_name ?? null,
                  template_language: body?.template_language ?? "en_US",
                  template_structure: body?.template_structure ?? null,
                  status: body?.status ?? "draft",
                };

                let data: any = null;
                let error: any = null;

                {
                  const result = await admin
                    .from("audience_campaigns")
                    .update(updatePayload)
                    .eq("id", campaignId)
                    .eq("user_id", userId)
                    .select("*")
                    .single();
                  data = result.data;
                  error = result.error;
                }

                const missingColumnMessage = String(error?.message || "").toLowerCase();
                if (
                  error &&
                  (missingColumnMessage.includes("template_language") ||
                    missingColumnMessage.includes("template_structure") ||
                    missingColumnMessage.includes("template_name"))
                ) {
                  const fallbackResult = await admin
                    .from("audience_campaigns")
                    .update({
                      audience_id: audienceId,
                      template_id: templateId,
                      status: body?.status ?? "draft",
                    })
                    .eq("id", campaignId)
                    .eq("user_id", userId)
                    .select("*")
                    .single();
                  data = fallbackResult.data;
                  error = fallbackResult.error;
                }

                if (error) {
                  sendJson(res, 500, { error: error.message });
                  return;
                }

                sendJson(res, 200, { campaign: data });
                return;
              }

              if (req.method === "PATCH") {
                const body = await readJsonBody(req);
                const userId = String(body?.userId || "").trim();
                const campaignId = String(body?.campaignId || body?.id || "").trim();
                const audienceId = String(body?.audience_id || "").trim();
                const templateId = String(body?.template_id || "").trim();

                if (!userId) {
                  sendJson(res, 400, { error: "userId is required" });
                  return;
                }
                if (!campaignId) {
                  sendJson(res, 400, { error: "campaignId is required" });
                  return;
                }
                if (!audienceId) {
                  sendJson(res, 400, { error: "audience_id is required" });
                  return;
                }
                if (!templateId) {
                  sendJson(res, 400, { error: "template_id is required" });
                  return;
                }

                const updatePayload = {
                  name: String(body?.name || "").trim(),
                  description: String(body?.description || "").trim() || null,
                  audience_id: audienceId,
                  template_id: templateId,
                  template_name: body?.template_name ?? null,
                  template_language: body?.template_language ?? "en_US",
                  template_structure: body?.template_structure ?? null,
                  status: body?.status ?? "draft",
                };

                let data: any = null;
                let error: any = null;

                {
                  const result = await admin
                    .from("audience_campaigns")
                    .update(updatePayload)
                    .eq("id", campaignId)
                    .eq("user_id", userId)
                    .select("*")
                    .single();
                  data = result.data;
                  error = result.error;
                }

                const missingColumnMessage = String(error?.message || "").toLowerCase();
                if (
                  error &&
                  (missingColumnMessage.includes("template_language") ||
                    missingColumnMessage.includes("template_structure") ||
                    missingColumnMessage.includes("template_name"))
                ) {
                  const fallbackResult = await admin
                    .from("audience_campaigns")
                    .update({
                      name: String(body?.name || "").trim(),
                      description: String(body?.description || "").trim() || null,
                      audience_id: audienceId,
                      template_id: templateId,
                      status: body?.status ?? "draft",
                    })
                    .eq("id", campaignId)
                    .eq("user_id", userId)
                    .select("*")
                    .single();
                  data = fallbackResult.data;
                  error = fallbackResult.error;
                }

                if (error) {
                  sendJson(res, 500, { error: error.message });
                  return;
                }

                sendJson(res, 200, { campaign: data });
                return;
              }

              if (req.method === "DELETE") {
                const body = await readJsonBody(req);
                const userId = String(body?.userId || "").trim();
                const campaignId = String(body?.campaignId || body?.id || "").trim();

                if (!userId) {
                  sendJson(res, 400, { error: "userId is required" });
                  return;
                }
                if (!campaignId) {
                  sendJson(res, 400, { error: "campaignId is required" });
                  return;
                }

                const { error } = await admin
                  .from("audience_campaigns")
                  .delete()
                  .eq("id", campaignId)
                  .eq("user_id", userId);

                if (error) {
                  sendJson(res, 500, { error: error.message });
                  return;
                }

                sendJson(res, 200, { success: true });
                return;
              }

              sendJson(res, 405, { error: "Method not allowed" });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/upload-whatsapp-template-image", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();
              const fileName = String(body?.fileName || "").trim() || `template-${Date.now()}.jpg`;
              const mimeType = String(body?.mimeType || "").trim() || "image/jpeg";
              const fileBase64 = String(body?.fileBase64 || "").trim();

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              if (!userId || !fileBase64) {
                sendJson(res, 400, { error: "userId and fileBase64 are required" });
                return;
              }

              if (!mimeType.startsWith("image/")) {
                sendJson(res, 400, { error: "Only image uploads are supported" });
                return;
              }

              const fileBuffer = decodeBase64FilePayload(fileBase64);
              if (!fileBuffer.byteLength) {
                sendJson(res, 400, { error: "Uploaded file payload is empty" });
                return;
              }

              if (fileBuffer.byteLength > 5 * 1024 * 1024) {
                sendJson(res, 400, { error: "Image size must be 5MB or smaller" });
                return;
              }

              const functionAvailable = await isCloneFunctionAvailable(supabaseUrl, "upload-whatsapp-template-image");
              if (functionAvailable) {
                const response = await fetch(`${supabaseUrl}/functions/v1/upload-whatsapp-template-image`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    apikey: supabaseServiceRoleKey,
                    Authorization: `Bearer ${supabaseServiceRoleKey}`,
                    "x-local-user-id": userId,
                  },
                  body: JSON.stringify({
                    fileName,
                    mimeType,
                    fileBase64,
                  }),
                });

                const data = await response.json().catch(() => ({}));
                sendJson(res, response.status, data);
                return;
              }

              const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
                auth: { persistSession: false, autoRefreshToken: false },
              });

              const [{ data: profile }, configResult] = await Promise.all([
                admin.from("profiles").select("user_id").or(`user_id.eq.${userId},id.eq.${userId}`).maybeSingle(),
                admin
                  .from("whatsapp_api_configs")
                  .select("meta_access_token, meta_app_id")
                  .eq("user_id", userId)
                  .maybeSingle(),
              ]);

              const resolvedUserId = String(profile?.user_id || userId).trim();

              let configData = configResult.data;
              if ((!configData?.meta_access_token || !configData?.meta_app_id) && resolvedUserId && resolvedUserId !== userId) {
                const fallbackConfigResult = await admin
                  .from("whatsapp_api_configs")
                  .select("meta_access_token, meta_app_id")
                  .eq("user_id", resolvedUserId)
                  .maybeSingle();
                if (fallbackConfigResult.data) {
                  configData = fallbackConfigResult.data;
                }
              }

              const accessToken = String(configData?.meta_access_token || "").trim();
              const appId = String(configData?.meta_app_id || "").trim();

              if (!accessToken || !appId) {
                sendJson(res, 400, { error: "Please configure your Meta access token and App ID before uploading carousel images." });
                return;
              }

              const handle = await createMetaTemplateHeaderHandle({
                accessToken,
                appId,
                fileName,
                mimeType,
                fileBuffer,
              });

              sendJson(res, 200, { success: true, handle });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { success: false, error: message });
            }
          });

          server.middlewares.use("/api/local/create-whatsapp-template", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();
              const requestedUserEmail = String(body?.userEmail || "").trim().toLowerCase();
              const structure = body?.structure && typeof body.structure === "object" ? body.structure : null;
              const name = String(structure?.name || body?.name || "").trim();
              const language = String(structure?.language || body?.language || "").trim();
              const category = String(structure?.category || body?.category || "").trim();
              const headerHandle = String(body?.headerHandle || "").trim();
              const mainBody = String(body?.mainBody || "").trim();
              const cards = Array.isArray(body?.cards) ? body.cards : [];
              const components = Array.isArray(structure?.components)
                ? structure.components
                : Array.isArray(body?.components)
                ? body.components
                : cards.length > 0
                  ? buildLocalWhatsappCarouselComponents(mainBody, cards)
                  : [];

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!userId) {
                sendJson(res, 400, { error: "userId is required" });
                return;
              }
              if (!name || !language || !category || components.length === 0) {
                sendJson(res, 400, { error: "Please provide userId, name, language, category, and components array" });
                return;
              }

              if (cards.length > 0) {
                if (!mainBody) {
                  sendJson(res, 400, { error: "Carousel templates require mainBody." });
                  return;
                }

                if (cards.length > 10) {
                  sendJson(res, 400, { error: "Carousel templates support a maximum of 10 cards." });
                  return;
                }

                for (const [index, card] of cards.entries()) {
                  const headerHandleValue = String(card?.headerHandle || "").trim();
                  const bodyTextValue = String(card?.bodyText || "").trim();
                  const buttonList = Array.isArray(card?.buttons) ? card.buttons : [];

                  if (!headerHandleValue || !bodyTextValue || buttonList.length === 0) {
                    sendJson(res, 400, {
                      error: `Carousel card ${index + 1} must include an uploaded image handle, bodyText, and at least one button.`,
                    });
                    return;
                  }

                  if (buttonList.length > 2) {
                    sendJson(res, 400, {
                      error: `Carousel card ${index + 1} supports a maximum of 2 buttons.`,
                    });
                    return;
                  }

                  if (buttonList.some((button) => !isValidLocalWhatsappCarouselButton(button))) {
                    sendJson(res, 400, {
                      error: `Carousel card ${index + 1} has an incomplete button. URL and phone buttons require a value, and quick replies must be 25 characters or fewer.`,
                    });
                    return;
                  }
                }
              }

              const functionAvailable = await isCloneFunctionAvailable(supabaseUrl, "create-whatsapp-template");
              if (functionAvailable) {
                const retryBaseName = normalizeLocalWhatsappTemplateName(name) || "carousel_template";
                let finalForwardedName = name;
                let forwardedBody = structure
                  ? { name, language, category, structure, components, mainBody, cards, headerHandle }
                  : { name, language, category, components, mainBody, cards, headerHandle };

                let response = await fetch(`${supabaseUrl}/functions/v1/create-whatsapp-template`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    apikey: supabaseServiceRoleKey,
                    Authorization: `Bearer ${supabaseServiceRoleKey}`,
                    "x-local-user-id": userId,
                  },
                  body: JSON.stringify(forwardedBody),
                });

                let data = await response.json().catch(() => ({}));
                if (!response.ok && shouldRetryCarouselNameConflict(data?.details || data, cards)) {
                  finalForwardedName = buildRetryTemplateName(retryBaseName);
                  const retryStructure = structure
                    ? {
                        ...structure,
                        name: finalForwardedName,
                      }
                    : null;
                  forwardedBody = retryStructure
                    ? {
                        ...forwardedBody,
                        name: finalForwardedName,
                        structure: retryStructure,
                      }
                    : {
                        ...forwardedBody,
                        name: finalForwardedName,
                      };
                  response = await fetch(`${supabaseUrl}/functions/v1/create-whatsapp-template`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      apikey: supabaseServiceRoleKey,
                      Authorization: `Bearer ${supabaseServiceRoleKey}`,
                      "x-local-user-id": userId,
                    },
                    body: JSON.stringify(forwardedBody),
                  });
                  data = await response.json().catch(() => ({}));
                  if (response.ok && data?.success !== false) {
                    data = {
                      ...data,
                      normalizedName: data?.normalizedName || finalForwardedName,
                      message: `Template submitted to Meta as ${data?.normalizedName || finalForwardedName} because ${retryBaseName} is still reserved by Meta while the old content is being deleted.`,
                    };
                  }
                }
                sendJson(res, response.status, data);
                return;
              }

              const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
                auth: { persistSession: false, autoRefreshToken: false },
              });

              const canReadTable = async (tableName: string) => {
                const { error } = await admin.from(tableName).select("id", { head: true, count: "exact" }).limit(1);
                return !error;
              };

              const normalizedName = normalizeLocalWhatsappTemplateName(name);
              if (!normalizedName) {
                sendJson(res, 400, { error: "Template name must contain letters or numbers after normalization." });
                return;
              }
              let finalNormalizedName = normalizedName;

              const [{ data: profile }, hasWhatsappApiConfigs, hasLegacyUserDetails, hasLegacyTemplates] =
                await Promise.all([
                  admin.from("profiles").select("user_id").or(`user_id.eq.${userId},id.eq.${userId}`).maybeSingle(),
                  canReadTable("whatsapp_api_configs"),
                  canReadTable("User_details"),
                  canReadTable("Templates"),
                ]);
              const hasWhatsappTemplates = supportsLocalWhatsappTable(projectId, "whatsapp_templates") && await canReadTable("whatsapp_templates");

              const resolvedUserId = String(profile?.user_id || userId).trim();
              const authUser = resolvedUserId ? await admin.auth.admin.getUserById(resolvedUserId) : { data: { user: null } };
              const userEmail = ((authUser.data.user?.email ?? requestedUserEmail) || "").trim().toLowerCase() || null;

              let metaAccessToken: string | null = null;
              let metaBusinessAccountId: string | null = null;

              if (hasWhatsappApiConfigs) {
                const { data: config } = await admin
                  .from("whatsapp_api_configs")
                  .select("meta_access_token, meta_business_account_id")
                  .eq("user_id", resolvedUserId)
                  .maybeSingle();

                if (config) {
                  metaAccessToken = config.meta_access_token;
                  metaBusinessAccountId = config.meta_business_account_id;
                }
              }

              if ((!metaAccessToken || !metaBusinessAccountId) && hasLegacyUserDetails && userEmail) {
                const { data: legacyConfig } = await admin
                  .from("User_details")
                  .select("meta_access_token, meta_business_account_id")
                  .eq("email", userEmail)
                  .maybeSingle();

                if (legacyConfig) {
                  metaAccessToken = legacyConfig.meta_access_token;
                  metaBusinessAccountId = legacyConfig.meta_business_account_id;
                }
              }

              if (!metaAccessToken || !metaBusinessAccountId) {
                sendJson(res, 400, { error: "Please configure your WhatsApp API credentials in Profile Settings." });
                return;
              }

              const requestComponents = components.map((component: Record<string, any>) => {
                const normalizedComponent: Record<string, unknown> = {
                  ...component,
                  type: String(component.type ?? "").trim().toUpperCase(),
                };

                if (normalizedComponent.type === "BUTTONS" && Array.isArray(component.buttons)) {
                  normalizedComponent.buttons = component.buttons.map((button: Record<string, any>) => {
                    const normalizedButton: Record<string, unknown> = {
                      type: String(button?.type ?? "").trim().toLowerCase(),
                      text: String(button?.text ?? "").trim(),
                    };

                    if (button?.url) normalizedButton.url = button.url;
                    if (button?.phone_number) normalizedButton.phone_number = button.phone_number;
                    return normalizedButton;
                  });
                }

                return normalizedComponent;
              });

              const effectiveCategory = cards.length > 0 ? "MARKETING" : category.toUpperCase();
              let metaRequestBody: Record<string, unknown> = {
                name: finalNormalizedName,
                language,
                category: effectiveCategory,
                parameter_format: "NAMED",
                components: requestComponents,
              };

              if (headerHandle) {
                const headerIndex = requestComponents.findIndex((component) => component.type === "HEADER");
                if (headerIndex !== -1) {
                  const existing = requestComponents[headerIndex];
                  requestComponents[headerIndex] = {
                    ...existing,
                    example: {
                      header_handle: [headerHandle],
                    },
                  };
                }
              }

              let metaResponse = await fetch(`https://graph.facebook.com/v22.0/${metaBusinessAccountId}/message_templates`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${metaAccessToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(metaRequestBody),
              });

              let responseData = await metaResponse.json().catch(() => ({}));
              let renamedFrom: string | null = null;
              if (!metaResponse.ok && shouldRetryCarouselNameConflict(responseData, cards)) {
                renamedFrom = finalNormalizedName;
                finalNormalizedName = buildRetryTemplateName(finalNormalizedName);
                metaRequestBody = {
                  ...metaRequestBody,
                  name: finalNormalizedName,
                };
                metaResponse = await fetch(`https://graph.facebook.com/v22.0/${metaBusinessAccountId}/message_templates`, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${metaAccessToken}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(metaRequestBody),
                });
                responseData = await metaResponse.json().catch(() => ({}));
              }

              if (!metaResponse.ok) {
                const detailedMessage =
                  responseData?.error?.error_user_msg ||
                  responseData?.error?.error_user_title ||
                  responseData?.error?.error_data?.details ||
                  responseData?.error?.message ||
                  "Failed to create template";
                sendJson(res, metaResponse.status, {
                  success: false,
                  error: "Meta API error",
                  message: detailedMessage,
                  details: responseData,
                });
                return;
              }

              const templateDetails = parseLocalWhatsappTemplateDetails(components);
              const persistedCategory = templateDetails.templateType === "carousel" ? "MARKETING" : category.toUpperCase();
              let dbError: { message?: string } | null = null;

              if (hasWhatsappTemplates) {
                const { error } = await admin.from("whatsapp_templates").insert({
                  user_id: resolvedUserId,
                  template_type: templateDetails.templateType,
                  name,
                  normalized_name: finalNormalizedName,
                  body: templateDetails.bodyText,
                  category: persistedCategory.toLowerCase(),
                  language,
                  footer_text: templateDetails.footerText,
                  button_types: templateDetails.buttonTypes,
                });
                dbError = error;
              } else if (hasLegacyTemplates) {
                if (!userEmail) {
                  sendJson(res, 400, { error: "Unable to resolve the signed-in email for legacy template storage." });
                  return;
                }
                const { error } = await admin.from("Templates").insert({
                  user_email: userEmail,
                  template_name: finalNormalizedName,
                  template_type: templateDetails.templateType === "carousel" ? "carousel" : "text",
                  content: templateDetails.bodyText,
                  category: persistedCategory,
                  language,
                  status: String(responseData?.status ?? "PENDING").toLowerCase(),
                  meta_template_id: responseData?.id ?? null,
                  body_text: templateDetails.bodyText,
                  carousel_data: templateDetails.templateType === "carousel" ? templateDetails.carouselCards : null,
                });
                dbError = error;
              }

              if (dbError) {
                sendJson(res, 200, {
                  success: true,
                  templateId: responseData?.id,
                  status: responseData?.status,
                  category: responseData?.category,
                  normalizedName: finalNormalizedName,
                  message: `Template created in Meta but failed to save locally. ${dbError.message || "Please refresh the page."}`,
                  warning: "Database save failed",
                });
                return;
              }

              sendJson(res, 200, {
                success: true,
                templateId: responseData?.id,
                status: responseData?.status,
                category: responseData?.category,
                normalizedName: finalNormalizedName,
                message: renamedFrom
                  ? `Template submitted to Meta as ${finalNormalizedName} because ${renamedFrom} is still reserved by Meta while the old content is being deleted.`
                  : "Template fetched and populated!",
                structure: {
                  name: finalNormalizedName,
                  previous_category: String(responseData?.category || persistedCategory).toUpperCase(),
                  parameter_format: "NAMED",
                  components,
                  language,
                  status: String(responseData?.status || ""),
                  category: String(responseData?.category || persistedCategory).toUpperCase(),
                  id: String(responseData?.id || ""),
                },
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { success: false, error: "Template creation failed", message });
            }
          });

          server.middlewares.use("/api/local/whatsapp-templates", async (req, res) => {
            if (req.method !== "GET") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const projectId = String(env.VITE_SUPABASE_PROJECT_ID || "").trim();
              const requestUrl = new URL(req.url || "", "http://127.0.0.1");
              const userId = String(requestUrl.searchParams.get("userId") || "").trim();
              const userEmailFromRequest = String(requestUrl.searchParams.get("userEmail") || "").trim().toLowerCase();

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              if (!userId && !userEmailFromRequest) {
                sendJson(res, 400, { error: "userId or userEmail is required" });
                return;
              }

              const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
                auth: { persistSession: false, autoRefreshToken: false },
              });

              const hasWhatsappTemplates = supportsLocalWhatsappTable(projectId, "whatsapp_templates");
              let resolvedUserEmail = userEmailFromRequest;

              if (!resolvedUserEmail && userId) {
                const authUser = await admin.auth.admin.getUserById(userId).catch(() => ({ data: { user: null } }));
                resolvedUserEmail = String(authUser.data.user?.email || "").trim().toLowerCase();
              }

              if (hasWhatsappTemplates && userId) {
                const { data, error } = await admin
                  .from("whatsapp_templates")
                  .select("*")
                  .eq("user_id", userId)
                  .order("created_at", { ascending: false });

                if (error) {
                  sendJson(res, 500, { error: error.message });
                  return;
                }

                sendJson(res, 200, { templates: data ?? [], source: "whatsapp_templates" });
                return;
              }

              if (!resolvedUserEmail) {
                sendJson(res, 400, { error: "Unable to resolve the signed-in email for legacy template storage." });
                return;
              }

              const { data, error } = await admin
                .from("Templates")
                .select("*")
                .eq("user_email", resolvedUserEmail)
                .order("created_at", { ascending: false });

              if (error) {
                sendJson(res, 500, { error: error.message });
                return;
              }

              sendJson(res, 200, { templates: data ?? [], source: "Templates" });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/sync-whatsapp-templates", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const projectId = String(env.VITE_SUPABASE_PROJECT_ID || "").trim();
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!userId) {
                sendJson(res, 400, { error: "userId is required" });
                return;
              }

              const remoteSyncCanUseWhatsappTemplates = supportsLocalWhatsappTable(projectId, "whatsapp_templates");
              const functionAvailable = remoteSyncCanUseWhatsappTemplates
                ? await isCloneFunctionAvailable(supabaseUrl, "sync-whatsapp-templates")
                : false;
              if (functionAvailable) {
                const response = await fetch(`${supabaseUrl}/functions/v1/sync-whatsapp-templates`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    apikey: supabaseServiceRoleKey,
                    Authorization: `Bearer ${supabaseServiceRoleKey}`,
                    "x-local-user-id": userId,
                  },
                  body: JSON.stringify({}),
                });

                const data = await response.json().catch(() => ({}));
                const errorText = JSON.stringify(data || {});
                const missingTableError =
                  errorText.includes("schema cache") || errorText.includes("Could not find the table");
                if (response.ok || !missingTableError) {
                  sendJson(res, response.status, data);
                  return;
                }
              }

              const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
                auth: { persistSession: false, autoRefreshToken: false },
              });

              const canReadTable = async (tableName: string) => {
                const { error } = await admin.from(tableName).select("id", { head: true, count: "exact" }).limit(1);
                return !error;
              };

              const [{ data: profile }, hasWhatsappApiConfigs, rawHasWhatsappTemplates, hasLegacyUserDetails, hasLegacyTemplates] =
                await Promise.all([
                  admin.from("profiles").select("user_id").or(`user_id.eq.${userId},id.eq.${userId}`).maybeSingle(),
                  canReadTable("whatsapp_api_configs"),
                  canReadTable("whatsapp_templates"),
                  canReadTable("User_details"),
                  canReadTable("Templates"),
                ]);
              const hasWhatsappTemplates =
                supportsLocalWhatsappTable(projectId, "whatsapp_templates") && rawHasWhatsappTemplates;

              const resolvedUserId = String(profile?.user_id || userId).trim();
              const authUser = resolvedUserId ? await admin.auth.admin.getUserById(resolvedUserId) : { data: { user: null } };
              const userEmail = authUser.data.user?.email ?? null;

              let metaAccessToken: string | null = null;
              let metaBusinessAccountId: string | null = null;

              if (hasWhatsappApiConfigs) {
                const { data: config } = await admin
                  .from("whatsapp_api_configs")
                  .select("meta_access_token, meta_business_account_id")
                  .eq("user_id", resolvedUserId)
                  .maybeSingle();

                if (config) {
                  metaAccessToken = config.meta_access_token;
                  metaBusinessAccountId = config.meta_business_account_id;
                }
              }

              if ((!metaAccessToken || !metaBusinessAccountId) && hasLegacyUserDetails && userEmail) {
                const { data: legacyConfig } = await admin
                  .from("User_details")
                  .select("meta_access_token, meta_business_account_id")
                  .eq("email", userEmail)
                  .maybeSingle();

                if (legacyConfig) {
                  metaAccessToken = legacyConfig.meta_access_token;
                  metaBusinessAccountId = legacyConfig.meta_business_account_id;
                }
              }

              if (!metaAccessToken || !metaBusinessAccountId) {
                sendJson(res, 400, { error: "Please configure your WhatsApp API credentials in Profile Settings." });
                return;
              }

              const templates = await fetchAllLocalWhatsappMetaTemplates(metaBusinessAccountId, metaAccessToken);

              if (hasWhatsappTemplates) {
                const rows = dedupeLocalWhatsappRows(
                  templates.map((template) => {
                    const details = parseLocalWhatsappTemplateDetails(Array.isArray(template?.components) ? template.components : []);
                    const normalizedName = normalizeLocalWhatsappTemplateName(String(template?.name || ""));
                    return {
                      user_id: resolvedUserId,
                      template_type: details.templateType,
                      name: String(template?.name || normalizedName),
                      normalized_name: normalizedName,
                      body: details.bodyText,
                      category: String(template?.category || "utility").toLowerCase(),
                      language: String(template?.language || "en_US"),
                      header_enabled: details.headerEnabled,
                      header_type: details.headerType,
                      header_text: details.headerText,
                      footer_enabled: details.footerEnabled,
                      footer_text: details.footerText,
                      buttons_enabled: details.buttonsEnabled,
                      button_types: details.buttonTypes,
                      buttons: details.buttons,
                      parameter_tokens: details.parameterTokens,
                      carousel_cards: details.carouselCards,
                      meta_template_id: String(template?.id || "").trim() || null,
                      meta_status: mapLocalWhatsappMetaStatus(template?.status),
                    };
                  }),
                  (row) => `${row.user_id}::${row.normalized_name}::${row.language}`,
                );

                if (rows.length > 0) {
                  const { error } = await admin
                    .from("whatsapp_templates")
                    .upsert(rows, { onConflict: "user_id,normalized_name,language" });
                  if (error) {
                    sendJson(res, 500, { error: error.message });
                    return;
                  }
                }
              } else if (hasLegacyTemplates && userEmail) {
                const rows = dedupeLocalWhatsappRows(
                  templates.map((template) => {
                    const details = parseLocalWhatsappTemplateDetails(Array.isArray(template?.components) ? template.components : []);
                    const normalizedName = normalizeLocalWhatsappTemplateName(String(template?.name || ""));
                    return {
                      user_email: userEmail,
                      template_name: normalizedName,
                      template_type: details.templateType === "carousel" ? "carousel" : "text",
                      content: details.bodyText,
                      category: String(template?.category || "UTILITY").toUpperCase(),
                      language: String(template?.language || "en_US"),
                      status: String(template?.status || "PENDING").toLowerCase(),
                      meta_template_id: String(template?.id || "").trim() || null,
                      body_text: details.bodyText,
                      carousel_data: details.templateType === "carousel" ? details.carouselCards : null,
                    };
                  }),
                  (row) => `${row.user_email}::${row.template_name}`,
                );

                if (rows.length > 0) {
                  const { error } = await admin
                    .from("Templates")
                    .upsert(rows, { onConflict: "user_email,template_name" });
                  if (error) {
                    sendJson(res, 500, { error: error.message });
                    return;
                  }
                }
              }

              sendJson(res, 200, { success: true, count: templates.length });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { success: false, error: message });
            }
          });

          server.middlewares.use("/api/local/validate-whatsapp-api-credentials", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const accessToken = String(body?.accessToken || "").trim();
              const phoneNumberId = String(body?.phoneNumberId || "").trim();
              const businessAccountId = String(body?.businessAccountId || "").trim();

              if (!accessToken || !phoneNumberId || !businessAccountId) {
                sendJson(res, 400, {
                  valid: false,
                  error: "Missing required fields: accessToken, phoneNumberId, or businessAccountId",
                });
                return;
              }

              if (supabaseUrl && supabaseServiceRoleKey) {
                const functionAvailable = await isCloneFunctionAvailable(supabaseUrl, "validate-whatsapp-api-credentials");
                if (functionAvailable) {
                  const response = await fetch(`${supabaseUrl}/functions/v1/validate-whatsapp-api-credentials`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      apikey: supabaseServiceRoleKey,
                      Authorization: `Bearer ${supabaseServiceRoleKey}`,
                    },
                    body: JSON.stringify({
                      accessToken,
                      phoneNumberId,
                      businessAccountId,
                    }),
                  });

                  const payload = await response.json().catch(() => ({}));
                  if (response.ok) {
                    sendJson(res, 200, payload);
                    return;
                  }

                  console.warn("[local validate-whatsapp-api-credentials] clone function failed; falling back to local handler", {
                    status: response.status,
                    payload,
                  });
                }
              }

              const graphVersion = "v22.0";

              const tokenResponse = await fetch(
                `https://graph.facebook.com/${graphVersion}/me?access_token=${encodeURIComponent(accessToken)}`,
              );

              if (!tokenResponse.ok) {
                const errorData = await tokenResponse.json().catch(() => ({}));
                sendJson(res, 200, {
                  valid: false,
                  error: "Invalid access token",
                  details: errorData?.error?.message || "The access token is invalid or expired.",
                });
                return;
              }

              const phonesResponse = await fetch(
                `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(businessAccountId)}/phone_numbers?access_token=${encodeURIComponent(accessToken)}`,
              );

              if (!phonesResponse.ok) {
                const errorData = await phonesResponse.json().catch(() => ({}));
                const errorCode = String(errorData?.error?.code ?? "");

                if (errorCode === "190" || errorCode === "10" || errorCode === "200") {
                  sendJson(res, 200, {
                    valid: false,
                    error: "Access token permissions issue",
                    details:
                      'Token does not have required permissions for this Business Account. Ensure it includes "whatsapp_business_messaging" and "whatsapp_business_management".',
                  });
                  return;
                }

                sendJson(res, 200, {
                  valid: false,
                  error: "Invalid Business Account ID",
                  details:
                    errorData?.error?.message ||
                    "The Business Account ID does not match the access token or does not exist.",
                });
                return;
              }

              const phonesData = await phonesResponse.json().catch(() => ({}));
              const phoneMatch = Array.isArray(phonesData?.data)
                ? phonesData.data.some((phone: Record<string, unknown>) => String(phone?.id ?? "") === phoneNumberId)
                : false;

              if (!phoneMatch) {
                sendJson(res, 200, {
                  valid: false,
                  error: "Phone Number ID mismatch",
                  details: `The Phone Number ID (${phoneNumberId}) does not belong to Business Account ${businessAccountId}. Please verify your credentials in Meta Business Manager.`,
                });
                return;
              }

              const phoneDetailsResponse = await fetch(
                `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}?fields=verified_name,display_phone_number,quality_rating&access_token=${encodeURIComponent(accessToken)}`,
              );

              let phoneDetails: Record<string, unknown> | null = null;
              if (phoneDetailsResponse.ok) {
                phoneDetails = await phoneDetailsResponse.json().catch(() => null);
              }

              sendJson(res, 200, {
                valid: true,
                details:
                  typeof phoneDetails?.verified_name === "string" && phoneDetails.verified_name.trim()
                    ? `Connected to: ${phoneDetails.verified_name}${typeof phoneDetails?.display_phone_number === "string" && phoneDetails.display_phone_number.trim() ? ` (${phoneDetails.display_phone_number})` : ""}`
                    : "All credentials are valid and properly linked.",
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, {
                valid: false,
                error: "Validation failed",
                details: message,
              });
            }
          });

          server.middlewares.use("/api/local/get-whatsapp-template-details", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();
              const templateName = String(body?.template_name || "").trim();
              const language = String(body?.language || "en_US").trim() || "en_US";

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              if (!userId || !templateName) {
                sendJson(res, 400, { error: "userId and template_name are required" });
                return;
              }

              const functionAvailable = await isCloneFunctionAvailable(supabaseUrl, "get-whatsapp-template-details");
              if (functionAvailable) {
                const response = await fetch(`${supabaseUrl}/functions/v1/get-whatsapp-template-details`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${supabaseServiceRoleKey}`,
                    "x-local-user-id": userId,
                  },
                  body: JSON.stringify({
                    template_name: templateName,
                    language,
                  }),
                });

                const payload = await response.json().catch(() => ({}));
                if (response.ok) {
                  sendJson(res, 200, payload);
                  return;
                }

                console.warn("[local get-whatsapp-template-details] clone function failed; falling back to local handler", {
                  status: response.status,
                  payload,
                });
              }

              const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
                auth: { persistSession: false, autoRefreshToken: false },
              });

              const canReadTable = async (tableName: string) => {
                const { error } = await admin.from(tableName).select("id", { head: true, count: "exact" }).limit(1);
                return !error;
              };

              const [{ data: profile }, hasWhatsappApiConfigs, hasLegacyUserDetails] = await Promise.all([
                admin.from("profiles").select("user_id").or(`user_id.eq.${userId},id.eq.${userId}`).maybeSingle(),
                canReadTable("whatsapp_api_configs"),
                canReadTable("User_details"),
              ]);

              const resolvedUserId = String(profile?.user_id || userId).trim();
              const authUser = resolvedUserId ? await admin.auth.admin.getUserById(resolvedUserId) : { data: { user: null } };
              const userEmail = authUser.data.user?.email ?? null;

              let metaAccessToken: string | null = null;
              let metaBusinessAccountId: string | null = null;

              if (hasWhatsappApiConfigs) {
                const { data: config } = await admin
                  .from("whatsapp_api_configs")
                  .select("meta_access_token, meta_business_account_id")
                  .eq("user_id", resolvedUserId)
                  .maybeSingle();

                if (config) {
                  metaAccessToken = config.meta_access_token;
                  metaBusinessAccountId = config.meta_business_account_id;
                }
              }

              if ((!metaAccessToken || !metaBusinessAccountId) && hasLegacyUserDetails && userEmail) {
                const { data: legacyConfig } = await admin
                  .from("User_details")
                  .select("meta_access_token, meta_business_account_id")
                  .eq("email", userEmail)
                  .maybeSingle();

                if (legacyConfig) {
                  metaAccessToken = legacyConfig.meta_access_token;
                  metaBusinessAccountId = legacyConfig.meta_business_account_id;
                }
              }

              if (!metaAccessToken || !metaBusinessAccountId) {
                sendJson(res, 404, { success: false, error: "User credentials not found" });
                return;
              }

              const response = await fetch(
                `https://graph.facebook.com/v22.0/${metaBusinessAccountId}/message_templates` +
                  `?name=${encodeURIComponent(templateName)}` +
                  `&fields=id,name,status,category,language,components`,
                {
                  method: "GET",
                  headers: {
                    Authorization: `Bearer ${metaAccessToken}`,
                  },
                },
              );

              const payload = await response.json().catch(() => ({}));
              if (!response.ok) {
                sendJson(res, response.status, {
                  success: false,
                  error: `WhatsApp API error: ${JSON.stringify(payload)}`,
                });
                return;
              }

              const templatesFound = Array.isArray(payload?.data) ? payload.data : [];
              const exactMatches = templatesFound.filter((template: Record<string, any>) => template?.name === templateName);
              const matchedTemplate =
                exactMatches.find((template: Record<string, any>) => template?.language === language) ??
                exactMatches[0] ??
                null;

              if (!matchedTemplate) {
                sendJson(res, 404, { success: false, error: "Template not found" });
                return;
              }

              const structure = parseLocalWhatsappMetaTemplateStructure(matchedTemplate);
              sendJson(res, 200, {
                success: true,
                template: {
                  ...structure,
                  components: Array.isArray(matchedTemplate?.components) ? matchedTemplate.components : [],
                },
                raw: matchedTemplate,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { success: false, error: message });
            }
          });

          server.middlewares.use("/api/local/delete-whatsapp-template", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const projectId = String(env.VITE_SUPABASE_PROJECT_ID || "").trim();
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();
              const templateId = String(body?.templateId || "").trim();
              const templateName = String(body?.templateName || "").trim();
              const metaTemplateId = String(body?.metaTemplateId || "").trim();
              const language = String(body?.language || "en_US").trim() || "en_US";

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!userId || !templateId || !templateName) {
                sendJson(res, 400, { error: "userId, templateId, and templateName are required" });
                return;
              }

              const functionAvailable = await isCloneFunctionAvailable(supabaseUrl, "delete-whatsapp-template");
              if (functionAvailable) {
                const response = await fetch(`${supabaseUrl}/functions/v1/delete-whatsapp-template`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${supabaseServiceRoleKey}`,
                    "x-local-user-id": userId,
                  },
                  body: JSON.stringify({
                    templateId,
                    templateName,
                    metaTemplateId,
                    language,
                  }),
                });

                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                  console.warn("[local delete-whatsapp-template] clone function failed; falling back to local handler", {
                    status: response.status,
                    payload,
                  });
                } else {
                  sendJson(res, 200, payload);
                  return;
                }
              }

              const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
                auth: { persistSession: false, autoRefreshToken: false },
              });

              const canReadTable = async (tableName: string) => {
                const { error } = await admin.from(tableName).select("id", { head: true, count: "exact" }).limit(1);
                return !error;
              };

              const [{ data: profile }, hasWhatsappApiConfigs, hasLegacyUserDetails] =
                await Promise.all([
                  admin.from("profiles").select("user_id").or(`user_id.eq.${userId},id.eq.${userId}`).maybeSingle(),
                  canReadTable("whatsapp_api_configs"),
                  canReadTable("User_details"),
                ]);
              const hasWhatsappTemplates = supportsLocalWhatsappTable(projectId, "whatsapp_templates") && await canReadTable("whatsapp_templates");

              const resolvedUserId = String(profile?.user_id || userId).trim();
              const authUser = resolvedUserId ? await admin.auth.admin.getUserById(resolvedUserId) : { data: { user: null } };
              const userEmail = authUser.data.user?.email ?? null;

              let metaAccessToken: string | null = null;
              let metaBusinessAccountId: string | null = null;

              if (hasWhatsappApiConfigs) {
                const { data: config } = await admin
                  .from("whatsapp_api_configs")
                  .select("meta_access_token, meta_business_account_id")
                  .eq("user_id", resolvedUserId)
                  .maybeSingle();

                if (config) {
                  metaAccessToken = config.meta_access_token;
                  metaBusinessAccountId = config.meta_business_account_id;
                }
              }

              if ((!metaAccessToken || !metaBusinessAccountId) && hasLegacyUserDetails && userEmail) {
                const { data: legacyConfig } = await admin
                  .from("User_details")
                  .select("meta_access_token, meta_business_account_id")
                  .eq("email", userEmail)
                  .maybeSingle();

                if (legacyConfig) {
                  metaAccessToken = legacyConfig.meta_access_token;
                  metaBusinessAccountId = legacyConfig.meta_business_account_id;
                }
              }

              if (metaAccessToken && metaBusinessAccountId) {
                const params = new URLSearchParams();
                if (metaTemplateId) {
                  params.set("hsm_id", metaTemplateId);
                } else {
                  params.set("name", templateName);
                  params.set("language", language);
                }

                const response = await fetch(`https://graph.facebook.com/v22.0/${metaBusinessAccountId}/message_templates?${params.toString()}`, {
                  method: "DELETE",
                  headers: {
                    Authorization: `Bearer ${metaAccessToken}`,
                  },
                });

                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                  const errorCode = String(payload?.error?.code ?? "");
                  const errorMessage = String(payload?.error?.message ?? "");
                  const notFound = errorCode === "100" || /does not exist|unknown/i.test(errorMessage);
                  if (!notFound) {
                    sendJson(res, response.status, {
                      error: payload?.error?.message || "Failed to delete template from Meta",
                    });
                    return;
                  }
                }
              }

              if (hasWhatsappTemplates) {
                const { error } = await admin
                  .from("whatsapp_templates")
                  .delete()
                  .eq("id", templateId)
                  .eq("user_id", resolvedUserId);
                if (error) {
                  sendJson(res, 500, { error: error.message });
                  return;
                }
              } else if (userEmail) {
                const { error } = await admin
                  .from("Templates")
                  .delete()
                  .eq("id", templateId)
                  .eq("user_email", userEmail);
                if (error) {
                  sendJson(res, 500, { error: error.message });
                  return;
                }
              }

              sendJson(res, 200, { success: true });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { success: false, error: message });
            }
          });

          server.middlewares.use("/api/local/send-campaign-messages", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();
              const campaignId = String(body?.campaign_id || "").trim();

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!userId) {
                sendJson(res, 400, { error: "userId is required" });
                return;
              }
              if (!campaignId) {
                sendJson(res, 400, { error: "campaign_id is required" });
                return;
              }

              const cloneResult = await invokeCloneWhatsappCampaignFunction({
                supabaseUrl,
                supabaseServiceRoleKey,
                userId,
                campaignId,
              });
              if (cloneResult?.ok) {
                sendJson(res, 200, {
                  ...cloneResult.payload,
                  source: "edge-function",
                  function_name: cloneResult.functionName,
                });
                return;
              }
              if (cloneResult && !cloneResult.ok) {
                console.warn("[local send-campaign-messages] falling back to local sender after clone failure", {
                  functionName: cloneResult.functionName,
                  payload: cloneResult.payload,
                });
              }

              const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
                auth: { persistSession: false, autoRefreshToken: false },
              });

              const canReadTable = async (tableName: string) => {
                const { error } = await admin.from(tableName).select("id", { head: true, count: "exact" }).limit(1);
                return !error;
              };

              const [
                hasWhatsappCampaigns,
                hasWhatsappAudiences,
                hasWhatsappAudienceContacts,
                hasWhatsappContacts,
                hasWhatsappTemplates,
              ] = await Promise.all([
                canReadTable("whatsapp_campaigns"),
                canReadTable("whatsapp_audiences"),
                canReadTable("whatsapp_audience_contacts"),
                canReadTable("whatsapp_contacts"),
                canReadTable("whatsapp_templates"),
              ]);

              let campaignTable = "audience_campaigns";
              let campaign: Record<string, any> | null = null;
              let campaignError: any = null;

              if (hasWhatsappCampaigns) {
                const whatsappCampaignResult = await admin
                  .from("whatsapp_campaigns")
                  .select("*")
                  .eq("id", campaignId)
                  .maybeSingle();

                if (whatsappCampaignResult.data) {
                  campaignTable = "whatsapp_campaigns";
                  campaign = whatsappCampaignResult.data;
                  campaignError = null;
                } else {
                  campaignError = whatsappCampaignResult.error;
                }
              }

              if (!campaign) {
                const fallbackCampaignResult = await admin
                  .from("audience_campaigns")
                  .select("*")
                  .eq("id", campaignId)
                  .maybeSingle();

                if (fallbackCampaignResult.data) {
                  campaignTable = "audience_campaigns";
                  campaign = fallbackCampaignResult.data;
                  campaignError = null;
                } else {
                  campaignError = fallbackCampaignResult.error ?? campaignError;
                }
              }

              if (campaignError || !campaign) {
                sendJson(res, 404, { error: "Campaign not found" });
                return;
              }

              const campaignOwnerId = String(campaign.user_id || userId).trim();
              if (!campaignOwnerId) {
                sendJson(res, 400, { error: "Campaign owner is missing" });
                return;
              }

              const isWhatsappCampaign = campaignTable === "whatsapp_campaigns";
              const audienceTable = isWhatsappCampaign && hasWhatsappAudiences ? "whatsapp_audiences" : "audience_segments";
              const audienceContactsTable =
                isWhatsappCampaign && hasWhatsappAudienceContacts ? "whatsapp_audience_contacts" : "audience_segment_contacts";
              const contactsTable = isWhatsappCampaign && hasWhatsappContacts ? "whatsapp_contacts" : "contacts";
              const templateTable = isWhatsappCampaign && hasWhatsappTemplates ? "whatsapp_templates" : "Templates";

              let template: Record<string, unknown> | null = null;
              if (campaign.template_id) {
                const { data: loadedTemplate, error: templateError } = await admin
                  .from(templateTable)
                  .select("*")
                  .eq("id", campaign.template_id)
                  .maybeSingle();

                if (templateError) {
                  sendJson(res, 400, { error: "Template lookup failed" });
                  return;
                }

                template = loadedTemplate;
              }

              const { data: audience, error: audienceError } = await admin
                .from(audienceTable)
                .select("id, name")
                .eq("id", campaign.audience_id)
                .eq("user_id", campaignOwnerId)
                .single();

              if (audienceError || !audience) {
                sendJson(res, 400, { error: "Audience not found" });
                return;
              }

              const { data: audienceLinks, error: audienceLinksError } = await admin
                .from(audienceContactsTable)
                .select("contact_id")
                .eq("user_id", campaignOwnerId)
                .eq("audience_id", audience.id);

              if (audienceLinksError) {
                sendJson(res, 500, { error: audienceLinksError.message });
                return;
              }

              const contactIds = (audienceLinks ?? []).map((row: { contact_id: string }) => row.contact_id);
              if (!contactIds.length) {
                sendJson(res, 400, { error: "No contacts found in audience" });
                return;
              }

              const { data: contacts, error: contactsError } = await admin
                .from(contactsTable)
                .select("*")
                .eq("user_id", campaignOwnerId)
                .in("id", contactIds);

              if (contactsError) {
                sendJson(res, 500, { error: contactsError.message });
                return;
              }

              const { data: config, error: configError } = await admin
                .from("whatsapp_api_configs")
                .select("meta_access_token, meta_phone_number_id, meta_business_account_id")
                .eq("user_id", campaignOwnerId)
                .single();

              if (configError || !config) {
                sendJson(res, 400, { error: "WhatsApp API configuration not found" });
                return;
              }

              const templateBody = String(
                campaign.template_structure?.previewBody ??
                  (isWhatsappCampaign
                    ? template?.body ?? ""
                    : template?.body_text ?? template?.content ?? ""),
              ).trim();
              const templateName = String(
                campaign.template_name ??
                  (isWhatsappCampaign
                    ? template?.normalized_name ?? template?.name ?? ""
                    : template?.template_name ?? ""),
              ).trim();
              const languageCode =
                String(campaign.template_language ?? template?.language ?? "en_US").trim() || "en_US";
              const canonicalTemplateStructure = templateName
                ? await fetchCanonicalLocalWhatsappTemplateStructure(
                    String(config.meta_business_account_id ?? "").trim(),
                    String(config.meta_access_token ?? "").trim(),
                    templateName,
                    languageCode,
                  )
                : null;
              const templateStructure =
                canonicalTemplateStructure ??
                (campaign.template_structure && typeof campaign.template_structure === "object"
                  ? campaign.template_structure
                  : {
                      hasHeader: false,
                      headerType: null,
                      headerHandleId: null,
                      headerImageUrl: null,
                      bodyParameters: buildLocalWhatsappBodyParameters(templateBody),
                      previewBody: templateBody,
                      hasCarousel: false,
                      carouselCards: [],
                    });
              const startedAt = new Date().toISOString();

              const startUpdate = {
                status: "active",
                started_at: startedAt,
                completed_at: null,
                total_contacts: contacts?.length ?? 0,
                sent_count: 0,
                failed_count: 0,
                outcomes: [],
              };

              await admin.from(campaignTable).update(startUpdate).eq("id", campaign.id);

              let sentCount = 0;
              let failedCount = 0;
              const outcomes: Array<Record<string, unknown>> = [];

              for (const contact of contacts ?? []) {
                const phoneNumber = normalizeLocalWhatsappPhoneNumber(String(contact.phone_number ?? ""));
                const renderedBody = renderLocalWhatsappTemplate(templateBody, contact);

                if (!phoneNumber) {
                  failedCount += 1;
                  outcomes.push({
                    contact_id: contact.id,
                    phone_number: null,
                    status: "failed",
                    error: "Missing phone number",
                    message_text: renderedBody,
                  });
                  continue;
                }

                try {
                  const accessToken = String(config.meta_access_token || "").trim();
                  const phoneNumberId = String(config.meta_phone_number_id || "").trim();

                  if (!accessToken || !phoneNumberId) {
                    throw new Error("Meta access token or phone number ID is missing");
                  }

                  const payload = templateName
                    ? buildLocalWhatsappTemplatePayload(phoneNumber, templateName, languageCode, templateStructure, contact)
                    : {
                        messaging_product: "whatsapp",
                        recipient_type: "individual",
                        to: phoneNumber,
                        type: "text",
                        text: { body: renderedBody },
                      };

                  const response = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${accessToken}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(payload),
                  });

                  const rawPayload = await response.json().catch(() => ({}));
                  if (!response.ok) {
                    throw new Error(
                      rawPayload?.error?.message ||
                        rawPayload?.error?.error_user_msg ||
                        "WhatsApp send failed",
                    );
                  }

                  sentCount += 1;
                  outcomes.push({
                    contact_id: contact.id,
                    phone_number: phoneNumber,
                    status: "sent",
                    provider_message_id: rawPayload?.messages?.[0]?.id ?? null,
                    message_text: renderedBody,
                  });
                } catch (error) {
                  failedCount += 1;
                  outcomes.push({
                    contact_id: contact.id,
                    phone_number: phoneNumber,
                    status: "failed",
                    error: error instanceof Error ? error.message : String(error),
                    message_text: renderedBody,
                  });
                }
              }

              const completedAt = new Date().toISOString();
              const finalStatus = sentCount > 0 ? "completed" : "failed";
              const firstFailedOutcome = outcomes.find(
                (outcome) => outcome.status === "failed" && typeof outcome.error === "string" && outcome.error.trim(),
              ) as { error?: string } | undefined;
              const firstError =
                firstFailedOutcome?.error?.trim() || (failedCount > 0 ? "WhatsApp send failed" : null);

              const finalUpdate = isWhatsappCampaign
                ? {
                    status: finalStatus,
                    completed_at: completedAt,
                    total_contacts: contacts?.length ?? 0,
                    sent_count: sentCount,
                    failed_count: failedCount,
                    // Delivery must come from webhook receipts, not initial Graph API acceptance.
                    delivered: 0,
                    failed: failedCount,
                    sent_date: completedAt,
                    outcomes,
                  }
                : {
                    status: finalStatus,
                    completed_at: completedAt,
                    total_contacts: contacts?.length ?? 0,
                    sent_count: sentCount,
                    failed_count: failedCount,
                    outcomes,
                  };

              const { error: updateError } = await admin
                .from(campaignTable)
                .update(finalUpdate)
                .eq("id", campaign.id);

              if (updateError) {
                sendJson(res, 500, { error: updateError.message });
                return;
              }

              sendJson(res, 200, {
                success: true,
                campaign_id: campaign.id,
                status: finalStatus,
                sent_count: sentCount,
                failed_count: failedCount,
                total_contacts: contacts?.length ?? 0,
                completed_at: completedAt,
                error: firstError,
                first_error: firstError,
                source: "local-fallback",
                function_name: null,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/send-whatsapp-direct-message", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();
              const phoneNumber = String(body?.phoneNumber || "").trim();
              const contactName = String(body?.contactName || "").trim();
              const message = String(body?.message || "").trim();

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!userId || !phoneNumber || !message) {
                sendJson(res, 400, { error: "userId, phoneNumber, and message are required" });
                return;
              }

              const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
                auth: { persistSession: false, autoRefreshToken: false },
              });

              const normalizePhone = (value: string) => {
                const digits = value.replace(/[^\d]/g, "");
                return digits ? `+${digits}` : "";
              };

              const canReadTable = async (tableName: string) => {
                const { error } = await admin.from(tableName).select("id", { head: true, count: "exact" }).limit(1);
                return !error;
              };

              const [hasWhatsappConversations, hasWhatsappMessages, configResult] = await Promise.all([
                canReadTable("whatsapp_conversations"),
                canReadTable("whatsapp_messages"),
                admin
                  .from("whatsapp_api_configs")
                  .select("meta_access_token, meta_phone_number_id")
                  .eq("user_id", userId)
                  .single(),
              ]);

              if (configResult.error || !configResult.data) {
                sendJson(res, 400, { error: "WhatsApp API configuration not found" });
                return;
              }

              const accessToken = String(configResult.data.meta_access_token || "").trim();
              const phoneNumberId = String(configResult.data.meta_phone_number_id || "").trim();
              const normalizedPhone = normalizePhone(phoneNumber);

              if (!accessToken || !phoneNumberId || !normalizedPhone) {
                sendJson(res, 400, { error: "WhatsApp configuration or phone number is invalid" });
                return;
              }

              const response = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  messaging_product: "whatsapp",
                  recipient_type: "individual",
                  to: normalizedPhone,
                  type: "text",
                  text: { body: message },
                }),
              });

              const payload = await response.json().catch(() => ({}));
              if (!response.ok) {
                sendJson(res, 500, {
                  error:
                    payload?.error?.message ||
                    payload?.error?.error_user_msg ||
                    "WhatsApp Cloud API request failed",
                });
                return;
              }

              const sentAt = new Date().toISOString();
              let conversationId: string | null = null;

              if (hasWhatsappConversations) {
                const { data: existingConversation } = await admin
                  .from("whatsapp_conversations")
                  .select("id")
                  .eq("user_id", userId)
                  .eq("phone_number", normalizedPhone)
                  .maybeSingle();

                if (existingConversation?.id) {
                  conversationId = existingConversation.id;
                  await admin
                    .from("whatsapp_conversations")
                    .update({
                      contact_name: contactName || normalizedPhone,
                      last_message_text: message,
                      last_message_at: sentAt,
                    })
                    .eq("id", conversationId)
                    .eq("user_id", userId);
                } else {
                  const { data: insertedConversation } = await admin
                    .from("whatsapp_conversations")
                    .insert({
                      user_id: userId,
                      phone_number: normalizedPhone,
                      contact_name: contactName || normalizedPhone,
                      last_message_text: message,
                      last_message_at: sentAt,
                    })
                    .select("id")
                    .single();

                  conversationId = insertedConversation?.id ?? null;
                }
              }

              if (hasWhatsappMessages && conversationId) {
                await admin.from("whatsapp_messages").insert({
                  conversation_id: conversationId,
                  user_id: userId,
                  direction: "outbound",
                  body: message,
                  provider_message_id: payload?.messages?.[0]?.id ?? null,
                  status: "sent",
                  raw_payload: payload,
                  sent_at: sentAt,
                });
              }

              sendJson(res, 200, {
                success: true,
                conversationId,
                messageId: payload?.messages?.[0]?.id ?? null,
                sentAt,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/whatsapp-audience-segments", async (req, res) => {
            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
                auth: { persistSession: false, autoRefreshToken: false },
              });

              const requestUrl = new URL(req.url || "/api/local/whatsapp-audience-segments", "http://127.0.0.1:5173");
              const body = req.method === "GET" ? {} : await readJsonBody(req);
              const userId = String(
                requestUrl.searchParams.get("userId") ||
                  body?.userId ||
                  body?.user_id ||
                  "",
              ).trim();

              if (!userId) {
                sendJson(res, 400, { error: "userId is required" });
                return;
              }

              if (req.method === "GET") {
                const [segmentsResult, segmentContactsResult, contactsResult] = await Promise.all([
                  admin.from("audience_segments").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
                  admin.from("audience_segment_contacts").select("audience_id, contact_id").eq("user_id", userId),
                  admin.from("contacts").select("id, first_name, phone_number").eq("user_id", userId).order("created_at", { ascending: false }),
                ]);

                if (segmentsResult.error) {
                  sendJson(res, 400, { error: segmentsResult.error.message });
                  return;
                }
                if (segmentContactsResult.error) {
                  sendJson(res, 400, { error: segmentContactsResult.error.message });
                  return;
                }
                if (contactsResult.error) {
                  sendJson(res, 400, { error: contactsResult.error.message });
                  return;
                }

                const contacts = (contactsResult.data ?? []).map((contact: any) => ({
                  id: contact.id,
                  name: contact.first_name?.trim() || contact.phone_number,
                  phone: contact.phone_number,
                }));

                const contactIdsByAudience = new Map<string, string[]>();
                for (const row of segmentContactsResult.data ?? []) {
                  const current = contactIdsByAudience.get(row.audience_id) ?? [];
                  current.push(row.contact_id);
                  contactIdsByAudience.set(row.audience_id, current);
                }

                const audiences = (segmentsResult.data ?? []).map((audience: any) => {
                  const contactIds = contactIdsByAudience.get(audience.id) ?? [];
                  return {
                    id: audience.id,
                    name: audience.name,
                    description: audience.description ?? "",
                    tag: audience.tag ?? "WhatsApp Segment",
                    members: contactIds.length,
                    contactIds,
                  };
                });

                sendJson(res, 200, { audiences, contacts, audienceSource: "db" });
                return;
              }

              if (req.method === "POST") {
                const name = String(body?.name || "").trim();
                const description = String(body?.description || "").trim();
                const contactIds = Array.isArray(body?.contactIds) ? body.contactIds.map((value: unknown) => String(value).trim()).filter(Boolean) : [];

                if (!name) {
                  sendJson(res, 400, { error: "name is required" });
                  return;
                }

                const { data: audienceRow, error: audienceError } = await admin
                  .from("audience_segments")
                  .insert({
                    user_id: userId,
                    name,
                    description,
                    tag: "WhatsApp Segment",
                  })
                  .select("id")
                  .single();

                if (audienceError || !audienceRow) {
                  sendJson(res, 400, { error: audienceError?.message || "Unable to create audience" });
                  return;
                }

                if (contactIds.length > 0) {
                  const { error: linksError } = await admin.from("audience_segment_contacts").insert(
                    contactIds.map((contactId: string) => ({
                      user_id: userId,
                      audience_id: audienceRow.id,
                      contact_id: contactId,
                    })),
                  );

                  if (linksError) {
                    sendJson(res, 400, { error: linksError.message });
                    return;
                  }
                }

                sendJson(res, 200, { id: audienceRow.id });
                return;
              }

              if (req.method === "PATCH") {
                const audienceId = String(body?.audienceId || body?.id || "").trim();
                const name = String(body?.name || "").trim();
                const description = String(body?.description || "").trim();
                const contactIds = Array.isArray(body?.contactIds) ? body.contactIds.map((value: unknown) => String(value).trim()).filter(Boolean) : [];

                if (!audienceId || !name) {
                  sendJson(res, 400, { error: "audienceId and name are required" });
                  return;
                }

                const { data: audienceRow, error: updateError } = await admin
                  .from("audience_segments")
                  .update({
                    name,
                    description,
                    tag: "WhatsApp Segment",
                  })
                  .eq("user_id", userId)
                  .eq("id", audienceId)
                  .select("id")
                  .single();

                if (updateError || !audienceRow) {
                  sendJson(res, 400, { error: updateError?.message || "Unable to update audience" });
                  return;
                }

                const { error: deleteLinksError } = await admin
                  .from("audience_segment_contacts")
                  .delete()
                  .eq("user_id", userId)
                  .eq("audience_id", audienceId);

                if (deleteLinksError) {
                  sendJson(res, 400, { error: deleteLinksError.message });
                  return;
                }

                if (contactIds.length > 0) {
                  const { error: linksError } = await admin.from("audience_segment_contacts").insert(
                    contactIds.map((contactId: string) => ({
                      user_id: userId,
                      audience_id: audienceId,
                      contact_id: contactId,
                    })),
                  );

                  if (linksError) {
                    sendJson(res, 400, { error: linksError.message });
                    return;
                  }
                }

                sendJson(res, 200, { id: audienceId });
                return;
              }

              if (req.method === "DELETE") {
                const audienceId = String(body?.audienceId || body?.id || "").trim();
                if (!audienceId) {
                  sendJson(res, 400, { error: "audienceId is required" });
                  return;
                }

                const { error: unlinkError } = await admin
                  .from("audience_segment_contacts")
                  .delete()
                  .eq("user_id", userId)
                  .eq("audience_id", audienceId);

                if (unlinkError) {
                  sendJson(res, 400, { error: unlinkError.message });
                  return;
                }

                const { error: deleteError } = await admin
                  .from("audience_segments")
                  .delete()
                  .eq("user_id", userId)
                  .eq("id", audienceId);

                if (deleteError) {
                  sendJson(res, 400, { error: deleteError.message });
                  return;
                }

                sendJson(res, 200, { success: true });
                return;
              }

              sendJson(res, 405, { error: "Method not allowed" });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/run-gmail-campaign", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const googleClientId = env.GOOGLE_CLIENT_ID || env.VITE_GOOGLE_CLIENT_ID;
              const googleClientSecret = env.GOOGLE_CLIENT_SECRET || env.VITE_GOOGLE_CLIENT_SECRET;
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();
              const userEmail = String(body?.userEmail || "").trim();
              const campaignId = String(body?.campaign_id || "").trim();
              const templateId = String(body?.template_id || "").trim();
              const selectedContactIndexes = Array.isArray(body?.selected_contact_indexes)
                ? body.selected_contact_indexes.filter((value: unknown): value is number => typeof value === "number")
                : [];

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!userId) {
                sendJson(res, 400, { error: "userId is required" });
                return;
              }
              if (!campaignId || !templateId || !selectedContactIndexes.length) {
                sendJson(res, 400, { error: "campaign_id, template_id, and selected_contact_indexes are required" });
                return;
              }

              const headers = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };
              const relatedUserIds = await resolveRelatedUserIds(
                supabaseUrl,
                supabaseServiceRoleKey,
                userId,
                userEmail,
              );
              const userIdList = relatedUserIds.map((id) => `"${id}"`).join(",");
              const isMissingTablePayload = (payload: unknown) => {
                const text = JSON.stringify(payload || {});
                return text.includes("schema cache") || text.includes("Could not find the table");
              };
              const gmailMarker = "__magicteams_channel";

              const getContactValue = (contact: Record<string, unknown>, token: string) => {
                const normalized = token.replace(/[_\s]+/g, "").toLowerCase();
                const candidates = [contact];
                const metadata = contact?.metadata;
                if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
                  candidates.push(metadata as Record<string, unknown>);
                }

                for (const candidate of candidates) {
                  for (const [key, value] of Object.entries(candidate)) {
                    const probe = key.replace(/[_\s]+/g, "").toLowerCase();
                    if (probe === normalized && value != null && typeof value !== "object") {
                      const textValue = String(value).trim();
                      if (textValue) return textValue;
                    }
                  }
                }

                return "";
              };

              const renderTemplate = (templateValue: string, contact: Record<string, unknown>) =>
                templateValue.replace(/<<\s*([^>]+?)\s*>>/g, (_, token: string) => getContactValue(contact, token));

              const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

              const encodeMimeMessage = (mime: string) =>
                Buffer.from(mime, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

              const refreshGoogleAccessToken = async (integration: any) => {
                const accessToken = String(integration?.access_token || integration?.api_key || "").trim();
                const expiresAt = integration?.token_expires_at ? new Date(integration.token_expires_at).getTime() : 0;
                if (accessToken && expiresAt > Date.now() + 60_000) {
                  return accessToken;
                }

                const refreshToken = String(integration?.refresh_token || "").trim();
                if (!refreshToken) {
                  if (accessToken) return accessToken;
                  throw new Error("Connected Gmail account is missing a refresh token");
                }
                if (!googleClientId || !googleClientSecret) {
                  throw new Error("Google OAuth credentials are required to refresh the connected Gmail token");
                }

                const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    client_id: googleClientId,
                    client_secret: googleClientSecret,
                    refresh_token: refreshToken,
                    grant_type: "refresh_token",
                  }),
                });
                const tokenJson = await tokenRes.json().catch(() => ({}));
                if (!tokenRes.ok || !tokenJson?.access_token) {
                  throw new Error(tokenJson?.error_description || tokenJson?.error || "Failed to refresh Gmail access token");
                }

                const tokenExpiresAt = new Date(Date.now() + Number(tokenJson.expires_in || 3600) * 1000).toISOString();
                const updateResponse = await fetch(
                  `${supabaseUrl}/rest/v1/calendar_integrations?id=eq.${encodeURIComponent(String(integration.id || ""))}`,
                  {
                    method: "PATCH",
                    headers: {
                      ...headers,
                      Prefer: "return=minimal",
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      access_token: tokenJson.access_token,
                      refresh_token: tokenJson.refresh_token || refreshToken,
                      token_expires_at: tokenExpiresAt,
                    }),
                  },
                );

                if (!updateResponse.ok) {
                  const updatePayload = await updateResponse.json().catch(() => ({}));
                  throw new Error(String(updatePayload?.message || updatePayload?.error || "Failed to persist refreshed Gmail token"));
                }

                return String(tokenJson.access_token);
              };

              const sendGmailMessage = async (integration: any, recipientEmail: string, subject: string, messageBody: string) => {
                const accessToken = await refreshGoogleAccessToken(integration);
                const mime = [
                  `To: ${recipientEmail}`,
                  `Subject: ${subject || "(no subject)"}`,
                  "Content-Type: text/plain; charset=UTF-8",
                  "MIME-Version: 1.0",
                  "",
                  messageBody,
                ].join("\r\n");

                const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ raw: encodeMimeMessage(mime) }),
                });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                  throw new Error(String(payload?.error?.message || payload?.message || "Failed to send Gmail message"));
                }

                return payload;
              };

              const [gmailCampaignResponse, gmailTemplateResponse, integrationResponse] = await Promise.all([
                fetch(
                  `${supabaseUrl}/rest/v1/gmail_campaigns?select=*&limit=1&id=eq.${encodeURIComponent(campaignId)}&user_id=in.(${userIdList})`,
                  { headers },
                ),
                fetch(
                  `${supabaseUrl}/rest/v1/gmail_templates?select=*&limit=1&id=eq.${encodeURIComponent(templateId)}&user_id=in.(${userIdList})`,
                  { headers },
                ),
                fetch(
                  `${supabaseUrl}/rest/v1/calendar_integrations?select=*&provider=eq.gmail&is_active=eq.true&user_id=in.(${userIdList})&order=created_at.asc`,
                  { headers },
                ),
              ]);

              const [gmailCampaignPayload, gmailTemplatePayload, integrationPayload] = await Promise.all([
                gmailCampaignResponse.json().catch(() => []),
                gmailTemplateResponse.json().catch(() => []),
                integrationResponse.json().catch(() => []),
              ]);

              let campaign = Array.isArray(gmailCampaignPayload) ? gmailCampaignPayload[0] || null : null;
              let campaignTableName = "gmail_campaigns";

              if ((!gmailCampaignResponse.ok && isMissingTablePayload(gmailCampaignPayload)) || !campaign) {
                const fallbackResponse = await fetch(
                  `${supabaseUrl}/rest/v1/sms_campaigns?select=*&limit=1&id=eq.${encodeURIComponent(campaignId)}&user_id=in.(${userIdList})`,
                  { headers },
                );
                const fallbackPayload = await fallbackResponse.json().catch(() => []);
                if (!fallbackResponse.ok) {
                  sendJson(res, 500, { error: "Failed to load Gmail campaign", details: fallbackPayload });
                  return;
                }
                const fallbackCampaign = Array.isArray(fallbackPayload) ? fallbackPayload[0] || null : null;
                const fallbackContacts = Array.isArray(fallbackCampaign?.extracted_contacts) ? fallbackCampaign.extracted_contacts : [];
                const isGmailFallback = fallbackContacts.some((contact: any) => {
                  const metadata = contact?.metadata;
                  return metadata && typeof metadata === "object" && metadata[gmailMarker] === "gmail";
                });
                campaign = isGmailFallback ? fallbackCampaign : null;
                campaignTableName = "sms_campaigns";
              }

              let template = Array.isArray(gmailTemplatePayload) ? gmailTemplatePayload[0] || null : null;
              let templateTableName = "gmail_templates";

              if ((!gmailTemplateResponse.ok && isMissingTablePayload(gmailTemplatePayload)) || !template) {
                const fallbackResponse = await fetch(
                  `${supabaseUrl}/rest/v1/sms_templates?select=*&limit=1&id=eq.${encodeURIComponent(templateId)}&user_id=in.(${userIdList})`,
                  { headers },
                );
                const fallbackPayload = await fallbackResponse.json().catch(() => []);
                if (!fallbackResponse.ok) {
                  sendJson(res, 500, { error: "Failed to load Gmail template", details: fallbackPayload });
                  return;
                }
                const fallbackTemplate = Array.isArray(fallbackPayload) ? fallbackPayload[0] || null : null;
                template = fallbackTemplate?.category === "gmail:email" ? fallbackTemplate : null;
                templateTableName = "sms_templates";
              }

              const integrationRows = Array.isArray(integrationPayload) ? integrationPayload : [];
              const gmailIntegration =
                integrationRows.find((item: any) => String(item?.refresh_token || "").trim()) ||
                integrationRows.find((item: any) => String(item?.access_token || item?.api_key || "").trim()) ||
                integrationRows[0];

              if (!campaign) {
                sendJson(res, 404, { error: "Gmail campaign not found" });
                return;
              }
              if (!template) {
                sendJson(res, 404, { error: "Gmail template not found" });
                return;
              }
              if (!gmailIntegration) {
                sendJson(res, 404, { error: "Connected Gmail account not found" });
                return;
              }

              let templateConfig: { to: string; subject: string; body: string } = { to: "<<email>>", subject: "", body: "" };
              try {
                const parsed = JSON.parse(String(template.message || "{}"));
                templateConfig = {
                  to: String(parsed?.to || "<<email>>"),
                  subject: String(parsed?.subject || ""),
                  body: String(parsed?.body || ""),
                };
              } catch {
                templateConfig = { to: "<<email>>", subject: "", body: String(template.message || "") };
              }

              const allContacts = Array.isArray(campaign.extracted_contacts) ? campaign.extracted_contacts : [];
              const selectedContacts = selectedContactIndexes
                .filter((index) => index >= 0 && index < allContacts.length)
                .map((index) => {
                  const contact = allContacts[index];
                  const metadata = contact?.metadata;
                  const normalizedMetadata =
                    metadata && typeof metadata === "object" && !Array.isArray(metadata)
                      ? { ...(metadata as Record<string, unknown>), [gmailMarker]: "gmail" }
                      : { [gmailMarker]: "gmail" };
                  return { ...contact, metadata: normalizedMetadata };
                });

              if (!selectedContacts.length) {
                sendJson(res, 400, { error: "No valid contacts selected" });
                return;
              }

              const senderEmail = String(gmailIntegration?.display_name || userEmail || "").trim() || userEmail;
              const startedAt = new Date().toISOString();
              const outcomes: Array<Record<string, unknown>> = [];
              let sentCount = 0;
              let failedCount = 0;

              for (const [index, contact] of selectedContacts.entries()) {
                const recipientEmail = renderTemplate(templateConfig.to, contact).split(/[;,]/)[0]?.trim() || getContactValue(contact, "email");
                const renderedSubject = renderTemplate(templateConfig.subject, contact).trim();
                const renderedBody = renderTemplate(templateConfig.body, contact).trim();

                if (!recipientEmail || !isValidEmail(recipientEmail)) {
                  failedCount += 1;
                  outcomes.push({
                    contact_index: index,
                    recipient_email: recipientEmail || null,
                    rendered_subject: renderedSubject,
                    rendered_message: renderedBody,
                    status: "failed",
                    error: "Recipient email is missing or invalid",
                    [gmailMarker]: "gmail",
                    contact,
                  });
                  continue;
                }

                try {
                  const sendPayload = await sendGmailMessage(gmailIntegration, recipientEmail, renderedSubject, renderedBody);
                  sentCount += 1;
                  outcomes.push({
                    contact_index: index,
                    recipient_email: recipientEmail,
                    rendered_subject: renderedSubject,
                    rendered_message: renderedBody,
                    provider_message_id: sendPayload?.id ? String(sendPayload.id) : null,
                    status: "sent",
                    [gmailMarker]: "gmail",
                    contact,
                  });
                } catch (sendError) {
                  failedCount += 1;
                  outcomes.push({
                    contact_index: index,
                    recipient_email: recipientEmail,
                    rendered_subject: renderedSubject,
                    rendered_message: renderedBody,
                    status: "failed",
                    error: sendError instanceof Error ? sendError.message : String(sendError),
                    [gmailMarker]: "gmail",
                    contact,
                  });
                }
              }

              const completedAt = new Date().toISOString();
              const status = failedCount === 0 ? "completed" : sentCount > 0 ? "completed" : "failed";
              const gmailTemplateIdForGmailTables = templateTableName === "gmail_templates" ? template.id : null;
              const smsTemplateIdForSmsTables = templateTableName === "sms_templates" ? template.id : null;
              const gmailSourceCampaignId = campaignTableName === "gmail_campaigns" ? campaign.id : null;
              const smsSourceCampaignId = campaignTableName === "sms_campaigns" ? campaign.id : null;
              const baseCompletedPayload = {
                user_id: userId,
                user_email: userEmail,
                name: String(campaign.name || "Gmail Campaign"),
                template_id: gmailTemplateIdForGmailTables,
                template_name: String(template.name || "Gmail Template"),
                total_contacts: selectedContacts.length,
                sent_count: sentCount,
                failed_count: failedCount,
                started_at: startedAt,
                completed_at: completedAt,
                selected_contacts: selectedContacts,
                outcomes,
                source_campaign_id: gmailSourceCampaignId,
                status,
              };

              let completedCampaign: Record<string, unknown> | null = null;

              const gmailCompletedResponse = await fetch(`${supabaseUrl}/rest/v1/gmail_completed_campaigns`, {
                method: "POST",
                headers: {
                  ...headers,
                  Prefer: "return=representation",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  ...baseCompletedPayload,
                  sender_email_address: senderEmail,
                }),
              });
              const gmailCompletedPayload = await gmailCompletedResponse.json().catch(() => []);

              if (!gmailCompletedResponse.ok && isMissingTablePayload(gmailCompletedPayload)) {
                const fallbackResponse = await fetch(`${supabaseUrl}/rest/v1/sms_completed_campaigns`, {
                  method: "POST",
                  headers: {
                    ...headers,
                    Prefer: "return=representation",
                  "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    ...baseCompletedPayload,
                    template_id: smsTemplateIdForSmsTables,
                    source_campaign_id: smsSourceCampaignId,
                    sender_phone_number: senderEmail,
                  }),
                });
                const fallbackPayload = await fallbackResponse.json().catch(() => []);
                if (!fallbackResponse.ok) {
                  sendJson(res, 500, { error: "Failed to save Gmail completed campaign", details: fallbackPayload });
                  return;
                }
                const row = Array.isArray(fallbackPayload) ? fallbackPayload[0] || null : fallbackPayload;
                completedCampaign = row
                  ? {
                      ...row,
                      sender_email_address: senderEmail,
                      template_id: template.id,
                      source_campaign_id: campaign.id,
                    }
                  : null;
              } else if (!gmailCompletedResponse.ok) {
                sendJson(res, 500, { error: "Failed to save Gmail completed campaign", details: gmailCompletedPayload });
                return;
              } else {
                completedCampaign = Array.isArray(gmailCompletedPayload) ? gmailCompletedPayload[0] || null : gmailCompletedPayload;
              }

              const updateResponse = await fetch(
                `${supabaseUrl}/rest/v1/${campaignTableName}?id=eq.${encodeURIComponent(String(campaign.id || ""))}`,
                {
                  method: "PATCH",
                  headers: {
                    ...headers,
                    Prefer: "return=minimal",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    status: "completed",
                    template_id: campaignTableName === "gmail_campaigns"
                      ? gmailTemplateIdForGmailTables
                      : smsTemplateIdForSmsTables,
                    updated_at: completedAt,
                  }),
                },
              );

              if (!updateResponse.ok) {
                const updatePayload = await updateResponse.json().catch(() => ({}));
                sendJson(res, 500, { error: "Emails sent, but campaign status update failed", details: updatePayload });
                return;
              }

              sendJson(res, 200, {
                completed_campaign: completedCampaign,
                sent_count: sentCount,
                failed_count: failedCount,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/send-sms-message", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!userId) {
                sendJson(res, 400, { error: "userId is required" });
                return;
              }

              const response = await fetch(`${supabaseUrl}/functions/v1/send-sms-message`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  apikey: supabaseServiceRoleKey,
                  Authorization: `Bearer ${supabaseServiceRoleKey}`,
                  "x-local-user-id": userId,
                },
                body: JSON.stringify({
                  completed_campaign_id: body?.completed_campaign_id,
                  recipient_number: body?.recipient_number,
                  message: body?.message,
                }),
              });

              const data = await response.json().catch(() => ({}));
              sendJson(res, response.status, data);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/browser-transcribe", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const sarvamApiKey = env.SARVAM_API_KEY;
              const { audioBase64, mimeType, languageCode } = await readJsonBody(req);

              if (!sarvamApiKey) {
                sendJson(res, 500, { error: "SARVAM_API_KEY is not configured" });
                return;
              }
              if (!audioBase64) {
                sendJson(res, 400, { error: "audioBase64 is required" });
                return;
              }

              const audioBuffer = Buffer.from(String(audioBase64), "base64");
              const rawMimeType = String(mimeType || "audio/webm").toLowerCase();
              const normalizedMimeType =
                rawMimeType.includes("wav") ? "audio/wav" :
                rawMimeType.includes("mp4") || rawMimeType.includes("m4a") ? "audio/mp4" :
                rawMimeType.includes("ogg") ? "audio/ogg" :
                rawMimeType.includes("webm") ? "audio/webm" :
                "audio/webm";
              const extension = normalizedMimeType.includes("mp4") ? "m4a" : normalizedMimeType.includes("ogg") ? "ogg" : normalizedMimeType.includes("wav") ? "wav" : "webm";
              const formData = new FormData();
              formData.append("file", new Blob([audioBuffer], { type: normalizedMimeType }), `browser-audio.${extension}`);
              formData.append("language_code", String(languageCode || "en-IN"));
              formData.append("model", "saaras:v3");
              formData.append("mode", "transcribe");

              const response = await fetch("https://api.sarvam.ai/speech-to-text", {
                method: "POST",
                headers: {
                  "Api-Subscription-Key": sarvamApiKey,
                },
                body: formData,
              });

              const data = await response.json().catch(() => ({}));
              if (!response.ok) {
                sendJson(res, response.status, {
                  error:
                    data?.error?.message ||
                    data?.message ||
                    data?.error ||
                    "Browser transcription failed",
                  details: data,
                });
                return;
              }

              const transcript = String(
                data?.transcript ??
                data?.text ??
                data?.result?.transcript ??
                data?.results?.transcript ??
                data?.results?.[0]?.transcript ??
                data?.results?.[0]?.text ??
                ""
              ).trim();

              sendJson(res, 200, { transcript, raw: data });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/admin-list-clients", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const allSpaces = ["voice", "sms", "whatsapp", "firebrand", "gmail"];
              const defaultSpaces = ["voice"];
              const normalizeEnabledSpaces = (value: unknown) => {
                if (!Array.isArray(value)) return defaultSpaces;
                const normalized = value.filter(
                  (entry): entry is string => typeof entry === "string" && allSpaces.includes(entry),
                );
                return normalized.length > 0 ? Array.from(new Set(normalized)) : defaultSpaces;
              };
              const normalizeRequestedSpaces = (value: unknown) => {
                if (!Array.isArray(value)) return [];
                return Array.from(
                  new Set(
                    value.filter(
                      (entry): entry is string => typeof entry === "string" && allSpaces.includes(entry),
                    ),
                  ),
                );
              };
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              const supabaseHeaders = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };

              // Get current user's email via Auth Token
              const authHeader = req.headers["authorization"] || req.headers["Authorization"];
              const requestBody = await readJsonBody(req).catch(() => ({}));
              const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
                ? authHeader.replace("Bearer ", "")
                : typeof requestBody?.access_token === "string"
                  ? requestBody.access_token
                  : "";

              if (!token) {
                sendJson(res, 401, { error: "Unauthorized" });
                return;
              }

              const caller = await getLocalCaller(token, env);
              const userEmail = caller?.email ?? null;

              if (!userEmail) {
                sendJson(res, 401, { error: "Unauthorized" });
                return;
              }

              const ADMIN_EMAIL = (env.VITE_ADMIN_EMAIL || "saphaarelabs@gmail.com").toLowerCase();
              const isAdmin = userEmail.toLowerCase() === ADMIN_EMAIL;

              // Check if they are an active agency
              const agencyResponse = await fetch(
                `${supabaseUrl}/rest/v1/agency_access_grants?select=is_active&email=eq.${encodeURIComponent(userEmail)}&limit=1`,
                { headers: supabaseHeaders }
              );
              const agencyGrants = await agencyResponse.json().catch(() => []);
              const isAgency = Array.isArray(agencyGrants) && agencyGrants[0]?.is_active;

              if (!isAdmin && !isAgency) {
                sendJson(res, 403, { error: "Admin/Agency access only" });
                return;
              }

              // Build accessible agency emails (hierarchical parent-child agency mapping)
              const accessibleAgencyEmails = [userEmail];
              if (isAgency) {
                const relationsResponse = await fetch(
                  `${supabaseUrl}/rest/v1/agency_relationships?select=child_agency_email&parent_agency_email=eq.${encodeURIComponent(userEmail)}`,
                  { headers: supabaseHeaders }
                );
                const relations = await relationsResponse.json().catch(() => []);
                if (Array.isArray(relations)) {
                  relations.forEach((r: any) => accessibleAgencyEmails.push(r.child_agency_email.toLowerCase()));
                }
              }

              // Query client_details view directly (database-level filtering)
              let clientDetailsUrl = `${supabaseUrl}/rest/v1/client_details?select=user_id,email,full_name,company_name,agency_email,raw_user_meta_data`;
              if (isAgency) {
                const joinedEmails = accessibleAgencyEmails.map(e => `"${e}"`).join(",");
                clientDetailsUrl += `&agency_email=in.(${encodeURIComponent(joinedEmails)})`;
              }

              const [clientDetailsResponse, balancesResponse] = await Promise.all([
                fetch(clientDetailsUrl, { headers: supabaseHeaders }),
                fetch(`${supabaseUrl}/rest/v1/user_minute_balances?select=user_id,available_seconds,enterprise_rate_per_minute,last_enterprise_amount,last_enterprise_minutes`, {
                  headers: supabaseHeaders,
                }),
              ]);

              const clientDetails = await clientDetailsResponse.json().catch(() => []);
              const balances = await balancesResponse.json().catch(() => []);

              if (!clientDetailsResponse.ok) {
                sendJson(res, 500, { error: "Failed to load clients from client_details view" });
                return;
              }

              const balanceMap = new Map(
                (Array.isArray(balances) ? balances : []).map((balance: any) => [balance.user_id, balance]),
              );

              const clients = (Array.isArray(clientDetails) ? clientDetails : [])
                .map((client: any) => {
                  if (!client.email || client.email.toLowerCase() === ADMIN_EMAIL) {
                    return null;
                  }
                  const metadata = client.raw_user_meta_data || {};
                  const balance = balanceMap.get(client.user_id) || {};

                  return {
                    user_id: client.user_id,
                    email: client.email,
                    full_name: client.full_name || (typeof metadata.full_name === "string" ? metadata.full_name : null),
                    company_name: client.company_name || null,
                    enabled_spaces: normalizeEnabledSpaces(metadata.magicteams_enabled_spaces),
                    requested_spaces: normalizeRequestedSpaces(metadata.magicteams_requested_spaces),
                    enterprise_interest: Boolean(metadata.enterprise_interest),
                    available_seconds: Number(balance.available_seconds || 0),
                    enterprise_rate_per_minute: balance.enterprise_rate_per_minute != null ? Number(balance.enterprise_rate_per_minute) : null,
                    last_enterprise_amount: balance.last_enterprise_amount != null ? Number(balance.last_enterprise_amount) : null,
                    last_enterprise_minutes: balance.last_enterprise_minutes != null ? Number(balance.last_enterprise_minutes) : null,
                    agency_email: client.agency_email ?? null,
                  };
                })
                .filter((client: any) => client !== null)
                .sort((a: any, b: any) => {
                  if (a.enterprise_interest !== b.enterprise_interest) {
                    return a.enterprise_interest ? -1 : 1;
                  }
                  return String(a.email).localeCompare(String(b.email));
                });

              sendJson(res, 200, { clients });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/admin-list-agencies", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              const supabaseHeaders = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };

              // Get current user's email via Auth Token
              const authHeader = req.headers["authorization"] || req.headers["Authorization"];
              const requestBody = await readJsonBody(req).catch(() => ({}));
              const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
                ? authHeader.replace("Bearer ", "")
                : typeof requestBody?.access_token === "string"
                  ? requestBody.access_token
                  : "";

              const userEmail = token ? ((await getLocalCaller(token, env))?.email ?? "") : "";

              const ADMIN_EMAIL = (env.VITE_ADMIN_EMAIL || "saphaarelabs@gmail.com").toLowerCase();
              const isAdmin = userEmail.toLowerCase() === ADMIN_EMAIL;

              const agencyResponse = await fetch(
                `${supabaseUrl}/rest/v1/agency_access_grants?select=is_active&email=eq.${encodeURIComponent(userEmail)}&limit=1`,
                { headers: supabaseHeaders }
              );
              const agencyGrants = await agencyResponse.json().catch(() => []);
              const isAgency = Array.isArray(agencyGrants) && agencyGrants[0]?.is_active;

              if (!isAdmin && !isAgency) {
                sendJson(res, 403, { error: "Admin/Agency access only" });
                return;
              }

              const response = await fetch(
                `${supabaseUrl}/rest/v1/agency_access_grants?select=id,email,is_active,granted_by,created_at,updated_at&order=created_at.desc`,
                {
                  headers: supabaseHeaders,
                },
              );
              const payload = await response.json().catch(() => []);

              if (!response.ok) {
                sendJson(res, 500, { error: "Failed to load agency access records" });
                return;
              }

              let filteredData = payload ?? [];
              if (isAgency) {
                // Fetch child agency emails
                const relationsResponse = await fetch(
                  `${supabaseUrl}/rest/v1/agency_relationships?select=child_agency_email&parent_agency_email=eq.${encodeURIComponent(userEmail)}`,
                  { headers: supabaseHeaders }
                );
                const relations = await relationsResponse.json().catch(() => []);
                const subAgencyEmails = Array.isArray(relations) ? relations.map((r: any) => r.child_agency_email.toLowerCase()) : [];
                
                filteredData = (payload ?? []).filter((agency: any) => 
                  agency.email?.toLowerCase() === userEmail || subAgencyEmails.includes(agency.email?.toLowerCase())
                );
              }

              sendJson(res, 200, { agencies: filteredData });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/admin-grant-agency-access", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const requestBody = await readJsonBody(req);
              const { child_agency_email } = requestBody;
              const targetChildAgency = typeof child_agency_email === "string" ? child_agency_email.trim().toLowerCase() : "";

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!targetChildAgency) {
                sendJson(res, 400, { error: "child_agency_email is required" });
                return;
              }

              // Get current user's email via Auth Token
              const authHeader = req.headers["authorization"] || req.headers["Authorization"];
              const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
                ? authHeader.replace("Bearer ", "")
                : "";

              const userEmail = token ? ((await getLocalCaller(token, env))?.email ?? "") : "";

              if (!userEmail) {
                sendJson(res, 401, { error: "Unauthorized" });
                return;
              }

              const supabaseHeaders = {
                "Content-Type": "application/json",
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };

              // 1. Insert into agency_access_grants
              const grantsResponse = await fetch(
                `${supabaseUrl}/rest/v1/agency_access_grants?on_conflict=email`,
                {
                  method: "POST",
                  headers: {
                    ...supabaseHeaders,
                    Prefer: "resolution=merge-duplicates,return=representation",
                  },
                  body: JSON.stringify([{
                    email: targetChildAgency,
                    is_active: true,
                    granted_by: userEmail,
                  }]),
                }
              );

              if (!grantsResponse.ok) {
                sendJson(res, 500, { error: "Failed to save agency access grant" });
                return;
              }

              // 2. Insert into agency_relationships
              const relationsResponse = await fetch(
                `${supabaseUrl}/rest/v1/agency_relationships?on_conflict=parent_agency_email,child_agency_email`,
                {
                  method: "POST",
                  headers: {
                    ...supabaseHeaders,
                    Prefer: "resolution=merge-duplicates,return=representation",
                  },
                  body: JSON.stringify([{
                    parent_agency_email: userEmail,
                    child_agency_email: targetChildAgency,
                  }]),
                }
              );

              if (!relationsResponse.ok) {
                sendJson(res, 500, { error: "Failed to establish agency relation" });
                return;
              }

              sendJson(res, 200, { success: true });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/admin-upsert-agency-access", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }
            if (!(await requireLocalAdminOrAgency(req, res, env))) return;

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const { email } = await readJsonBody(req);
              const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!/^[a-z0-9._%+-]+@gmail\.com$/i.test(normalizedEmail)) {
                sendJson(res, 400, { error: "Enter a valid Gmail address." });
                return;
              }

              const response = await fetch(
                `${supabaseUrl}/rest/v1/agency_access_grants?on_conflict=email&select=id,email,is_active,granted_by,created_at,updated_at`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Prefer: "resolution=merge-duplicates,return=representation",
                    apikey: supabaseServiceRoleKey,
                    Authorization: `Bearer ${supabaseServiceRoleKey}`,
                  },
                  body: JSON.stringify([
                    {
                      email: normalizedEmail,
                      is_active: true,
                      granted_by: "saphaarelabs@gmail.com",
                    },
                  ]),
                },
              );
              const payload = await response.json().catch(() => []);

              if (!response.ok) {
                sendJson(res, 500, { error: "Failed to save agency access" });
                return;
              }

              sendJson(res, 200, { success: true, agency: Array.isArray(payload) ? payload[0] ?? null : payload });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/admin-revoke-agency-access", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }
            if (!(await requireLocalAdminOrAgency(req, res, env))) return;

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const { id } = await readJsonBody(req);
              const normalizedId = typeof id === "string" ? id.trim() : "";

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!normalizedId) {
                sendJson(res, 400, { error: "Agency record id is required." });
                return;
              }

              const response = await fetch(
                `${supabaseUrl}/rest/v1/agency_access_grants?id=eq.${encodeURIComponent(normalizedId)}`,
                {
                  method: "PATCH",
                  headers: {
                    "Content-Type": "application/json",
                    apikey: supabaseServiceRoleKey,
                    Authorization: `Bearer ${supabaseServiceRoleKey}`,
                  },
                  body: JSON.stringify({
                    is_active: false,
                    granted_by: "saphaarelabs@gmail.com",
                  }),
                },
              );

              if (!response.ok) {
                sendJson(res, 500, { error: "Failed to revoke agency access" });
                return;
              }

              sendJson(res, 200, { success: true, id: normalizedId });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/admin-update-client-spaces", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }
            if (!(await requireLocalAdminOrAgency(req, res, env))) return;

            try {
              const allSpaces = ["voice", "sms", "whatsapp", "firebrand", "gmail"];
              const defaultSpaces = ["voice"];
              const normalizeEnabledSpaces = (value: unknown) => {
                if (!Array.isArray(value)) return defaultSpaces;
                const normalized = value.filter(
                  (entry): entry is string => typeof entry === "string" && allSpaces.includes(entry),
                );
                return normalized.length > 0 ? Array.from(new Set(normalized)) : defaultSpaces;
              };
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const requestBody = await readJsonBody(req);
              const { client_user_id, client_email, enabled_spaces, agency_email } = requestBody;

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!client_user_id) {
                sendJson(res, 400, { error: "client_user_id is required" });
                return;
              }

              const normalizedSpaces = normalizeEnabledSpaces(enabled_spaces);
              const userResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(client_user_id)}`, {
                headers: {
                  apikey: supabaseServiceRoleKey,
                  Authorization: `Bearer ${supabaseServiceRoleKey}`,
                },
              });
              const userPayload = await userResponse.json().catch(() => ({}));
              let authUser = userPayload?.user || (userPayload?.id ? userPayload : null);

              if (!authUser) {
                const usersResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1000`, {
                  headers: {
                    apikey: supabaseServiceRoleKey,
                    Authorization: `Bearer ${supabaseServiceRoleKey}`,
                  },
                });
                const usersPayload = await usersResponse.json().catch(() => ({}));
                const authUsers = Array.isArray(usersPayload?.users) ? usersPayload.users : [];
                const normalizedEmail = typeof client_email === "string" ? client_email.trim().toLowerCase() : "";

                authUser =
                  authUsers.find((account: any) => String(account?.id || "").trim() === String(client_user_id).trim()) ||
                  authUsers.find((account: any) => String(account?.email || "").trim().toLowerCase() === normalizedEmail) ||
                  null;
              }

              if (!authUser) {
                sendJson(res, 404, { error: "Client user not found" });
                return;
              }

              const currentMetadata = authUser.user_metadata || {};
              const authUserId = String(authUser.id || client_user_id);
              const requestedSpaces = Array.isArray(currentMetadata.magicteams_requested_spaces)
                ? currentMetadata.magicteams_requested_spaces.filter(
                    (entry): entry is string => typeof entry === "string" && allSpaces.includes(entry),
                  )
                : [];
              const updateResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(authUserId)}`, {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  apikey: supabaseServiceRoleKey,
                  Authorization: `Bearer ${supabaseServiceRoleKey}`,
                },
                body: JSON.stringify({
                  user_metadata: {
                    ...currentMetadata,
                    magicteams_enabled_spaces: normalizedSpaces,
                    magicteams_requested_spaces: requestedSpaces.filter((space) => !normalizedSpaces.includes(space)),
                    magicteams_spaces_updated_at: new Date().toISOString(),
                  },
                }),
              });

              const updatePayload = await updateResponse.json().catch(() => ({}));
              if (!updateResponse.ok) {
                sendJson(res, 500, { error: updatePayload?.msg || updatePayload?.error || "Failed to update client spaces" });
                return;
              }

              // Update profiles table in Supabase
              if (typeof agency_email !== "undefined") {
                const targetAgencyEmail = agency_email ? agency_email.trim().toLowerCase() : null;
                const profileUpdateResponse = await fetch(`${supabaseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(client_user_id)}`, {
                  method: "PATCH",
                  headers: {
                    "Content-Type": "application/json",
                    apikey: supabaseServiceRoleKey,
                    Authorization: `Bearer ${supabaseServiceRoleKey}`,
                  },
                  body: JSON.stringify({ agency_email: targetAgencyEmail }),
                });
                if (!profileUpdateResponse.ok) {
                  sendJson(res, 500, { error: "Failed to update profile agency email" });
                  return;
                }
              }

              sendJson(res, 200, { success: true, enabled_spaces: normalizedSpaces });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/admin-update-client-enterprise", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }

              const supabaseHeaders = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
                "Content-Type": "application/json",
              };

              const requestBody = await readJsonBody(req);
              const { client_user_id, enterprise_rate_per_minute, purchase_amount, minutes_to_transfer } = requestBody;

              if (!client_user_id) {
                sendJson(res, 400, { error: "client_user_id is required" });
                return;
              }

              // Get current user's email via Auth Token to check if they are agency or admin
              const authHeader = req.headers["authorization"] || req.headers["Authorization"];
              const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
                ? authHeader.replace("Bearer ", "")
                : typeof requestBody?.access_token === "string"
                  ? requestBody.access_token
                  : "";

              if (!token) {
                sendJson(res, 401, { error: "Unauthorized" });
                return;
              }

              const caller = await getLocalCaller(token, env);
              const userEmail = caller?.email ?? null;
              const userId = caller?.id ?? null;

              if (!userEmail || !userId) {
                sendJson(res, 401, { error: "Unauthorized" });
                return;
              }

              const ADMIN_EMAIL = (env.VITE_ADMIN_EMAIL || "saphaarelabs@gmail.com").toLowerCase();
              const isAdmin = userEmail.toLowerCase() === ADMIN_EMAIL;

              // Check if they are an active agency
              const agencyResponse = await fetch(
                `${supabaseUrl}/rest/v1/agency_access_grants?select=is_active&email=eq.${encodeURIComponent(userEmail)}&limit=1`,
                { headers: supabaseHeaders }
              );
              const agencyGrants = await agencyResponse.json().catch(() => []);
              const isAgency = Array.isArray(agencyGrants) && agencyGrants[0]?.is_active;

              if (!isAdmin && !isAgency) {
                sendJson(res, 403, { error: "Admin/Agency access only" });
                return;
              }

              // Case A: minute transfer (used by agencies, or direct minute additions)
              if (minutes_to_transfer != null) {
                const mins = Number(minutes_to_transfer);
                if (!Number.isInteger(mins) || mins <= 0) {
                  sendJson(res, 400, { error: "minutes_to_transfer must be a valid positive integer" });
                  return;
                }

                const secondsToTransfer = mins * 60;

                // If isAgency and not Admin, deduct from agency balance
                if (isAgency && !isAdmin) {
                  const agencyBalance = await ensureLocalMinuteBalance(supabaseUrl, supabaseServiceRoleKey, userId);
                  const agencyAvailableSeconds = Number(agencyBalance?.available_seconds || 0);

                  if (agencyAvailableSeconds < secondsToTransfer) {
                    const availableMinutes = Math.floor(agencyAvailableSeconds / 60);
                    sendJson(res, 400, { 
                      error: `Insufficient minutes. You only have ${availableMinutes} minutes available in your agency account.` 
                    });
                    return;
                  }

                  // Deduct from agency
                  const nextAgencySeconds = Math.max(0, agencyAvailableSeconds - secondsToTransfer);
                  await fetch(`${supabaseUrl}/rest/v1/user_minute_balances?user_id=eq.${encodeURIComponent(userId)}`, {
                    method: "PATCH",
                    headers: supabaseHeaders,
                    body: JSON.stringify({ available_seconds: nextAgencySeconds, updated_at: new Date().toISOString() }),
                  });
                }

                // Add to client
                const clientBalance = await ensureLocalMinuteBalance(supabaseUrl, supabaseServiceRoleKey, client_user_id);
                const clientAvailableSeconds = Number(clientBalance?.available_seconds || 0);
                const nextClientSeconds = clientAvailableSeconds + secondsToTransfer;

                await fetch(`${supabaseUrl}/rest/v1/user_minute_balances?user_id=eq.${encodeURIComponent(client_user_id)}`, {
                  method: "PATCH",
                  headers: supabaseHeaders,
                  body: JSON.stringify({ available_seconds: nextClientSeconds, updated_at: new Date().toISOString() }),
                });

                // Insert transactions
                await Promise.all([
                  ...(isAgency && !isAdmin ? [
                    fetch(`${supabaseUrl}/rest/v1/minute_transactions`, {
                      method: "POST",
                      headers: supabaseHeaders,
                      body: JSON.stringify({
                        user_id: userId,
                        kind: "agency_transfer_out",
                        source: "agency",
                        seconds_delta: -secondsToTransfer,
                        rate_per_minute: 0.1,
                        amount: 0,
                        notes: `Transferred to client (ID: ${client_user_id})`,
                      }),
                    })
                  ] : []),
                  fetch(`${supabaseUrl}/rest/v1/minute_transactions`, {
                    method: "POST",
                    headers: supabaseHeaders,
                    body: JSON.stringify({
                      user_id: client_user_id,
                      kind: isAgency && !isAdmin ? "agency_transfer_in" : "enterprise_credit",
                      source: isAgency && !isAdmin ? "agency" : "direct",
                      seconds_delta: secondsToTransfer,
                      rate_per_minute: clientBalance?.enterprise_rate_per_minute ?? 0.1,
                      amount: 0,
                      notes: isAgency && !isAdmin 
                        ? `Received transfer from agency (${userEmail})` 
                        : "Admin direct minutes credit",
                    }),
                  }),
                ]);

                // Clear client's enterprise_interest metadata in auth
                let updatedUser = null;
                try {
                  const clientAuthResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(client_user_id)}`, {
                    headers: supabaseHeaders,
                  });
                  const clientAuthPayload = await clientAuthResponse.json().catch(() => ({}));
                  if (clientAuthResponse.ok && clientAuthPayload?.user) {
                    const currentMetadata = clientAuthPayload.user.user_metadata || {};
                    const updateResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(client_user_id)}`, {
                      method: "PUT",
                      headers: supabaseHeaders,
                      body: JSON.stringify({
                        user_metadata: {
                          ...currentMetadata,
                          enterprise_interest: false,
                          enterprise_updated_by: userEmail,
                          enterprise_updated_at: new Date().toISOString(),
                        },
                      }),
                    });
                    const updatePayload = await updateResponse.json().catch(() => ({}));
                    if (updateResponse.ok) {
                      updatedUser = updatePayload.user || clientAuthPayload.user || null;
                    }
                  }
                } catch (err) {
                  console.error("Failed to clear enterprise metadata:", err);
                }

                sendJson(res, 200, {
                  success: true,
                  user: updatedUser,
                  credit: {
                    creditedMinutes: mins,
                    creditedSeconds: secondsToTransfer,
                    availableSeconds: nextClientSeconds,
                    ratePerMinute: clientBalance?.enterprise_rate_per_minute ?? 0.1,
                    purchaseAmount: 0,
                  },
                });
                return;
              }

              // Case B: standard enterprise custom rate crediting (used by admins under Enterprise tab)
              if (enterprise_rate_per_minute == null || purchase_amount == null) {
                sendJson(res, 400, { error: "enterprise_rate_per_minute and purchase_amount are required for custom pricing" });
                return;
              }

              const ratePerMinute = Number(enterprise_rate_per_minute);
              const purchaseAmount = Number(purchase_amount);
              if (!Number.isFinite(ratePerMinute) || ratePerMinute <= 0) {
                sendJson(res, 400, { error: "enterprise_rate_per_minute must be a valid positive number" });
                return;
              }
              if (!Number.isFinite(purchaseAmount) || purchaseAmount <= 0) {
                sendJson(res, 400, { error: "purchase_amount must be a valid positive number" });
                return;
              }

              const credit = await creditLocalEnterpriseMinutes(
                supabaseUrl,
                supabaseServiceRoleKey,
                client_user_id,
                ratePerMinute,
                purchaseAmount,
              );

              const clientAuthResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(client_user_id)}`, {
                headers: supabaseHeaders,
              });
              const clientAuthPayload = await clientAuthResponse.json().catch(() => ({}));
              if (!clientAuthResponse.ok || !clientAuthPayload?.user) {
                sendJson(res, 200, { success: true, user: null, credit });
                return;
              }

              const currentMetadata = clientAuthPayload.user.user_metadata || {};
              const updateResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(client_user_id)}`, {
                method: "PUT",
                headers: supabaseHeaders,
                body: JSON.stringify({
                  user_metadata: {
                    ...currentMetadata,
                    enterprise_interest: false,
                    enterprise_updated_by: userEmail,
                    enterprise_updated_at: new Date().toISOString(),
                  },
                }),
              });

              const updatePayload = await updateResponse.json().catch(() => ({}));
              sendJson(res, 200, { success: true, user: updatePayload.user || clientAuthPayload.user || null, credit });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/admin-dismiss-enterprise", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }
            if (!(await requireLocalAdminOrAgency(req, res, env))) return;

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const { client_user_id } = await readJsonBody(req);

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!client_user_id) {
                sendJson(res, 400, { error: "client_user_id is required" });
                return;
              }

              const userResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(client_user_id)}`, {
                headers: {
                  apikey: supabaseServiceRoleKey,
                  Authorization: `Bearer ${supabaseServiceRoleKey}`,
                },
              });
              const userPayload = await userResponse.json().catch(() => ({}));
              const authUser = userPayload?.user || (userPayload?.id ? userPayload : null);

              if (!userResponse.ok || !authUser) {
                console.error("Local dismiss: User not found or API error", {
                  status: userResponse.status,
                  payload: userPayload,
                  client_user_id
                });
                sendJson(res, 404, { error: `User not found (${userResponse.status})` });
                return;
              }

              const currentMetadata = authUser.user_metadata || {};
              const updateResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(client_user_id)}`, {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  apikey: supabaseServiceRoleKey,
                  Authorization: `Bearer ${supabaseServiceRoleKey}`,
                },
                body: JSON.stringify({
                  user_metadata: {
                    ...currentMetadata,
                    enterprise_interest: false,
                    enterprise_dismissed_by: "saphaarelabs@gmail.com",
                    enterprise_dismissed_at: new Date().toISOString(),
                  },
                }),
              });

              if (!updateResponse.ok) {
                sendJson(res, 500, { error: "Failed to update user interest" });
                return;
              }

              sendJson(res, 200, { success: true });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/purchase-minutes", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const { userId, purchase_amount, rate_per_minute } = await readJsonBody(req);

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!userId || purchase_amount == null) {
                sendJson(res, 400, { error: "userId and purchase_amount are required" });
                return;
              }

              const purchaseAmount = Number(purchase_amount);
              const ratePerMinute = Number(rate_per_minute ?? DEFAULT_RATE_PER_MINUTE);
              const credit = await creditLocalEnterpriseMinutes(
                supabaseUrl,
                supabaseServiceRoleKey,
                userId,
                ratePerMinute,
                purchaseAmount,
              );

              await fetch(`${supabaseUrl}/rest/v1/minute_transactions?user_id=eq.${encodeURIComponent(userId)}&kind=eq.enterprise_credit&amount=eq.${purchaseAmount}&seconds_delta=eq.${credit.creditedSeconds}`, {
                method: "PATCH",
                headers: {
                  "Content-Type": "application/json",
                  apikey: supabaseServiceRoleKey,
                  Authorization: `Bearer ${supabaseServiceRoleKey}`,
                  Prefer: "return=minimal",
                },
                body: JSON.stringify({
                  kind: "direct_purchase",
                  source: "standard",
                  notes: "Direct plan purchase",
                }),
              });

              sendJson(res, 200, { success: true, credit });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/user-settings-profile", async (req, res) => {
            const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
            const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

            if (!supabaseUrl || !supabaseServiceRoleKey) {
              sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
              return;
            }

            const headers = {
              apikey: supabaseServiceRoleKey,
              Authorization: `Bearer ${supabaseServiceRoleKey}`,
            };

            try {
              const body = req.method === "GET" ? {} : await readJsonBody(req);
              const url = new URL(req.url || "", "http://localhost");
              const userId = String(
                req.method === "GET" ? url.searchParams.get("userId") || "" : body?.userId || "",
              ).trim();
              const userEmail = String(
                req.method === "GET" ? url.searchParams.get("userEmail") || "" : body?.userEmail || "",
              ).trim().toLowerCase();

              if (!userId) {
                sendJson(res, 400, { error: "userId is required" });
                return;
              }

              if (req.method === "POST") {
                const payload = body?.payload;
                if (!payload || typeof payload !== "object") {
                  sendJson(res, 400, { error: "payload is required" });
                  return;
                }

                const response = await fetch(`${supabaseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}`, {
                  method: "PATCH",
                  headers: {
                    ...headers,
                    Prefer: "return=representation",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(payload),
                });

                const updatedRows = await response.json().catch(() => []);
                if (!response.ok) {
                  sendJson(res, 500, { error: "Failed to update profile", details: updatedRows });
                  return;
                }

                if (Array.isArray(updatedRows) && updatedRows.length > 0) {
                  sendJson(res, 200, { profile: updatedRows[0] });
                  return;
                }

                const insertResponse = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
                  method: "POST",
                  headers: {
                    ...headers,
                    Prefer: "return=representation",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    user_id: userId,
                    ...payload,
                  }),
                });
                const insertedRows = await insertResponse.json().catch(() => []);
                if (!insertResponse.ok) {
                  sendJson(res, 500, { error: "Failed to insert profile", details: insertedRows });
                  return;
                }

                sendJson(res, 200, { profile: Array.isArray(insertedRows) ? insertedRows[0] || null : insertedRows });
                return;
              }

              if (req.method !== "GET") {
                sendJson(res, 405, { error: "Method not allowed" });
                return;
              }

              const relatedUserIds = await resolveRelatedUserIds(
                supabaseUrl,
                supabaseServiceRoleKey,
                userId,
                userEmail,
              );

              const orClause = relatedUserIds.map((id) => `user_id.eq.${id}`).join(",");
              const response = await fetch(
                `${supabaseUrl}/rest/v1/profiles?select=*&or=(${orClause})`,
                { headers },
              );
              const rows = await response.json().catch(() => []);

              if (!response.ok) {
                sendJson(res, 500, { error: "Failed to load profile", details: rows });
                return;
              }

              const profiles = Array.isArray(rows) ? rows : [];
              const profile =
                profiles.find((row: any) => row?.user_id === userId) ||
                profiles[0] ||
                null;

              sendJson(res, 200, {
                profile,
                relatedUserIds,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/agent-crm-data", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const action = String(body?.action || "").trim();
              const agentId = String(body?.agentId || "").trim();
              const userId = String(body?.userId || "").trim();
              const userEmail = String(body?.userEmail || "").trim().toLowerCase();

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!agentId || !userId) {
                sendJson(res, 400, { error: "agentId and userId are required" });
                return;
              }

              const headers = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };

              if (action === "load") {
                const relatedUserIds = await resolveRelatedUserIds(
                  supabaseUrl,
                  supabaseServiceRoleKey,
                  userId,
                  userEmail,
                );
                const userIdList = relatedUserIds.map((id) => `"${id}"`).join(",");

                const [agentResponse, integrationsResponse] = await Promise.all([
                  fetch(
                    `${supabaseUrl}/rest/v1/agents?id=eq.${encodeURIComponent(agentId)}&select=gmail_body_template,custom_crm_providers,use_google_docs`,
                    { headers },
                  ),
                  fetch(
                    `${supabaseUrl}/rest/v1/calendar_integrations?select=id,provider,display_name&provider=in.(gmail,google_docs,google_sheets)&user_id=in.(${userIdList})&order=created_at.asc`,
                    { headers },
                  ),
                ]);

                const [agentPayload, integrationsPayload] = await Promise.all([
                  agentResponse.json().catch(() => []),
                  integrationsResponse.json().catch(() => []),
                ]);

                if (!agentResponse.ok) {
                  sendJson(res, 500, { error: "Failed to load agent CRM data", details: agentPayload });
                  return;
                }
                if (!integrationsResponse.ok) {
                  sendJson(res, 500, { error: "Failed to load CRM integrations", details: integrationsPayload });
                  return;
                }

                sendJson(res, 200, {
                  agent: Array.isArray(agentPayload) ? agentPayload[0] || null : agentPayload,
                  integrations: Array.isArray(integrationsPayload) ? integrationsPayload : [],
                });
                return;
              }

              if (action === "updateProviders") {
                const providerIds = Array.isArray(body?.providerIds)
                  ? body.providerIds.filter((value: unknown): value is string => typeof value === "string")
                  : [];

                const response = await fetch(
                  `${supabaseUrl}/rest/v1/agents?id=eq.${encodeURIComponent(agentId)}`,
                  {
                    method: "PATCH",
                    headers: {
                      ...headers,
                      Prefer: "return=representation",
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      custom_crm_providers: providerIds,
                      use_google_docs: providerIds.includes("google_docs"),
                    }),
                  },
                );
                const payload = await response.json().catch(() => []);
                if (!response.ok) {
                  sendJson(res, 500, { error: "Failed to update CRM providers", details: payload });
                  return;
                }
                sendJson(res, 200, { agent: Array.isArray(payload) ? payload[0] || null : payload });
                return;
              }

              if (action === "updateTemplate") {
                const gmailBodyTemplate = String(body?.gmail_body_template || "");
                const response = await fetch(
                  `${supabaseUrl}/rest/v1/agents?id=eq.${encodeURIComponent(agentId)}`,
                  {
                    method: "PATCH",
                    headers: {
                      ...headers,
                      Prefer: "return=representation",
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      gmail_body_template: gmailBodyTemplate,
                    }),
                  },
                );
                const payload = await response.json().catch(() => []);
                if (!response.ok) {
                  sendJson(res, 500, { error: "Failed to update gmail body template", details: payload });
                  return;
                }
                sendJson(res, 200, { agent: Array.isArray(payload) ? payload[0] || null : payload });
                return;
              }

              sendJson(res, 400, { error: "Unsupported action" });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/forwarding-numbers", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const action = String(body?.action || "").trim();
              const agentId = String(body?.agentId || "").trim();
              const userId = String(body?.userId || "").trim();
              const userEmail = String(body?.userEmail || "").trim().toLowerCase();
              const forwardingId = String(body?.forwardingId || "").trim();
              const phoneNumber = String(body?.phoneNumber || "").trim();
              const label = typeof body?.label === "string" ? body.label.trim() : "";
              const priority = Number(body?.priority ?? 0);

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!agentId || !userId) {
                sendJson(res, 400, { error: "agentId and userId are required" });
                return;
              }

              const headers = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };

              if (action === "add") {
                if (!phoneNumber) {
                  sendJson(res, 400, { error: "phoneNumber is required" });
                  return;
                }

                const response = await fetch(`${supabaseUrl}/rest/v1/call_forwarding_numbers`, {
                  method: "POST",
                  headers: {
                    ...headers,
                    Prefer: "return=representation",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    agent_id: agentId,
                    user_id: userId,
                    phone_number: phoneNumber,
                    label: label || null,
                    priority: Number.isFinite(priority) ? priority : 0,
                  }),
                });
                const payload = await response.json().catch(() => []);
                if (!response.ok) {
                  sendJson(res, 500, { error: "Failed to add forwarding number", details: payload });
                  return;
                }

                sendJson(res, 200, {
                  forwardingNumber: Array.isArray(payload) ? payload[0] || null : payload,
                });
                return;
              }

              if (action === "delete") {
                if (!forwardingId) {
                  sendJson(res, 400, { error: "forwardingId is required" });
                  return;
                }

                const relatedUserIds = await resolveRelatedUserIds(
                  supabaseUrl,
                  supabaseServiceRoleKey,
                  userId,
                  userEmail,
                );
                const userIdList = relatedUserIds.map((id) => `"${id}"`).join(",");

                const response = await fetch(
                  `${supabaseUrl}/rest/v1/call_forwarding_numbers?id=eq.${encodeURIComponent(forwardingId)}&agent_id=eq.${encodeURIComponent(agentId)}&user_id=in.(${userIdList})`,
                  {
                    method: "DELETE",
                    headers: { ...headers, Prefer: "return=minimal" },
                  },
                );
                if (!response.ok) {
                  const payload = await response.json().catch(() => ({}));
                  sendJson(res, 500, { error: "Failed to delete forwarding number", details: payload });
                  return;
                }

                sendJson(res, 200, { success: true });
                return;
              }

              sendJson(res, 400, { error: "Unsupported action" });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/training-sessions", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const action = String(body?.action || "load").trim();
              const userId = String(body?.userId || "").trim();
              const userEmail = String(body?.userEmail || "").trim().toLowerCase();

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!userId && !userEmail) {
                sendJson(res, 400, { error: "userId or userEmail is required" });
                return;
              }

              const headers = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };

              if (action === "upsert") {
                const sessionId = String(body?.sessionId || "").trim();
                const payload = body?.payload;

                if (!sessionId || !payload || typeof payload !== "object") {
                  sendJson(res, 400, { error: "sessionId and payload are required" });
                  return;
                }

                const patchResponse = await fetch(
                  `${supabaseUrl}/rest/v1/training_sessions?id=eq.${encodeURIComponent(sessionId)}`,
                  {
                    method: "PATCH",
                    headers: {
                      ...headers,
                      Prefer: "return=representation",
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(payload),
                  },
                );
                const patchPayload = await patchResponse.json().catch(() => []);

                if (!patchResponse.ok) {
                  sendJson(res, 500, { error: "Failed to update training session", details: patchPayload });
                  return;
                }

                if (Array.isArray(patchPayload) && patchPayload.length > 0) {
                  sendJson(res, 200, { session: patchPayload[0] });
                  return;
                }

                const insertResponse = await fetch(`${supabaseUrl}/rest/v1/training_sessions`, {
                  method: "POST",
                  headers: {
                    ...headers,
                    Prefer: "return=representation",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    id: sessionId,
                    user_id: userId,
                    ...payload,
                  }),
                });
                const insertPayload = await insertResponse.json().catch(() => []);

                if (!insertResponse.ok) {
                  sendJson(res, 500, { error: "Failed to insert training session", details: insertPayload });
                  return;
                }

                sendJson(res, 200, { session: Array.isArray(insertPayload) ? insertPayload[0] || null : insertPayload });
                return;
              }

              const relatedUserIds = await resolveRelatedUserIds(
                supabaseUrl,
                supabaseServiceRoleKey,
                userId,
                userEmail,
              );

              if (relatedUserIds.length === 0) {
                sendJson(res, 200, { sessions: [], missingTable: false });
                return;
              }

              const userIdList = relatedUserIds.map((id) => `"${id}"`).join(",");
              const response = await fetch(
                `${supabaseUrl}/rest/v1/training_sessions?select=*&user_id=in.(${userIdList})&order=completed_at.desc.nullslast,started_at.desc`,
                { headers },
              );
              const payload = await response.json().catch(() => []);

              if (!response.ok) {
                const message =
                  (payload && typeof payload === "object" && !Array.isArray(payload) && (((payload as any).message as string) || ((payload as any).error as string))) ||
                  "";
                if (response.status === 404 || message.toLowerCase().includes("training_sessions")) {
                  sendJson(res, 200, { sessions: [], missingTable: true });
                  return;
                }

                sendJson(res, 500, { error: message || "Failed to load training sessions", details: payload });
                return;
              }

              sendJson(res, 200, {
                sessions: Array.isArray(payload) ? payload : [],
                missingTable: false,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });

          server.middlewares.use("/api/local/firebrand-history", async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }

            try {
              const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
              const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
              const body = await readJsonBody(req);
              const userId = String(body?.userId || "").trim();
              const userEmail = String(body?.userEmail || "").trim().toLowerCase();

              if (!supabaseUrl || !supabaseServiceRoleKey) {
                sendJson(res, 500, { error: "Supabase service role credentials are not configured" });
                return;
              }
              if (!userId && !userEmail) {
                sendJson(res, 400, { error: "userId or userEmail is required" });
                return;
              }

              const headers = {
                apikey: supabaseServiceRoleKey,
                Authorization: `Bearer ${supabaseServiceRoleKey}`,
              };

              const relatedUserIds = await resolveRelatedUserIds(
                supabaseUrl,
                supabaseServiceRoleKey,
                userId,
                userEmail,
              );

              if (relatedUserIds.length === 0) {
                sendJson(res, 200, { practiceLogs: [], agentLogs: [], trainingSessions: [] });
                return;
              }

              const userIdList = relatedUserIds.map((id) => `"${id}"`).join(",");

              const [callLogsResponse, trainingSessionsResponse] = await Promise.all([
                fetch(
                  `${supabaseUrl}/rest/v1/call_logs?select=*&user_id=in.(${userIdList})&direction=eq.demo&caller_number=eq.training-browser-demo&order=started_at.desc`,
                  { headers },
                ),
                fetch(
                  `${supabaseUrl}/rest/v1/training_sessions?select=*&user_id=in.(${userIdList})&order=completed_at.desc.nullslast,started_at.desc`,
                  { headers },
                ),
              ]);

              const [callLogsPayload, trainingSessionsPayload] = await Promise.all([
                callLogsResponse.json().catch(() => []),
                trainingSessionsResponse.json().catch(() => []),
              ]);

              if (!callLogsResponse.ok) {
                sendJson(res, 500, { error: "Failed to load firebrand call logs", details: callLogsPayload });
                return;
              }
              if (!trainingSessionsResponse.ok) {
                const message =
                  (trainingSessionsPayload && typeof trainingSessionsPayload === "object" && !Array.isArray(trainingSessionsPayload) && (((trainingSessionsPayload as any).message as string) || ((trainingSessionsPayload as any).error as string))) ||
                  "";
                if (trainingSessionsResponse.status !== 404 && !message.toLowerCase().includes("training_sessions")) {
                  sendJson(res, 500, { error: "Failed to load training sessions", details: trainingSessionsPayload });
                  return;
                }
              }

              const callLogs = Array.isArray(callLogsPayload) ? callLogsPayload : [];
              const practiceLogs = callLogs.filter((row: any) => {
                const source = String(row?.billing_source || "").toLowerCase();
                const summary = String(row?.summary || "").toLowerCase();
                return source !== "firebrand_agent" && !summary.startsWith("firebrand agent:");
              });
              const agentLogs = callLogs.filter((row: any) => {
                const source = String(row?.billing_source || "").toLowerCase();
                const summary = String(row?.summary || "").toLowerCase();
                return source === "firebrand_agent" || summary.startsWith("firebrand agent:");
              });

              sendJson(res, 200, {
                practiceLogs,
                agentLogs,
                trainingSessions: Array.isArray(trainingSessionsPayload) ? trainingSessionsPayload : [],
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: message });
            }
          });
        },
      },
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
