import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-local-user-id",
};

type TemplateComponent = {
  type?: string;
  format?: string;
  text?: string;
  example?: {
    body_text_named_params?: Array<{
      param_name?: string;
      example?: string;
    }>;
    header_handle?: string[];
  };
  buttons?: Array<{
    type?: string;
    text?: string;
    url?: string;
    phone_number?: string;
  }>;
  cards?: unknown[];
  [key: string]: unknown;
};

type CarouselButtonInput = {
  type?: string;
  text?: string;
  value?: string;
  url?: string;
  phone_number?: string;
};

type CarouselCardInput = {
  headerHandle?: string;
  bodyText?: string;
  buttons?: CarouselButtonInput[];
};

type TemplateStructureInput = {
  name?: string;
  previous_category?: string;
  parameter_format?: string;
  components?: TemplateComponent[];
  language?: string;
  status?: string;
  category?: string;
  id?: string;
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

async function getAuthenticatedUser(req: Request) {
  const localUserId = (Deno.env.get("ALLOW_LOCAL_USER_HEADER") === "true" ? (req.headers.get("x-local-user-id") || "").trim() : "");
  if (localUserId) {
    const { data: profile, error } = await admin
      .from("profiles")
      .select("user_id, id")
      .or(`user_id.eq.${localUserId},id.eq.${localUserId}`)
      .maybeSingle();

    if (error || !profile) return null;

    const { data: userData } = await admin.auth.admin.getUserById(profile.user_id);
    return {
      id: profile.user_id,
      email: userData.user?.email ?? null,
    };
  }

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;

  return {
    id: data.user.id,
    email: data.user.email ?? null,
  };
}

async function canReadTable(tableName: string) {
  const { error } = await admin.from(tableName).select("*", { head: true, count: "exact" }).limit(1);
  return !error;
}

function normalizeTemplateName(name: string) {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

  return normalized.slice(0, 512);
}

function buildRetryTemplateName(baseName: string) {
  const suffix = `carousel_${Date.now().toString().slice(-6)}`;
  return normalizeTemplateName(`${baseName}_${suffix}`);
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

function extractTemplateParameters(value: string) {
  return Array.from(value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g), (match) => match[1]?.trim())
    .filter((token): token is string => Boolean(token))
    .filter((token, index, values) => values.indexOf(token) === index);
}

function isNumericTemplateParameter(value: string) {
  return /^\d+$/.test(value.trim());
}

function buildNamedParameterExamples(bodyText: string) {
  const tokens = extractTemplateParameters(bodyText)
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

function normalizeCarouselButton(button: CarouselButtonInput) {
  const type = String(button?.type ?? "").trim().toLowerCase();
  const normalizedButton: Record<string, unknown> = {
    type,
    text: String(button?.text ?? "").trim(),
  };

  const value = String(button?.value ?? "").trim();
  const explicitUrl = String(button?.url ?? "").trim();
  const explicitPhoneNumber = String(button?.phone_number ?? "").trim();

  if (type === "url") {
    if (explicitUrl) normalizedButton.url = explicitUrl;
    else if (value) normalizedButton.url = value;
  }

  if (type === "phone_number") {
    if (explicitPhoneNumber) normalizedButton.phone_number = explicitPhoneNumber;
    else if (value) normalizedButton.phone_number = value;
  }

  return normalizedButton;
}

function isValidCarouselButton(button: CarouselButtonInput) {
  const type = String(button?.type ?? "").trim().toLowerCase();
  const text = String(button?.text ?? "").trim();
  const value = String(button?.value ?? "").trim();
  const explicitUrl = String(button?.url ?? "").trim();
  const explicitPhoneNumber = String(button?.phone_number ?? "").trim();

  if (!text) return false;
  if (type === "quick_reply") return text.length <= 25;
  if (type === "url") return Boolean(explicitUrl || value);
  if (type === "phone_number") return Boolean(explicitPhoneNumber || value);
  return false;
}

function buildCarouselComponents(mainBody: string, cards: CarouselCardInput[]): TemplateComponent[] {
  return [
    {
      type: "BODY",
      text: mainBody,
      example: buildNamedParameterExamples(mainBody),
    },
    {
      type: "CAROUSEL",
      cards: cards.map((card) => {
        const cardBodyText = String(card?.bodyText ?? "").trim();
        const headerHandleValue = String(card?.headerHandle ?? "").trim();
        const cardComponents: TemplateComponent[] = [
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
            example: buildNamedParameterExamples(cardBodyText),
          },
          {
            type: "BUTTONS",
            buttons: Array.isArray(card?.buttons) ? card.buttons.map(normalizeCarouselButton) : [],
          },
        ];

        return {
          components: cardComponents,
        };
      }),
    },
  ];
}

function mapMetaButtonTypeForStorage(value: string) {
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

function parseTemplateDetails(components: TemplateComponent[]) {
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
  const buttonTypes = rawButtons.map((button) => mapMetaButtonTypeForStorage(String(button?.type ?? "").trim().toLowerCase()));
  const buttons = rawButtons.map((button) => {
    const originalType = String(button?.type ?? "").trim().toLowerCase();
    const mappedType = mapMetaButtonTypeForStorage(originalType);

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
    parameterTokens: extractTemplateParameters(bodyText),
    carouselCards: Array.isArray(carouselComponent?.cards) ? carouselComponent.cards : [],
    templateType: carouselComponent ? "carousel" : "standard",
  };
}

function buildMetaRequestBody(
  normalizedName: string,
  language: string,
  category: string,
  components: TemplateComponent[],
  headerHandle?: string,
) {
  const isCarouselTemplate = components.some(
    (component) => String(component.type ?? "").trim().toUpperCase() === "CAROUSEL",
  );
  const effectiveCategory = isCarouselTemplate ? "MARKETING" : category.toUpperCase();
  const requestComponents = components.map((component) => {
    const normalizedComponent: Record<string, unknown> = {
      ...component,
      type: String(component.type ?? "").trim().toUpperCase(),
    };

    if (normalizedComponent.type === "BODY") {
      const bodyText = String(component.text ?? "").trim();
      const requestExample =
        component.example && typeof component.example === "object"
          ? component.example
          : buildNamedParameterExamples(bodyText);

      if (requestExample) {
        normalizedComponent.example = requestExample;
      }
    }

    if (normalizedComponent.type === "BUTTONS" && Array.isArray(component.buttons)) {
      normalizedComponent.buttons = component.buttons.map((button) => {
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

  const body: Record<string, unknown> = {
    name: normalizedName,
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

  return body;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { success: false, error: "Method not allowed" });

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return json(401, { success: false, error: "Unauthorized" });
    }

    const requestBody = await req.json();
    console.log("[create-whatsapp-template] received", JSON.stringify(requestBody, null, 2));

    const structure = (requestBody?.structure && typeof requestBody.structure === "object"
      ? requestBody.structure
      : null) as TemplateStructureInput | null;
    const name = String(structure?.name ?? requestBody?.name ?? "").trim();
    const language = String(structure?.language ?? requestBody?.language ?? "").trim();
    const category = String(structure?.category ?? requestBody?.category ?? "").trim();
    const headerHandle = String(requestBody?.headerHandle ?? "").trim();
    const mainBody = String(requestBody?.mainBody ?? "").trim();
    const cards = Array.isArray(requestBody?.cards) ? (requestBody.cards as CarouselCardInput[]) : [];
    const components = Array.isArray(structure?.components)
      ? (structure.components as TemplateComponent[])
      : Array.isArray(requestBody?.components)
      ? (requestBody.components as TemplateComponent[])
      : cards.length > 0
        ? buildCarouselComponents(mainBody, cards)
        : [];

    if (!name || !language || !category || components.length === 0) {
      return json(400, {
        success: false,
        error: "Missing required fields",
        message: "Please provide name, language, category, and components array",
      });
    }

    if (cards.length > 0) {
      if (!mainBody) {
        return json(400, {
          success: false,
          error: "Missing required fields",
          message: "Carousel templates require mainBody.",
        });
      }

      if (cards.length > 10) {
        return json(400, {
          success: false,
          error: "Too many cards",
          message: "Carousel templates support a maximum of 10 cards.",
        });
      }

      for (const [index, card] of cards.entries()) {
        const headerHandleValue = String(card?.headerHandle ?? "").trim();
        const bodyTextValue = String(card?.bodyText ?? "").trim();
        const buttonList = Array.isArray(card?.buttons) ? card.buttons : [];

        if (!headerHandleValue || !bodyTextValue || buttonList.length === 0) {
          return json(400, {
            success: false,
            error: "Invalid carousel card",
            message: `Carousel card ${index + 1} must include an uploaded image handle, bodyText, and at least one button.`,
          });
        }

        if (buttonList.length > 2) {
          return json(400, {
            success: false,
            error: "Too many buttons",
            message: `Carousel card ${index + 1} supports a maximum of 2 buttons.`,
          });
        }

        if (buttonList.some((button) => !isValidCarouselButton(button))) {
          return json(400, {
            success: false,
            error: "Invalid carousel button",
            message: `Carousel card ${index + 1} has an incomplete button. URL and phone buttons require a value, and quick replies must be 25 characters or fewer.`,
          });
        }
      }
    }

    const normalizedName = normalizeTemplateName(name);
    if (!normalizedName) {
      return json(400, {
        success: false,
        error: "Invalid name",
        message: "Template name must contain letters or numbers after normalization.",
      });
    }
    let finalNormalizedName = normalizedName;

    const templateDetails = parseTemplateDetails(components);
    if (templateDetails.parameterTokens.some(isNumericTemplateParameter)) {
      return json(400, {
        success: false,
        error: "Invalid parameter format",
        message: "Use named placeholders like {{order_number}} instead of numeric placeholders like {{1}}.",
      });
    }
    const hasWhatsappApiConfigs = await canReadTable("whatsapp_api_configs");
    const hasWhatsappTemplates = await canReadTable("whatsapp_templates");
    const hasLegacyUserDetails = await canReadTable("User_details");
    const hasLegacyTemplates = await canReadTable("Templates");

    let metaAccessToken: string | null = null;
    let metaBusinessAccountId: string | null = null;

    if (hasWhatsappApiConfigs) {
      const { data: config, error } = await admin
        .from("whatsapp_api_configs")
        .select("meta_access_token, meta_business_account_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!error && config) {
        metaAccessToken = config.meta_access_token;
        metaBusinessAccountId = config.meta_business_account_id;
      }
    }

    if ((!metaAccessToken || !metaBusinessAccountId) && hasLegacyUserDetails && user.email) {
      const { data: legacyConfig, error: legacyError } = await admin
        .from("User_details")
        .select("meta_access_token, meta_business_account_id")
        .eq("email", user.email)
        .maybeSingle();

      if (legacyError) {
        console.error("[create-whatsapp-template] legacy credential lookup failed", legacyError);
      } else if (legacyConfig) {
        metaAccessToken = legacyConfig.meta_access_token;
        metaBusinessAccountId = legacyConfig.meta_business_account_id;
      }
    }

    if (!metaAccessToken || !metaBusinessAccountId) {
      return json(400, {
        success: false,
        error: "Missing credentials",
        message: "Add your WhatsApp API credentials first: open your account (your name at the bottom of the sidebar) > Integrations > WhatsApp API.",
      });
    }

    let metaRequestBody = buildMetaRequestBody(
      finalNormalizedName,
      language,
      category,
      components,
      headerHandle || undefined,
    );

    console.log("[create-whatsapp-template] meta request", JSON.stringify(metaRequestBody, null, 2));

    let metaResponse = await fetch(
      `https://graph.facebook.com/v22.0/${metaBusinessAccountId}/message_templates`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${metaAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(metaRequestBody),
      },
    );

    let responseData = await metaResponse.json().catch(() => ({}));
    let renamedFrom: string | null = null;
    if (!metaResponse.ok && shouldRetryCarouselNameConflict(responseData, cards)) {
      renamedFrom = finalNormalizedName;
      finalNormalizedName = buildRetryTemplateName(finalNormalizedName);
      metaRequestBody = buildMetaRequestBody(
        finalNormalizedName,
        language,
        category,
        components,
        headerHandle || undefined,
      );
      metaResponse = await fetch(
        `https://graph.facebook.com/v22.0/${metaBusinessAccountId}/message_templates`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${metaAccessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(metaRequestBody),
        },
      );
      responseData = await metaResponse.json().catch(() => ({}));
    }
    console.log("[create-whatsapp-template] meta response", JSON.stringify(responseData, null, 2));

    if (!metaResponse.ok) {
      const detailedMessage =
        responseData?.error?.error_user_msg ||
        responseData?.error?.error_user_title ||
        responseData?.error?.error_data?.details ||
        responseData?.error?.message ||
        "Failed to create template";
      return json(metaResponse.status, {
        success: false,
        error: "Meta API error",
        message: detailedMessage,
        details: responseData,
      });
    }

    const persistedCategory = templateDetails.templateType === "carousel" ? "MARKETING" : category.toUpperCase();

    let dbError: { message?: string } | null = null;
    let savedLocally = false;

    if (hasWhatsappTemplates) {
      const { error } = await admin.from("whatsapp_templates").insert({
        user_id: user.id,
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
      savedLocally = !error;
    } else if (hasLegacyTemplates) {
      const { error } = await admin.from("Templates").insert({
        user_email: user.email,
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
      savedLocally = !error;
    }

    if (dbError) {
      console.error("[create-whatsapp-template] save failed", dbError);
      return json(200, {
        success: true,
        templateId: responseData?.id,
        status: responseData?.status,
        category: responseData?.category,
        normalizedName: finalNormalizedName,
        message: `Template created in Meta but failed to save locally. ${dbError.message || "Please refresh the page."}`,
        warning: "Database save failed",
      });
    }

    if (!savedLocally) {
      return json(200, {
        success: true,
        templateId: responseData?.id,
        status: responseData?.status,
        category: responseData?.category,
        normalizedName: finalNormalizedName,
        message: "Template created in Meta, but no local templates table is available in this project yet.",
        warning: "Local save skipped",
      });
    }

    return json(200, {
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
        previous_category: String(responseData?.category ?? persistedCategory).toUpperCase(),
        parameter_format: "NAMED",
        components,
        language,
        status: String(responseData?.status ?? ""),
        category: String(responseData?.category ?? category).toUpperCase(),
        id: String(responseData?.id ?? ""),
      },
    });
  } catch (error) {
    console.error("[create-whatsapp-template]", error);
    return json(500, {
      success: false,
      error: "Template creation failed",
      message: error instanceof Error ? error.message : "An unexpected error occurred",
    });
  }
});
