import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  BadgeCheck,
  ChevronDown,
  Circle,
  Download,
  Eye,
  FileImage,
  FileText,
  LayoutGrid,
  Megaphone,
  MousePointerClick,
  MoreVertical,
  PanelTop,
  Pencil,
  Plus,
  RefreshCcw,
  Sparkles,
  TableProperties,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import ChannelSelect from "@/components/ChannelSelect";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supportsWhatsappTable } from "@/lib/whatsapp-compat";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { generateText } from "@/lib/analysis";
import { getErrorMessage, isEdgeFunctionUnavailable } from "@/lib/edge-functions";

const tabClassName =
  "relative z-10 flex items-center justify-center gap-2 rounded-[18px] px-4 py-1.5 text-[14px] font-medium text-[#6b7280] transition-colors duration-300 ease-out data-[state=active]:text-[#1f2635]";

type WhatsAppTemplateRecord = {
  id: string;
  type: "standard" | "carousel";
  name: string;
  normalizedName: string;
  metaTemplateId?: string;
  body: string;
  category: string;
  language: string;
  footerText: string;
  buttonCount: number;
  status: "approved" | "pending" | "failed";
  createdAtLabel: string;
};

type WhatsAppTemplateDetailComponent = {
  type?: string;
  format?: string;
  text?: string;
  example?: {
    header_handle?: string[];
    header_url?: string[];
  };
  buttons?: Array<{
    type?: string;
    text?: string;
    url?: string;
    phone_number?: string;
  }>;
  cards?: Array<{
    components?: WhatsAppTemplateDetailComponent[];
  }>;
};

type WhatsAppTemplateDetailParameter = {
  index: number;
  placeholder: string;
  name: string;
};

type WhatsAppTemplateDetailCard = {
  index: number;
  hasHeader: boolean;
  headerFormat: string | null;
  headerMediaId: string | null;
  headerImageUrl: string | null;
  bodyText: string | null;
  bodyParameters: WhatsAppTemplateDetailParameter[];
  hasButtons: boolean;
  buttons: Array<{
    type?: string;
    text?: string;
    url?: string;
    phone_number?: string;
  }>;
};

type WhatsAppTemplateDetailStructure = {
  name: string;
  language: string;
  hasHeader: boolean;
  headerType: string | null;
  headerHandleId: string | null;
  headerImageUrl?: string | null;
  bodyParameters: WhatsAppTemplateDetailParameter[];
  hasCarousel: boolean;
  carouselCards: WhatsAppTemplateDetailCard[];
  previewBody?: string;
  components: WhatsAppTemplateDetailComponent[];
};

function isHiddenMetaSampleTemplate(name: string, normalizedName?: string | null) {
  const normalized = String(normalizedName ?? name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");

  return normalized === "hello_world";
}

type CampaignAudienceRecord = {
  id: string;
  name: string;
  sampleFirstName?: string;
  memberCount?: number;
};

type CampaignRecord = {
  id: string;
  name: string;
  description: string;
  audienceId?: string;
  templateId?: string;
  audienceName: string;
  templateName: string;
  status: "draft" | "active" | "completed" | "failed";
  totalContacts: number;
  sentCount: number;
  failedCount: number;
  startedAtLabel: string | null;
  completedAtLabel: string | null;
};

type CampaignStatusFilter = "all" | "draft" | "active" | "paused" | "completed";

type TemplateButtonType = "visit_website" | "call_phone" | "quick_message";

type TemplateComponentPayload = {
  type: string;
  format?: string;
  text?: string;
  example?: {
    body_text_named_params?: Array<{
      param_name: string;
      example: string;
    }>;
    header_handle?: string[];
  };
  buttons?: Array<{
    type: string;
    text: string;
    url?: string;
    phone_number?: string;
  }>;
  cards?: Array<{
    components: TemplateComponentPayload[];
  }>;
};

type CarouselButtonKind = "quick_reply" | "url" | "phone_number";

type CarouselButtonDraft = {
  id: string;
  type: CarouselButtonKind;
  text: string;
  value: string;
};

type CarouselCardDraft = {
  id: string;
  headerHandle: string;
  imagePreviewUrl: string;
  imageName: string;
  bodyText: string;
  buttons: CarouselButtonDraft[];
};

type AiToneOption = "formal" | "friendly" | "promotional" | "urgent" | "professional";

type AiTemplateButtonKind = "quick_reply" | "url" | "phone_number";
type AiHeaderType = "text" | "image";

type AiStandardTemplateResponse = {
  templateName?: string;
  category?: string;
  language?: string;
  headerText?: string;
  body?: string;
  footerText?: string;
  includeCallPermissionRequest?: boolean;
  buttons?: Array<{
    type?: string;
    text?: string;
  }>;
};

type AiCarouselTemplateResponse = {
  templateName?: string;
  category?: string;
  language?: string;
  mainBody?: string;
  cards?: Array<{
    bodyText?: string;
    buttons?: Array<{
      type?: string;
      text?: string;
      value?: string;
    }>;
  }>;
};

type AiCarouselCardDraft = {
  id: string;
  imagePreviewUrl: string;
  imageName: string;
  topicHint: string;
  buttonTexts: Partial<Record<AiTemplateButtonKind, string>>;
};

type TemplateStructurePayload = {
  name: string;
  previous_category?: string;
  parameter_format: "NAMED";
  components: TemplateComponentPayload[];
  language: string;
  status?: string;
  category: string;
  id?: string;
};

const templateButtonOptions: Array<{
  type: TemplateButtonType;
  label: string;
  chipClassName: string;
  previewClassName: string;
}> = [
  {
    type: "visit_website",
    label: "Visit Website",
    chipClassName: "bg-[#eef4ff] text-[#2563eb]",
    previewClassName: "border-[#d7e3ff] text-[#2563eb]",
  },
  {
    type: "call_phone",
    label: "Call Phone",
    chipClassName: "bg-[#eefbf1] text-[#16a34a]",
    previewClassName: "border-[#d7f2de] text-[#16a34a]",
  },
  {
    type: "quick_message",
    label: "Quick Message",
    chipClassName: "bg-[#fafafa] text-[#171717]",
    previewClassName: "border-[#f4f4f5] text-[#171717]",
  },
];

const defaultTemplateButtonLabels = templateButtonOptions.reduce<Record<TemplateButtonType, string>>(
  (labels, option) => {
    labels[option.type] = option.label;
    return labels;
  },
  {
    visit_website: "Visit Website",
    call_phone: "Call Phone",
    quick_message: "Quick Message",
  },
);

const shouldUseLocalCampaignBackend = () =>
  typeof window !== "undefined" && /^(127\.0\.0\.1|localhost)$/i.test(window.location.hostname);

const aiToneOptions: Array<{ value: AiToneOption; label: string }> = [
  { value: "formal", label: "Formal" },
  { value: "friendly", label: "Friendly" },
  { value: "promotional", label: "Promotional" },
  { value: "urgent", label: "Urgent" },
  { value: "professional", label: "Professional" },
];

const aiLanguageOptions = [
  { value: "en_US", label: "English" },
  { value: "en_GB", label: "English (UK)" },
  { value: "hi_IN", label: "Hindi" },
] as const;

const aiButtonKindLabels: Record<AiTemplateButtonKind, string> = {
  quick_reply: "Quick Reply",
  url: "Website URL",
  phone_number: "Phone Number",
};

const createAiCarouselCardDraft = (): AiCarouselCardDraft => ({
  id: crypto.randomUUID(),
  imagePreviewUrl: "",
  imageName: "",
  topicHint: "",
  buttonTexts: {},
});

const extractTemplateParameters = (value: string) =>
  Array.from(value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g), (match) => match[1]?.trim())
    .filter((token): token is string => Boolean(token))
    .filter((token, index, values) => values.indexOf(token) === index);

const stripTemplateParameters = (value: string) => value.replace(/\{\{\s*[^}]+?\s*\}\}/g, " ");

const countNonParameterWords = (value: string) =>
  stripTemplateParameters(value)
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

const endsWithTemplateParameter = (value: string) => /\{\{\s*[^}]+\s*\}\}\s*$/.test(value.trim());
const startsWithTemplateParameter = (value: string) => /^\s*\{\{\s*[^}]+\s*\}\}/.test(value.trim());

const mapButtonTypeForMeta = (value: TemplateButtonType) => {
  switch (value) {
    case "visit_website":
      return "url";
    case "call_phone":
      return "phone_number";
    case "quick_message":
      return "quick_reply";
    default:
      return String(value).toLowerCase();
  }
};

const mapAiButtonKindToTemplateType = (value: AiTemplateButtonKind): TemplateButtonType => {
  switch (value) {
    case "url":
      return "visit_website";
    case "phone_number":
      return "call_phone";
    case "quick_reply":
    default:
      return "quick_message";
  }
};

const getTemplateButtonLabel = (
  buttonType: TemplateButtonType,
  customLabels?: Partial<Record<TemplateButtonType, string>>,
) => customLabels?.[buttonType]?.trim() || defaultTemplateButtonLabels[buttonType];

const isNumericTemplateParameter = (value: string) => /^\d+$/.test(value.trim());

const buildNamedParameterExamples = (body: string) => {
  const parameterTokens = extractTemplateParameters(body)
    .map((token) => token.trim())
    .filter(Boolean);

  if (parameterTokens.length === 0) return undefined;

  return {
    body_text_named_params: parameterTokens.map((token) => ({
      param_name: token,
      example: token
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase()) || "Example Value",
    })),
  };
};

const buildTemplateComponents = (options: {
  body: string;
  headerEnabled: boolean;
  headerText: string;
  footerEnabled: boolean;
  footerText: string;
  buttonsEnabled: boolean;
  buttonTypes: TemplateButtonType[];
  buttonLabels?: Partial<Record<TemplateButtonType, string>>;
  includeCallPermissionRequest: boolean;
}): TemplateComponentPayload[] => {
  const components: TemplateComponentPayload[] = [];
  const trimmedBody = options.body.trim();
  const trimmedHeader = options.headerText.trim();
  const trimmedFooter = options.footerText.trim();

  if (options.headerEnabled && trimmedHeader) {
    components.push({
      type: "HEADER",
      format: "TEXT",
      text: trimmedHeader,
    });
  }

  components.push({
    type: "BODY",
    text: trimmedBody,
    example: buildNamedParameterExamples(trimmedBody),
  });

  if (options.footerEnabled && trimmedFooter) {
    components.push({
      type: "FOOTER",
      text: trimmedFooter,
    });
  }

  if (options.includeCallPermissionRequest) {
    components.push({
      type: "CALL_PERMISSION_REQUEST",
    });
    return components;
  }

  if (options.buttonsEnabled && options.buttonTypes.length > 0) {
    components.push({
      type: "BUTTONS",
      buttons: options.buttonTypes.map((buttonType) => ({
        type: mapButtonTypeForMeta(buttonType),
        text: getTemplateButtonLabel(buttonType, options.buttonLabels),
      })),
    });
  }

  return components;
};

const createCarouselCard = (): CarouselCardDraft => ({
  id: crypto.randomUUID(),
  headerHandle: "",
  imagePreviewUrl: "",
  imageName: "",
  bodyText: "",
  buttons: [],
});

const createCarouselButton = (type: CarouselButtonKind): CarouselButtonDraft => ({
  id: crypto.randomUUID(),
  type,
  text:
    type === "quick_reply"
      ? "Quick Reply"
      : type === "url"
        ? "Visit Website"
        : "Call Now",
  value: "",
});

const isCarouselButtonComplete = (button: CarouselButtonDraft) => {
  const label = button.text.trim();
  if (!label) return false;
  if (button.type === "quick_reply") return label.length <= 25;
  return Boolean(button.value.trim());
};

const isCarouselCardComplete = (card: CarouselCardDraft) =>
  Boolean(
    card.headerHandle.trim() &&
    card.imagePreviewUrl.trim() &&
    card.bodyText.trim() &&
    card.buttons.length > 0 &&
    card.buttons.every(isCarouselButtonComplete),
  );

const buildCarouselTemplateComponents = (mainBody: string, cards: CarouselCardDraft[]): TemplateComponentPayload[] => [
  {
    type: "BODY",
    text: mainBody.trim(),
    example: buildNamedParameterExamples(mainBody.trim()),
  },
  {
    type: "CAROUSEL",
    cards: cards.map((card) => ({
      components: [
        {
          type: "HEADER",
          format: "IMAGE",
          ...(card.headerHandle.trim()
            ? {
                example: {
                  header_handle: [card.headerHandle.trim()],
                },
              }
            : {}),
        },
        {
          type: "BODY",
          text: card.bodyText.trim(),
          example: buildNamedParameterExamples(card.bodyText.trim()),
        },
        {
          type: "BUTTONS",
          buttons: card.buttons.map((button) => ({
            type: button.type.toLowerCase(),
            text: button.text.trim(),
            ...(button.type === "url" ? { url: button.value.trim() } : {}),
            ...(button.type === "phone_number" ? { phone_number: button.value.trim() } : {}),
          })),
        },
      ],
    })),
  },
];

const buildTemplateStructurePayload = (options: {
  name: string;
  language: string;
  category: string;
  components: TemplateComponentPayload[];
  previousCategory?: string;
  status?: string;
  id?: string;
}): TemplateStructurePayload => ({
  name: options.name,
  previous_category: options.previousCategory,
  parameter_format: "NAMED",
  components: options.components,
  language: options.language,
  status: options.status,
  category: options.category.toUpperCase(),
  id: options.id,
});

const validateTemplateForMeta = (options: {
  normalizedTemplateName: string;
  body: string;
  category: string;
  headerEnabled: boolean;
  headerText: string;
  footerEnabled: boolean;
  footerText: string;
  buttonsEnabled: boolean;
  buttonTypes: TemplateButtonType[];
  includeCallPermissionRequest: boolean;
}) => {
  const errors: string[] = [];
  const trimmedBody = options.body.trim();
  const parameterTokens = extractTemplateParameters(trimmedBody);
  const nonParameterWordCount = countNonParameterWords(trimmedBody);

  if (!options.normalizedTemplateName) {
    errors.push("Template name is required.");
  }

  if (!trimmedBody) {
    errors.push("Message body is required.");
  }

  if (trimmedBody.length < 20) {
    errors.push("Message body must be at least 20 characters.");
  }

  if (parameterTokens.length > 5) {
    errors.push("Meta allows a maximum of 5 parameters per template.");
  }

  if (parameterTokens.some(isNumericTemplateParameter)) {
    errors.push("Use named placeholders like {{order_number}} instead of numeric placeholders like {{1}}.");
  }

  if (parameterTokens.length > 0 && nonParameterWordCount < parameterTokens.length * 5) {
    errors.push("Include at least 5 non-parameter words for each body parameter.");
  }

  if (startsWithTemplateParameter(trimmedBody)) {
    errors.push("Message body cannot start with a parameter.");
  }

  if (endsWithTemplateParameter(trimmedBody)) {
    errors.push("Message body cannot end with a parameter.");
  }

  if (options.headerEnabled && !options.headerText.trim()) {
    errors.push("Header text is required when header is enabled.");
  }

  if (options.footerEnabled && !options.footerText.trim()) {
    errors.push("Footer text is required when footer is enabled.");
  }

  if (options.footerText.trim().length > 60) {
    errors.push("Footer text must be 60 characters or fewer.");
  }

  if (options.includeCallPermissionRequest && options.category !== "utility") {
    errors.push("Call permission request templates must use the Utility category.");
  }

  if (options.includeCallPermissionRequest && options.buttonsEnabled && options.buttonTypes.length > 0) {
    errors.push("Call permission request templates cannot include custom buttons.");
  }

  return errors;
};

const buildTemplateStructure = (template: WhatsAppTemplateRecord) => ({
  hasHeader: false,
  headerType: null,
  headerHandleId: null,
  bodyParameters: extractTemplateParameters(template.body),
  category: template.category,
  previewBody: template.body,
});

const getTemplateDetailComponent = (
  components: WhatsAppTemplateDetailComponent[] | undefined,
  type: string,
) => components?.find((component) => String(component.type ?? "").trim().toUpperCase() === type) ?? null;

const getTemplateDetailFooterText = (structure: WhatsAppTemplateDetailStructure | null) =>
  String(getTemplateDetailComponent(structure?.components, "FOOTER")?.text ?? "").trim();

const getTemplateDetailButtons = (structure: WhatsAppTemplateDetailStructure | null) => {
  const buttons = getTemplateDetailComponent(structure?.components, "BUTTONS")?.buttons;
  return Array.isArray(buttons) ? buttons : [];
};

const getTemplateDetailHeaderText = (structure: WhatsAppTemplateDetailStructure | null) => {
  const header = getTemplateDetailComponent(structure?.components, "HEADER");
  if (String(header?.format ?? "").trim().toUpperCase() !== "TEXT") return "";
  return String(header?.text ?? "").trim();
};

const mapLegacyTemplateType = (value: string | null | undefined): "standard" | "carousel" =>
  value === "carousel" ? "carousel" : "standard";

const mapTemplateStatus = (value: string | null | undefined): "approved" | "pending" | "failed" => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "approved") return "approved";
  if (normalized === "rejected" || normalized === "failed" || normalized === "paused") return "failed";
  return "pending";
};

const getLocalAudienceStorageKey = (userId: string) => `whatsapp-local-audiences:${userId}`;
const getLocalCampaignStorageKey = (userId: string) => `whatsapp-local-campaigns:${userId}`;
const isMissingTableError = (error: any) => {
  const code = String(error?.code ?? "").trim();
  const message = String(error?.message ?? "").toLowerCase();
  return code === "PGRST205" || code === "42P01" || message.includes("schema cache") || message.includes("does not exist");
};
const WHATSAPP_CAMPAIGN_FUNCTION_NAMES = ["send-campaign-messages", "run-whatsapp-campaign"] as const;

const getFunctionErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? "");

const isFunctionMissingError = (error: unknown) => {
  const message = getFunctionErrorMessage(error).toLowerCase();
  return message.includes("not_found") || message.includes("404") || message.includes("not found");
};

async function invokeWhatsappCampaignFunction(campaignId: string) {
  let lastError: unknown = null;

  for (const functionName of WHATSAPP_CAMPAIGN_FUNCTION_NAMES) {
    const { data, error } = await supabase.functions.invoke(functionName, {
      body: { campaign_id: campaignId },
    });

    if (!error && data?.success !== false) {
      return { data, error: null };
    }

    lastError = data?.error || error;
    if (!isFunctionMissingError(error)) {
      return { data, error: error || new Error(String(data?.error || "Failed to start WhatsApp campaign")) };
    }
  }

  return {
    data: null,
    error: lastError instanceof Error ? lastError : new Error(String(lastError || "Failed to start WhatsApp campaign")),
  };
}

const stripJsonFence = (value: string) =>
  value.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

const sanitizeTemplateName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

const formatTemplateCreateError = (payload: any, fallback = "Failed to create template") => {
  const primary = String(payload?.message || payload?.error || fallback).trim();
  const detailMessage = String(
    payload?.details?.error?.error_user_msg ||
      payload?.details?.error?.error_user_title ||
      payload?.details?.error?.error_data?.details ||
      payload?.details?.error?.message ||
      "",
  ).trim();

  if (!detailMessage || detailMessage === primary) return primary;
  return `${primary}: ${detailMessage}`;
};

const normalizeAiButtonKind = (value: string | undefined | null): AiTemplateButtonKind | null => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "quick_reply" || normalized === "quickreply" || normalized === "quick_message") return "quick_reply";
  if (normalized === "url" || normalized === "visit_website" || normalized === "website") return "url";
  if (normalized === "phone_number" || normalized === "phone" || normalized === "call_phone") return "phone_number";
  return null;
};

const buildStandardTemplateAiPrompt = (options: {
  purpose: string;
  tone: AiToneOption;
  language: string;
  buttonTypes: AiTemplateButtonKind[];
  quickReplyText: string;
  websiteButtonText: string;
  phoneButtonText: string;
  includeHeader: boolean;
  headerType: AiHeaderType;
  includeFooter: boolean;
}) => `You create WhatsApp Business message templates for Meta approval.

Generate one STANDARD WhatsApp template based on this request:
- Purpose: ${options.purpose}
- Tone: ${options.tone}
- Language: ${options.language}
- Include header: ${options.includeHeader ? "yes" : "no"}
- Header type: ${options.includeHeader ? options.headerType : "none"}
- Include footer: ${options.includeFooter ? "yes" : "no"}
- Button types requested: ${options.buttonTypes.length > 0 ? options.buttonTypes.join(", ") : "none"}
- Preferred quick reply text: ${options.quickReplyText || "not provided"}
- Preferred website button text: ${options.websiteButtonText || "not provided"}
- Preferred phone button text: ${options.phoneButtonText || "not provided"}

Requirements:
- Return ONLY valid JSON. No markdown.
- Body must be at least 20 characters.
- Use named placeholders like {{first_name}} only when genuinely useful.
- Do not start or end the body with a placeholder.
- Keep footer under 60 characters.
- Category must be one of: utility, marketing, authentication.
- Language must be one of: en_US, en_GB, hi_IN.
- Return at most 2 buttons.
- Use the preferred button texts when provided.

Return JSON with this exact shape:
{
  "templateName": "string",
  "category": "utility",
  "language": "en_US",
  "headerText": "string",
  "body": "string",
  "footerText": "string",
  "includeCallPermissionRequest": false,
  "buttons": [
    { "type": "quick_reply", "text": "string" }
  ]
}`;

const buildCarouselTemplateAiPrompt = (options: {
  purpose: string;
  tone: AiToneOption;
  language: string;
  buttonTypes: AiTemplateButtonKind[];
  quickReplyText: string;
  websiteButtonText: string;
  phoneButtonText: string;
  cardCount: number;
  cardPrompts: Array<{
    index: number;
    topicHint: string;
    buttonTexts: Partial<Record<AiTemplateButtonKind, string>>;
  }>;
}) => `You create WhatsApp Business carousel templates for Meta approval.

Generate one CAROUSEL WhatsApp template based on this request:
- Purpose: ${options.purpose}
- Tone: ${options.tone}
- Language: ${options.language}
- Number of cards: ${options.cardCount}
- Button types requested: ${options.buttonTypes.length > 0 ? options.buttonTypes.join(", ") : "none"}
- Preferred quick reply text: ${options.quickReplyText || "not provided"}
- Preferred website button text: ${options.websiteButtonText || "not provided"}
- Preferred phone button text: ${options.phoneButtonText || "not provided"}
- Card-specific hints:
${options.cardPrompts.map((card) => `  - Card ${card.index}: topic="${card.topicHint || "none"}", quick_reply="${card.buttonTexts.quick_reply || ""}", url="${card.buttonTexts.url || ""}", phone="${card.buttonTexts.phone_number || ""}"`).join("\n")}

Requirements:
- Return ONLY valid JSON. No markdown.
- Language must be one of: en_US, en_GB, hi_IN.
- Category must be one of: utility, marketing, authentication.
- Generate exactly ${options.cardCount} cards.
- Each card should have concise body copy.
- Return at most 2 buttons per card.
- For URL buttons, include a realistic placeholder URL in "value".
- For phone buttons, include a realistic placeholder phone number in "value".
- For quick replies, "value" can be an empty string.

Return JSON with this exact shape:
{
  "templateName": "string",
  "category": "marketing",
  "language": "en_US",
  "mainBody": "string",
  "cards": [
    {
      "bodyText": "string",
      "buttons": [
        { "type": "quick_reply", "text": "string", "value": "" }
      ]
    }
  ]
}`;


const getActiveWhatsappTabFromUrl = (pathname: string, search: string): "template" | "campaigns" | "completed" => {
  if (pathname === "/whatsapp/templates") return "template";
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  if (tab === "completed") return "completed";
  if (tab === "template") return "template";
  return "campaigns";
};

export default function WhatsAppCampaigns() {
  const { user } = useAuth();
  const { toast } = useToast();
  const location = useLocation();
  const [activeTab, setActiveTab] = useState<"template" | "campaigns" | "completed">(
    getActiveWhatsappTabFromUrl(location.pathname, location.search),
  );
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createCampaignDialogOpen, setCreateCampaignDialogOpen] = useState(false);
  const [templateType, setTemplateType] = useState<"standard" | "carousel">("standard");
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [generatingWithAi, setGeneratingWithAi] = useState(false);
  const [aiPurpose, setAiPurpose] = useState("");
  const [aiTone, setAiTone] = useState<AiToneOption>("formal");
  const [aiLanguage, setAiLanguage] = useState("en_US");
  const [aiButtonTypes, setAiButtonTypes] = useState<AiTemplateButtonKind[]>(["quick_reply"]);
  const [aiQuickReplyText, setAiQuickReplyText] = useState("");
  const [aiWebsiteButtonText, setAiWebsiteButtonText] = useState("");
  const [aiPhoneButtonText, setAiPhoneButtonText] = useState("");
  const [aiCarouselCardCount, setAiCarouselCardCount] = useState(2);
  const [aiCarouselCards, setAiCarouselCards] = useState<AiCarouselCardDraft[]>([
    createAiCarouselCardDraft(),
    createAiCarouselCardDraft(),
  ]);
  const [aiIncludeHeader, setAiIncludeHeader] = useState(false);
  const [aiHeaderType, setAiHeaderType] = useState<AiHeaderType>("text");
  const [aiHeaderImagePreviewUrl, setAiHeaderImagePreviewUrl] = useState("");
  const [aiHeaderImageName, setAiHeaderImageName] = useState("");
  const [aiIncludeFooter, setAiIncludeFooter] = useState(false);
  const [templateStatusTab, setTemplateStatusTab] = useState<"approved" | "pending" | "failed">("pending");
  const [campaignStatusFilter, setCampaignStatusFilter] = useState<CampaignStatusFilter>("all");
  const [selectedTemplateDetails, setSelectedTemplateDetails] = useState<WhatsAppTemplateRecord | null>(null);
  const [selectedTemplatePreview, setSelectedTemplatePreview] = useState<WhatsAppTemplateDetailStructure | null>(null);
  const [loadingTemplatePreview, setLoadingTemplatePreview] = useState(false);
  const [templatePreviewError, setTemplatePreviewError] = useState<string | null>(null);
  const [campaignName, setCampaignName] = useState("");
  const [campaignDescription, setCampaignDescription] = useState("");
  const [campaignAudienceId, setCampaignAudienceId] = useState("");
  const [campaignAudienceName, setCampaignAudienceName] = useState("");
  const [campaignTemplateId, setCampaignTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [category, setCategory] = useState("utility");
  const [language, setLanguage] = useState("en_US");
  const [messageBody, setMessageBody] = useState("");
  const [enableHeader, setEnableHeader] = useState(false);
  const [headerText, setHeaderText] = useState("");
  const [enableFooter, setEnableFooter] = useState(false);
  const [enableButtons, setEnableButtons] = useState(false);
  const [includeCallPermissionRequest, setIncludeCallPermissionRequest] = useState(false);
  const [selectedButtons, setSelectedButtons] = useState<TemplateButtonType[]>([]);
  const [templateButtonLabels, setTemplateButtonLabels] = useState<Record<TemplateButtonType, string>>(defaultTemplateButtonLabels);
  const [footerText, setFooterText] = useState("");
  const [carouselCards, setCarouselCards] = useState<CarouselCardDraft[]>([]);
  const [uploadingCarouselCardId, setUploadingCarouselCardId] = useState<string | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [syncingTemplates, setSyncingTemplates] = useState(false);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);
  const [savingCampaign, setSavingCampaign] = useState(false);
  const [runningCampaignId, setRunningCampaignId] = useState<string | null>(null);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    setActiveTab(getActiveWhatsappTabFromUrl(location.pathname, location.search));
  }, [location.pathname, location.search]);

  const { data, refetch } = useQuery({
    queryKey: ["whatsapp-campaign-workspace", user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<{
      templates: WhatsAppTemplateRecord[];
      campaigns: CampaignRecord[];
      audiences: CampaignAudienceRecord[];
    }> => {
      const useWhatsappTemplates = supportsWhatsappTable("whatsapp_templates");
      const useWhatsappCampaigns = supportsWhatsappTable("whatsapp_campaigns");
      const useWhatsappAudiences = supportsWhatsappTable("whatsapp_audiences");
      const useLocalCampaignBackend = shouldUseLocalCampaignBackend();

      const [templatesResult, campaignsResult, audiencesResult, contactsResult, fallbackAudiencesResult, fallbackAudienceContactsResult, fallbackCampaignsResult] = await Promise.all([
        useWhatsappTemplates
          ? (supabase as any).from("whatsapp_templates").select("*").eq("user_id", user!.id).order("created_at", { ascending: false })
          : useLocalCampaignBackend
            ? fetch(
                `/api/local/whatsapp-templates?userId=${encodeURIComponent(user!.id)}&userEmail=${encodeURIComponent(user!.email ?? "")}`,
              )
            : (supabase as any).from("Templates").select("*").eq("user_email", user!.email ?? "").order("created_at", { ascending: false }),
        useWhatsappCampaigns
          ? (supabase as any)
              .from("whatsapp_campaigns")
              .select("id, name, description, status, audience_id, template_id, started_at, completed_at, total_contacts, sent_count, failed_count, whatsapp_audiences(name), whatsapp_templates(name)")
              .eq("user_id", user!.id)
              .order("created_at", { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        useWhatsappAudiences
          ? (supabase as any).from("whatsapp_audiences").select("id, name").eq("user_id", user!.id).order("created_at", { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        !useWhatsappAudiences && !useLocalCampaignBackend
          ? supabase
              .from("contacts")
              .select("id, first_name, phone_number")
              .eq("user_id", user!.id)
              .order("created_at", { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        !useWhatsappAudiences && !useLocalCampaignBackend
          ? (supabase as any).from("audience_segments").select("id, name").eq("user_id", user!.id).order("created_at", { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        !useWhatsappAudiences && !useLocalCampaignBackend
          ? (supabase as any).from("audience_segment_contacts").select("audience_id, contact_id").eq("user_id", user!.id)
          : Promise.resolve({ data: [], error: null }),
        !useWhatsappCampaigns && !useLocalCampaignBackend
          ? (supabase as any).from("audience_campaigns").select("*").eq("user_id", user!.id).order("created_at", { ascending: false })
          : Promise.resolve({ data: [], error: null }),
      ]);

      const normalizedTemplatesResult =
        !useWhatsappTemplates && useLocalCampaignBackend
          ? await (async () => {
              if (!("ok" in templatesResult)) return { data: [], error: { message: "Unexpected template response" } };
              const payload = await templatesResult.json().catch(() => null);
              if (!templatesResult.ok) {
                return {
                  data: [],
                  error: {
                    message:
                      payload && typeof payload === "object" && "error" in payload
                        ? String((payload as { error?: unknown }).error)
                        : "Failed to load WhatsApp templates",
                  },
                };
              }

              return {
                data: Array.isArray(payload?.templates) ? payload.templates : [],
                error: null,
              };
            })()
          : templatesResult;

      if (normalizedTemplatesResult.error) throw normalizedTemplatesResult.error;
      if (campaignsResult.error) throw campaignsResult.error;
      if (audiencesResult.error) throw audiencesResult.error;
      if (contactsResult.error) throw contactsResult.error;

      const templates = (normalizedTemplatesResult.data ?? [])
        .map((template: any) => {
          const name = useWhatsappTemplates ? template.name : template.template_name;
          const normalizedName = useWhatsappTemplates
            ? template.normalized_name
            : String(template.template_name ?? "")
                .trim()
                .toLowerCase()
                .replace(/\s+/g, "_")
                .replace(/[^a-z0-9_]/g, "");

          return {
            id: template.id,
            type: useWhatsappTemplates ? template.template_type : mapLegacyTemplateType(template.template_type),
            name,
            normalizedName,
            metaTemplateId: template.meta_template_id ?? undefined,
            body: useWhatsappTemplates ? template.body : template.body_text ?? template.content ?? "",
            category: String(template.category ?? (useWhatsappTemplates ? "utility" : "UTILITY")).toLowerCase(),
            language: template.language ?? "en_US",
            footerText: useWhatsappTemplates ? template.footer_text ?? "" : "",
            buttonCount: Array.isArray(template.button_types)
              ? template.button_types.length
              : Array.isArray(template.buttons)
                ? template.buttons.length
                : 0,
            status: mapTemplateStatus(useWhatsappTemplates ? template.meta_status : template.status),
            createdAtLabel: new Date(template.created_at).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            }),
          };
        })
        .filter((template) => !isHiddenMetaSampleTemplate(template.name, template.normalizedName)) as WhatsAppTemplateRecord[];

      let campaigns = (campaignsResult.data ?? []).map((campaign: any) => ({
        id: campaign.id,
        name: campaign.name,
        description: campaign.description ?? "",
        audienceId: campaign.audience_id ?? undefined,
        templateId: campaign.template_id ?? undefined,
        audienceName: campaign.whatsapp_audiences?.name ?? "No audience",
        templateName: campaign.whatsapp_templates?.name ?? "No template",
        status: campaign.status,
        totalContacts: Number(campaign.total_contacts ?? 0),
        sentCount: Number(campaign.sent_count ?? 0),
        failedCount: Number(campaign.failed_count ?? 0),
        startedAtLabel: campaign.started_at
          ? new Date(campaign.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
          : null,
        completedAtLabel: campaign.completed_at
          ? new Date(campaign.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
          : null,
      })) as CampaignRecord[];

      let audiences = (audiencesResult.data ?? []).map((audience: any) => ({
        id: audience.id,
        name: audience.name,
      })) as CampaignAudienceRecord[];

      const contactNameById = new Map<string, string>(
        (contactsResult.data ?? []).map((contact: any) => [
          contact.id as string,
          (contact.first_name?.trim() || contact.phone_number || "there") as string,
        ]),
      );

      if (!useWhatsappAudiences) {
        if (shouldUseLocalCampaignBackend()) {
          try {
            const response = await fetch(`/api/local/whatsapp-audience-segments?userId=${encodeURIComponent(user!.id)}`);
            if (response.ok) {
              const payload = await response.json().catch(() => null);
              if (payload?.audiences && Array.isArray(payload.audiences)) {
                audiences = payload.audiences.map((audience: any) => ({
                  id: audience.id,
                  name: audience.name,
                  memberCount: Number(audience.members ?? 0),
                  sampleFirstName:
                    Array.isArray(audience.contactIds) && Array.isArray(payload.contacts)
                      ? payload.contacts
                          .filter((contact: any) => audience.contactIds.includes(contact.id))
                          .map((contact: any) => contact.name)
                          .find(Boolean) ?? "there"
                      : "there",
                }));
              }
            }
          } catch {
            // Ignore local audience endpoint failures and fall back below if needed.
          }
        } else {
          if (!fallbackAudiencesResult.error && !fallbackAudienceContactsResult.error) {
            const contactIdsByAudience = new Map<string, string[]>();
            for (const row of fallbackAudienceContactsResult.data ?? []) {
              const current = contactIdsByAudience.get(row.audience_id) ?? [];
              current.push(row.contact_id);
              contactIdsByAudience.set(row.audience_id, current);
            }

            audiences = (fallbackAudiencesResult.data ?? []).map((audience: any) => ({
              id: audience.id,
              name: audience.name,
              memberCount: (contactIdsByAudience.get(audience.id) ?? []).length,
              sampleFirstName: (contactIdsByAudience.get(audience.id) ?? [])
                .map((contactId) => contactNameById.get(contactId))
                .find(Boolean) ?? "there",
            }));
          }
        }

        if (typeof window !== "undefined" && audiences.length === 0) {
          try {
            const stored = window.localStorage.getItem(getLocalAudienceStorageKey(user!.id));
            const parsed = stored ? JSON.parse(stored) : [];
            if (Array.isArray(parsed)) {
              const mergedById = new Map<string, CampaignAudienceRecord>();
              for (const audience of parsed) {
                if (!audience?.id || !audience?.name) continue;
                mergedById.set(audience.id, {
                  id: audience.id,
                  name: audience.name,
                  memberCount: Array.isArray(audience.contactIds) ? audience.contactIds.length : 0,
                  sampleFirstName:
                    (Array.isArray(audience.contactIds) ? contactNameById.get(audience.contactIds[0]) : undefined) ?? "there",
                });
              }

              audiences = Array.from(mergedById.values());
            }
          } catch {
            // Ignore unreadable local audience cache; DB-backed audiences remain usable.
          }
        }
      }

      if (!useWhatsappCampaigns && shouldUseLocalCampaignBackend()) {
        try {
          const response = await fetch(`/api/local/whatsapp-campaigns?userId=${encodeURIComponent(user!.id)}`);
          if (response.ok) {
            const payload = await response.json().catch(() => null);
            if (payload?.campaigns && Array.isArray(payload.campaigns)) {
              const audienceNameById = new Map(audiences.map((audience) => [audience.id, audience.name]));
              const templateNameById = new Map(templates.map((template) => [template.id, template.name]));
              campaigns = payload.campaigns.map((campaign: any) => ({
                id: campaign.id,
                name: campaign.name,
                description: campaign.description ?? "",
                audienceId: campaign.audience_id ?? undefined,
                templateId: campaign.template_id ?? undefined,
                audienceName: audienceNameById.get(campaign.audience_id) ?? "No audience",
                templateName: templateNameById.get(campaign.template_id) ?? campaign.template_name ?? "No template",
                status: campaign.status ?? "draft",
                totalContacts: Number(campaign.total_contacts ?? 0),
                sentCount: Number(campaign.sent_count ?? 0),
                failedCount: Number(campaign.failed_count ?? 0),
                startedAtLabel: campaign.started_at
                  ? new Date(campaign.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                  : null,
                completedAtLabel: campaign.completed_at
                  ? new Date(campaign.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                  : null,
              }));
            }
          }
        } catch {
          campaigns = [];
        }
      } else if (!useWhatsappCampaigns && !fallbackCampaignsResult.error) {
        const audienceNameById = new Map(audiences.map((audience) => [audience.id, audience.name]));
        const templateNameById = new Map(templates.map((template) => [template.id, template.name]));

        campaigns = (fallbackCampaignsResult.data ?? []).map((campaign: any) => ({
          id: campaign.id,
          name: campaign.name,
          description: campaign.description ?? "",
          audienceId: campaign.audience_id ?? undefined,
          templateId: campaign.template_id ?? undefined,
          audienceName: audienceNameById.get(campaign.audience_id) ?? "No audience",
          templateName: templateNameById.get(campaign.template_id) ?? "No template",
          status: campaign.status ?? "draft",
          totalContacts: Number(campaign.total_contacts ?? 0),
          sentCount: Number(campaign.sent_count ?? 0),
          failedCount: Number(campaign.failed_count ?? 0),
          startedAtLabel: campaign.started_at
            ? new Date(campaign.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
            : null,
          completedAtLabel: campaign.completed_at
            ? new Date(campaign.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
            : null,
        }));
      } else if (!useWhatsappCampaigns && typeof window !== "undefined" && !shouldUseLocalCampaignBackend()) {
        const audienceNameById = new Map(audiences.map((audience) => [audience.id, audience.name]));
        const templateNameById = new Map(templates.map((template) => [template.id, template.name]));

        try {
          const stored = window.localStorage.getItem(getLocalCampaignStorageKey(user!.id));
          const parsed = stored ? JSON.parse(stored) : [];
          if (Array.isArray(parsed)) {
            campaigns = parsed.map((campaign: any) => ({
              id: campaign.id,
              name: campaign.name,
              description: campaign.description ?? "",
              audienceId: campaign.audience_id ?? undefined,
              templateId: campaign.template_id ?? undefined,
              audienceName: audienceNameById.get(campaign.audience_id) ?? "No audience",
              templateName: templateNameById.get(campaign.template_id) ?? "No template",
              status: campaign.status ?? "draft",
              totalContacts: Number(campaign.total_contacts ?? 0),
              sentCount: Number(campaign.sent_count ?? 0),
              failedCount: Number(campaign.failed_count ?? 0),
              startedAtLabel: campaign.started_at
                ? new Date(campaign.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                : null,
              completedAtLabel: campaign.completed_at
                ? new Date(campaign.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                : null,
            }));
          }
        } catch {
          campaigns = [];
        }
      }

      return { templates, campaigns, audiences };
    },
  });

  const templates = data?.templates ?? [];
  const campaigns = data?.campaigns ?? [];
  const campaignAudiences = data?.audiences ?? [];
  const activeCampaignTemplates = useMemo(
    () => templates.filter((template) => template.status === "approved"),
    [templates],
  );
  const visibleTemplates = useMemo(
    () => templates.filter((template) => template.status === templateStatusTab),
    [templateStatusTab, templates],
  );

  const normalizedTemplateName = useMemo(
    () =>
      templateName
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, ""),
    [templateName],
  );
  const isCarousel = templateType === "carousel";
  const hasCarouselBody = messageBody.trim().length > 0;
  const completedCarouselCardCount = useMemo(
    () => carouselCards.filter((card) => isCarouselCardComplete(card)).length,
    [carouselCards],
  );
  const createDisabled = isCarousel
    ? !normalizedTemplateName || !messageBody.trim() || completedCarouselCardCount < 2 || uploadingCarouselCardId !== null
    : !normalizedTemplateName || !messageBody.trim();
  const activePreviewCard = carouselCards[0] ?? null;
  const createCampaignDisabled = !campaignName.trim() || !campaignAudienceId.trim() || !campaignTemplateId;

  useEffect(() => {
    if (!createCampaignDialogOpen) return;
    void refetch();
  }, [createCampaignDialogOpen, refetch]);

  const syncTemplatesFromMeta = async (silent = false) => {
    if (!user?.id) return;

    setSyncingTemplates(true);
    try {
      if (shouldUseLocalCampaignBackend()) {
        const response = await fetch("/api/local/sync-whatsapp-templates", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userId: user.id }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.success === false) {
          throw new Error(String(payload?.error || payload?.message || "Failed to sync templates"));
        }
      } else {
        const { data, error } = await supabase.functions.invoke("sync-whatsapp-templates", {
          body: {},
        });
        if (error || data?.success === false) {
          throw new Error(String(data?.error || error?.message || "Failed to sync templates"));
        }
      }
      await refetch();
    } catch (error) {
      if (!silent) {
        toast({
          title: "Unable to sync templates",
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      }
    } finally {
      setSyncingTemplates(false);
    }
  };

  useEffect(() => {
    if (!user?.id) return;
    void syncTemplatesFromMeta(true);
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    const hasPendingTemplates = templates.some((template) => template.status === "pending");
    if (!hasPendingTemplates) return;

    const intervalId = window.setInterval(() => {
      void syncTemplatesFromMeta(true);
    }, 30000);

    return () => window.clearInterval(intervalId);
  }, [user?.id, templates]);

  useEffect(() => {
    if (!user?.id) return;
    const hasActiveCampaigns = campaigns.some((campaign) => campaign.status === "active");
    if (!hasActiveCampaigns) return;

    const intervalId = window.setInterval(() => {
      void refetch();
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [campaigns, refetch, user?.id]);

  useEffect(() => {
    if (!createCampaignDialogOpen || !campaignAudienceId.trim()) return;

    const hasSelectedAudience = campaignAudiences.some((audience) => audience.id === campaignAudienceId);
    if (!hasSelectedAudience) {
      setCampaignAudienceName("");
      setCampaignAudienceId("");
    }
  }, [campaignAudienceId, campaignAudiences, createCampaignDialogOpen]);

  const selectedCampaignTemplate = activeCampaignTemplates.find((template) => template.id === campaignTemplateId);
  const selectedCampaignAudience =
    campaignAudiences.find((audience) => audience.id === campaignAudienceId) ??
    campaignAudiences.find((audience) => audience.name === campaignAudienceName);
  const pendingCampaigns = useMemo(
    () => campaigns.filter((campaign) => campaign.status === "draft" || campaign.status === "active"),
    [campaigns],
  );
  const completedCampaigns = useMemo(
    () => campaigns.filter((campaign) => campaign.status === "completed" || campaign.status === "failed"),
    [campaigns],
  );
  const filteredCampaigns = useMemo(() => {
    switch (campaignStatusFilter) {
      case "draft":
        return campaigns.filter((campaign) => campaign.status === "draft");
      case "active":
        return campaigns.filter((campaign) => campaign.status === "active");
      case "paused":
        return [];
      case "completed":
        return campaigns.filter((campaign) => campaign.status === "completed" || campaign.status === "failed");
      case "all":
      default:
        return campaigns;
    }
  }, [campaignStatusFilter, campaigns]);
  const previewMessageBody = useMemo(() => {
    if (!selectedCampaignTemplate) return "";

    const firstName = selectedCampaignAudience?.sampleFirstName?.trim() || "there";
    return selectedCampaignTemplate.body
      .replace(/\{\{\s*first_name\s*\}\}/gi, firstName)
      .replace(/\{\{\s*name\s*\}\}/gi, firstName)
      .replace(/\{\s*name\s*\}/gi, firstName)
      .replace(/\{\{\s*phone_number\s*\}\}/gi, "your number")
      .replace(/\{\{\s*email\s*\}\}/gi, "your email");
  }, [selectedCampaignAudience?.sampleFirstName, selectedCampaignTemplate]);

  const resetTemplateForm = () => {
    carouselCards.forEach((card) => {
      if (card.imagePreviewUrl) URL.revokeObjectURL(card.imagePreviewUrl);
    });
    if (aiHeaderImagePreviewUrl) {
      URL.revokeObjectURL(aiHeaderImagePreviewUrl);
    }
    setTemplateType("standard");
    setAiPanelOpen(false);
    setGeneratingWithAi(false);
    setAiPurpose("");
    setAiTone("formal");
    setAiLanguage("en_US");
    setAiButtonTypes(["quick_reply"]);
    setAiQuickReplyText("");
    setAiWebsiteButtonText("");
    setAiPhoneButtonText("");
    aiCarouselCards.forEach((card) => {
      if (card.imagePreviewUrl) URL.revokeObjectURL(card.imagePreviewUrl);
    });
    setAiCarouselCardCount(2);
    setAiCarouselCards([createAiCarouselCardDraft(), createAiCarouselCardDraft()]);
    setAiIncludeHeader(false);
    setAiHeaderType("text");
    setAiHeaderImagePreviewUrl("");
    setAiHeaderImageName("");
    setAiIncludeFooter(false);
    setTemplateName("");
    setCategory("utility");
    setLanguage("en_US");
    setMessageBody("");
    setEnableHeader(false);
    setHeaderText("");
    setEnableFooter(false);
    setEnableButtons(false);
    setIncludeCallPermissionRequest(false);
    setSelectedButtons([]);
    setTemplateButtonLabels(defaultTemplateButtonLabels);
    setFooterText("");
    setCarouselCards([]);
  };

  const handleGenerateTemplateWithAi = () => {
    void (async () => {
      if (!user?.id || !aiPurpose.trim()) {
        toast({
          title: "Tell AI what to generate",
          description: "Add a short purpose before generating the template.",
          variant: "destructive",
        });
        return;
      }

      setGeneratingWithAi(true);
      try {
        const promptOptions = {
          purpose: aiPurpose.trim(),
          tone: aiTone,
          language: aiLanguage,
          buttonTypes: aiButtonTypes,
          quickReplyText: aiQuickReplyText.trim(),
          websiteButtonText: aiWebsiteButtonText.trim(),
          phoneButtonText: aiPhoneButtonText.trim(),
          includeHeader: aiIncludeHeader,
          headerType: aiHeaderType,
          includeFooter: aiIncludeFooter,
          cardCount: aiCarouselCardCount,
          cardPrompts: aiCarouselCards.slice(0, aiCarouselCardCount).map((card, index) => ({
            index: index + 1,
            topicHint: card.topicHint.trim(),
            buttonTexts: card.buttonTexts,
          })),
        };

        const aiText = await generateText(isCarousel ? buildCarouselTemplateAiPrompt(promptOptions) : buildStandardTemplateAiPrompt(promptOptions));

        const parsed = JSON.parse(stripJsonFence(aiText));

        if (isCarousel) {
          const generated = parsed as AiCarouselTemplateResponse;
          const nextCards = Array.isArray(generated.cards)
            ? generated.cards
                .slice(0, aiCarouselCardCount)
                .map((card, index) => {
                  const sourceCard = aiCarouselCards[index];
                  return {
                    ...createCarouselCard(),
                    imagePreviewUrl: sourceCard?.imagePreviewUrl || "",
                    imageName: sourceCard?.imageName || "",
                    bodyText: String(card?.bodyText ?? "").trim(),
                    buttons: Array.isArray(card?.buttons)
                      ? card.buttons
                          .slice(0, 2)
                          .map((button) => {
                            const normalizedType = normalizeAiButtonKind(button?.type);
                            if (!normalizedType) return null;
                            return {
                              id: crypto.randomUUID(),
                              type: normalizedType,
                              text:
                                String(button?.text ?? "").trim() ||
                                sourceCard?.buttonTexts?.[normalizedType]?.trim() ||
                                aiButtonKindLabels[normalizedType],
                              value: String(button?.value ?? "").trim(),
                            } as CarouselButtonDraft;
                          })
                          .filter((button): button is CarouselButtonDraft => Boolean(button))
                      : [],
                  };
                })
                .filter((card) => card.bodyText || card.buttons.length > 0)
            : [];

          setTemplateName(generated.templateName?.trim() || sanitizeTemplateName(aiPurpose) || "carousel_template");
          setCategory(
            ["utility", "marketing", "authentication"].includes(String(generated.category ?? "").toLowerCase())
              ? String(generated.category).toLowerCase()
              : "marketing",
          );
          setLanguage(generated.language?.trim() || aiLanguage);
          setMessageBody(String(generated.mainBody ?? "").trim());
          setCarouselCards(nextCards);
        } else {
          const generated = parsed as AiStandardTemplateResponse;
          const nextButtons = Array.isArray(generated.buttons)
            ? generated.buttons
                .slice(0, 2)
                .map((button) => {
                  const normalizedType = normalizeAiButtonKind(button?.type);
                  return normalizedType ? mapAiButtonKindToTemplateType(normalizedType) : null;
                })
                .filter((buttonType): buttonType is TemplateButtonType => Boolean(buttonType))
            : [];

          const nextButtonLabels = { ...defaultTemplateButtonLabels };
          for (const button of generated.buttons ?? []) {
            const normalizedType = normalizeAiButtonKind(button?.type);
            if (!normalizedType) continue;
            nextButtonLabels[mapAiButtonKindToTemplateType(normalizedType)] =
              String(button?.text ?? "").trim() || nextButtonLabels[mapAiButtonKindToTemplateType(normalizedType)];
          }

          setTemplateName(generated.templateName?.trim() || sanitizeTemplateName(aiPurpose) || "whatsapp_template");
          setCategory(
            ["utility", "marketing", "authentication"].includes(String(generated.category ?? "").toLowerCase())
              ? String(generated.category).toLowerCase()
              : "utility",
          );
          setLanguage(generated.language?.trim() || aiLanguage);
          setEnableHeader(Boolean(String(generated.headerText ?? "").trim()));
          setHeaderText(String(generated.headerText ?? "").trim());
          setMessageBody(String(generated.body ?? "").trim());
          setEnableFooter(Boolean(String(generated.footerText ?? "").trim()));
          setFooterText(String(generated.footerText ?? "").trim().slice(0, 60));
          setIncludeCallPermissionRequest(Boolean(generated.includeCallPermissionRequest));
          setEnableButtons(nextButtons.length > 0);
          setSelectedButtons(nextButtons);
          setTemplateButtonLabels(nextButtonLabels);
        }

        setAiPanelOpen(false);
        toast({
          title: "Template draft generated",
          description: "AI filled the template fields. Review and edit anything before creating it.",
        });
      } catch (error) {
        toast({
          title: "Unable to generate template",
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      } finally {
        setGeneratingWithAi(false);
      }
    })();
  };

  const openTemplateDetails = (template: WhatsAppTemplateRecord) => {
    setSelectedTemplateDetails(template);
    setSelectedTemplatePreview(null);
    setTemplatePreviewError(null);
    setLoadingTemplatePreview(true);

    void (async () => {
      try {
        const payloadBody = {
          template_name: template.name,
          language: template.language,
        };

        if (shouldUseLocalCampaignBackend()) {
          const response = await fetch("/api/local/get-whatsapp-template-details", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              userId: user?.id,
              ...payloadBody,
            }),
          });

          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload?.success === false) {
            throw new Error(String(payload?.error || payload?.message || "Failed to load template preview"));
          }

          setSelectedTemplatePreview((payload?.template ?? null) as WhatsAppTemplateDetailStructure | null);
          return;
        }

        const { data, error } = await supabase.functions.invoke("get-whatsapp-template-details", {
          body: payloadBody,
        });

        if (error || data?.success === false) {
          throw new Error(String(data?.error || error?.message || "Failed to load template preview"));
        }

        setSelectedTemplatePreview((data?.template ?? null) as WhatsAppTemplateDetailStructure | null);
      } catch (error) {
        setTemplatePreviewError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoadingTemplatePreview(false);
      }
    })();
  };

  const resetCampaignForm = () => {
    setCampaignName("");
    setCampaignDescription("");
    setCampaignAudienceId("");
    setCampaignAudienceName("");
    setCampaignTemplateId("");
    setEditingCampaignId(null);
  };

  const openEditCampaignDialog = (campaign: CampaignRecord) => {
    setEditingCampaignId(campaign.id);
    setCampaignName(campaign.name);
    setCampaignDescription(campaign.description ?? "");
    setCampaignAudienceId(campaign.audienceId ?? "");
    setCampaignAudienceName(campaign.audienceName ?? "");
    setCampaignTemplateId(campaign.templateId ?? "");
    setCreateCampaignDialogOpen(true);
  };

  const handleDeleteCampaign = (campaign: CampaignRecord) => {
    void (async () => {
      if (!user?.id) return;

      let errorMessage: string | null = null;
      const useWhatsappCampaigns = supportsWhatsappTable("whatsapp_campaigns");

      if (useWhatsappCampaigns) {
        const { error } = await (supabase as any)
          .from("whatsapp_campaigns")
          .delete()
          .eq("user_id", user.id)
          .eq("id", campaign.id);
        if (error) errorMessage = error.message;
      } else if (shouldUseLocalCampaignBackend()) {
        try {
          const response = await fetch("/api/local/whatsapp-campaigns", {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              userId: user.id,
              campaignId: campaign.id,
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            errorMessage = String(payload?.error || "Failed to delete campaign");
          }
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error);
        }
      } else {
        const { error } = await (supabase as any)
          .from("audience_campaigns")
          .delete()
          .eq("user_id", user.id)
          .eq("id", campaign.id);
        if (error) errorMessage = error.message;
      }

      if (errorMessage) {
        toast({
          title: "Unable to delete campaign",
          description: errorMessage,
          variant: "destructive",
        });
        return;
      }

      await refetch();
      toast({
        title: "Campaign deleted",
        description: `${campaign.name} was removed.`,
      });
    })();
  };

  const handleDeleteTemplate = (template: WhatsAppTemplateRecord) => {
    void (async () => {
      if (!user?.id) return;
      setDeletingTemplateId(template.id);
      try {
        const { data, error } = await supabase.functions.invoke("delete-whatsapp-template", {
          body: {
            templateId: template.id,
            templateName: template.normalizedName || template.name,
            metaTemplateId: template.metaTemplateId ?? "",
            language: template.language,
          },
        });
        if (error || data?.success === false) {
          throw new Error(String(data?.error || data?.message || error?.message || "Failed to delete template"));
        }

        await refetch();
        toast({
          title: "Template deleted",
          description: `${template.name} was removed.`,
        });
      } catch (error) {
        toast({
          title: "Unable to delete template",
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      } finally {
        setDeletingTemplateId(null);
      }
    })();
  };

  const handleStartCampaign = (campaignId: string) => {
    void (async () => {
      if (!user?.id) return;

      setRunningCampaignId(campaignId);
      let startError: string | null = null;

      const { data, error } = await invokeWhatsappCampaignFunction(campaignId);
      if (error || data?.success === false) {
        startError = String(data?.error || error?.message || "Failed to start WhatsApp campaign");
      }

      if (startError) {
        setRunningCampaignId(null);

        toast({
          title: "Unable to start campaign",
          description: startError,
          variant: "destructive",
        });
        return;
      }

      setRunningCampaignId(null);
      void refetch();
      setActiveTab("campaigns");
      toast({
        title: "Campaign started",
        description: "WhatsApp API send requests are running in the background. Delivery is tracked separately.",
      });
    })();
  };

  const handleCreateCampaign = (startImmediately = false) => {
    void (async () => {
      if (createCampaignDisabled || !user?.id || !selectedCampaignTemplate) return;

      setSavingCampaign(true);
      const useWhatsappCampaigns = supportsWhatsappTable("whatsapp_campaigns");
      let resolvedAudienceId = campaignAudienceId.trim();
      let resolvedAudienceName = campaignAudienceName.trim();
      const selectedAudience =
        campaignAudiences.find((audience) => audience.id === resolvedAudienceId) ??
        campaignAudiences.find((audience) => audience.name === resolvedAudienceName);

      if (selectedAudience) {
        resolvedAudienceId = selectedAudience.id;
        resolvedAudienceName = selectedAudience.name;
      }

      if (!useWhatsappCampaigns) {
        if (resolvedAudienceId) {
          const liveAudienceById = await (supabase as any)
            .from("audience_segments")
            .select("id, name")
            .eq("user_id", user.id)
            .eq("id", resolvedAudienceId)
            .maybeSingle();

          if (!liveAudienceById.error && liveAudienceById.data?.id) {
            resolvedAudienceId = liveAudienceById.data.id;
            resolvedAudienceName = liveAudienceById.data.name ?? resolvedAudienceName;
          } else if (resolvedAudienceName) {
            const liveAudienceByName = await (supabase as any)
              .from("audience_segments")
              .select("id, name")
              .eq("user_id", user.id)
              .eq("name", resolvedAudienceName)
              .maybeSingle();

            if (!liveAudienceByName.error && liveAudienceByName.data?.id) {
              resolvedAudienceId = liveAudienceByName.data.id;
              resolvedAudienceName = liveAudienceByName.data.name ?? resolvedAudienceName;
            }
          }
        }
      }

      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!resolvedAudienceId || !uuidPattern.test(resolvedAudienceId)) {
        setSavingCampaign(false);
        console.error("Submitting Audience ID:", resolvedAudienceId);
        toast({
          title: "Validation Error",
          description: "Please re-select the audience from the list.",
          variant: "destructive",
        });
        return;
      }

      console.log("Submitting Audience ID:", resolvedAudienceId);

      const templateStructure = buildTemplateStructure(selectedCampaignTemplate);

      let insertedCampaign: { id: string } | null = null;
      let error: any = null;

      const campaignPayload = {
        name: campaignName.trim(),
        description: campaignDescription.trim(),
        audience_id: resolvedAudienceId,
        template_id: campaignTemplateId,
        template_name: selectedCampaignTemplate.normalizedName || selectedCampaignTemplate.name,
        template_language: selectedCampaignTemplate.language,
        template_structure: templateStructure,
        status: "draft",
      };

      if (useWhatsappCampaigns) {
        const result = editingCampaignId
          ? await (supabase as any)
              .from("whatsapp_campaigns")
              .update(campaignPayload)
              .eq("user_id", user.id)
              .eq("id", editingCampaignId)
              .select("id")
              .single()
          : await (supabase as any).from("whatsapp_campaigns").insert({
          user_id: user.id,
          ...campaignPayload,
        }).select("id").single();
        insertedCampaign = result.data;
        error = result.error;
      } else if (shouldUseLocalCampaignBackend()) {
        try {
          const response = await fetch("/api/local/whatsapp-campaigns", {
            method: editingCampaignId ? "PATCH" : "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              userId: user.id,
              campaignId: editingCampaignId,
              ...campaignPayload,
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            error = { message: String(payload?.error || `Failed to ${editingCampaignId ? "update" : "create"} campaign`) };
          } else {
            insertedCampaign = payload?.campaign ? { id: payload.campaign.id } : null;
          }
        } catch (createError) {
          error = { message: createError instanceof Error ? createError.message : String(createError) };
        }
      } else {
        const result = editingCampaignId
          ? await (supabase as any)
              .from("audience_campaigns")
              .update(campaignPayload)
              .eq("user_id", user.id)
              .eq("id", editingCampaignId)
              .select("id")
              .single()
          : await (supabase as any).from("audience_campaigns").insert({
              user_id: user.id,
              ...campaignPayload,
            }).select("id").single();
        insertedCampaign = result.data;
        error = result.error;
      }
      setSavingCampaign(false);

      if (error) {
        if (!useWhatsappCampaigns && !shouldUseLocalCampaignBackend() && isMissingTableError(error) && typeof window !== "undefined") {
          try {
            const stored = window.localStorage.getItem(getLocalCampaignStorageKey(user.id));
            const parsed = stored ? JSON.parse(stored) : [];
            const next = Array.isArray(parsed) ? parsed : [];
            const localCampaignId = crypto.randomUUID();
            next.unshift({
              id: localCampaignId,
              name: campaignName.trim(),
              description: campaignDescription.trim(),
              audience_id: resolvedAudienceId,
              template_id: campaignTemplateId,
              status: "draft",
              started_at: null,
              completed_at: null,
              total_contacts: 0,
              sent_count: 0,
              failed_count: 0,
            });
            window.localStorage.setItem(getLocalCampaignStorageKey(user.id), JSON.stringify(next));
            void refetch();
            setCreateCampaignDialogOpen(false);
            resetCampaignForm();
            toast({
              title: "Campaign created",
              description: startImmediately
                ? "Campaign was saved, but not sent, because the real WhatsApp campaign backend is not deployed yet."
                : "Campaign table is not deployed yet, so this was saved locally for now.",
            });
            return;
          } catch {
            // fall through to destructive toast
          }
        }

        toast({
          title: `Unable to ${editingCampaignId ? "update" : "create"} campaign`,
          description: error.message,
          variant: "destructive",
        });
        return;
      }

      void refetch();
      setCreateCampaignDialogOpen(false);
      resetCampaignForm();

      if (!editingCampaignId && startImmediately && insertedCampaign?.id) {
        handleStartCampaign(insertedCampaign.id);
      } else if (editingCampaignId) {
        toast({
          title: "Campaign updated",
          description: "Campaign details were saved.",
        });
      }
    })();
  };

  const campaignFilterOptions: Array<{ value: CampaignStatusFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "draft", label: "Draft" },
    { value: "active", label: "Active" },
    { value: "paused", label: "Paused" },
    { value: "completed", label: "Completed" },
  ];

  const getCampaignPillClassName = (status: CampaignRecord["status"]) => {
    switch (status) {
      case "completed":
        return "bg-[#ecfdf3] text-[#027a48]";
      case "failed":
        return "bg-[#fef3f2] text-[#d92d20]";
      case "active":
        return "bg-[#eef4ff] text-[#2563eb]";
      case "draft":
      default:
        return "bg-[#f4f4f5] text-[#171717]";
    }
  };

  const toggleTemplateButton = (buttonType: TemplateButtonType) => {
    setSelectedButtons((current) =>
      current.includes(buttonType) ? current.filter((item) => item !== buttonType) : [...current, buttonType],
    );
  };

  const toggleAiButtonType = (buttonType: AiTemplateButtonKind) => {
    setAiButtonTypes((current) => {
      if (current.includes(buttonType)) {
        return current.filter((item) => item !== buttonType);
      }
      if (current.length >= 2) {
        return [...current.slice(1), buttonType];
      }
      return [...current, buttonType];
    });
  };

  const addCarouselCard = () => {
    setCarouselCards((current) => (current.length >= 10 ? current : [...current, createCarouselCard()]));
  };

  const removeCarouselCard = (cardId: string) => {
    setCarouselCards((current) => {
      const cardToRemove = current.find((card) => card.id === cardId);
      if (cardToRemove?.imagePreviewUrl) {
        URL.revokeObjectURL(cardToRemove.imagePreviewUrl);
      }
      return current.filter((card) => card.id !== cardId);
    });
  };

  const updateCarouselCard = (cardId: string, updater: (card: CarouselCardDraft) => CarouselCardDraft) => {
    setCarouselCards((current) => current.map((card) => (card.id === cardId ? updater(card) : card)));
  };

  const fileToBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const [, base64 = ""] = result.split(",");
        if (!base64) {
          reject(new Error("Failed to read the selected image."));
          return;
        }
        resolve(base64);
      };
      reader.onerror = () => {
        reject(new Error("Failed to read the selected image."));
      };
      reader.readAsDataURL(file);
    });

  const handleCarouselImageChange = async (cardId: string, file: File | null) => {
    if (!file || !user?.id) return;

    if (!file.type.startsWith("image/")) {
      toast({
        title: "Invalid image",
        description: "Please upload a PNG or JPG image.",
        variant: "destructive",
      });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: "Image too large",
        description: "Carousel card images must be 5MB or smaller.",
        variant: "destructive",
      });
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    let previousPreviewUrl = "";

    setCarouselCards((current) =>
      current.map((card) => {
        if (card.id !== cardId) return card;
        previousPreviewUrl = card.imagePreviewUrl;
        return {
          ...card,
          headerHandle: "",
          imagePreviewUrl: previewUrl,
          imageName: file.name,
        };
      }),
    );

    if (previousPreviewUrl) {
      URL.revokeObjectURL(previousPreviewUrl);
    }

    setUploadingCarouselCardId(cardId);

    try {
      const fileBase64 = await fileToBase64(file);
      let payload: any = null;

      try {
        const { data, error } = await supabase.functions.invoke("upload-whatsapp-template-image", {
          body: {
            fileName: file.name,
            mimeType: file.type,
            fileBase64,
          },
        });

        if (error) {
          if (!isEdgeFunctionUnavailable(error)) {
            throw new Error(getErrorMessage(error, "Failed to upload the carousel image to Meta."));
          }
        } else {
          payload = data;
        }
      } catch (edgeError) {
        if (!(edgeError instanceof Error) || !isEdgeFunctionUnavailable(edgeError)) {
          throw edgeError;
        }
      }

      if (!payload) {
        const response = await fetch("/api/local/upload-whatsapp-template-image", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: user.id,
            fileName: file.name,
            mimeType: file.type,
            fileBase64,
          }),
        });

        payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            String(
              payload?.message ||
                payload?.error ||
                payload?.details?.error?.message ||
                "Failed to upload the carousel image to Meta.",
            ),
          );
        }
      }

      if (!payload?.success || !payload?.handle) {
        throw new Error(
          String(
            payload?.message ||
              payload?.error ||
              payload?.details?.error?.message ||
              "Failed to upload the carousel image to Meta.",
          ),
        );
      }

      updateCarouselCard(cardId, (card) => ({
        ...card,
        headerHandle: String(payload.handle).trim(),
      }));

      toast({
        title: "Image uploaded",
        description: "Card image is ready for Meta template submission.",
      });
    } catch (error) {
      updateCarouselCard(cardId, (card) => ({
        ...card,
        headerHandle: "",
      }));

      toast({
        title: "Image upload failed",
        description: error instanceof Error ? error.message : "Failed to upload the carousel image to Meta.",
        variant: "destructive",
      });
    } finally {
      setUploadingCarouselCardId((current) => (current === cardId ? null : current));
    }
  };

  const addCarouselButton = (cardId: string, type: CarouselButtonKind) => {
    updateCarouselCard(cardId, (card) => {
      if (card.buttons.length >= 2) return card;
      return {
        ...card,
        buttons: [...card.buttons, createCarouselButton(type)],
      };
    });
  };

  const updateCarouselButton = (
    cardId: string,
    buttonId: string,
    updater: (button: CarouselButtonDraft) => CarouselButtonDraft,
  ) => {
    updateCarouselCard(cardId, (card) => ({
      ...card,
      buttons: card.buttons.map((button) => (button.id === buttonId ? updater(button) : button)),
    }));
  };

  const removeCarouselButton = (cardId: string, buttonId: string) => {
    updateCarouselCard(cardId, (card) => ({
      ...card,
      buttons: card.buttons.filter((button) => button.id !== buttonId),
    }));
  };

  const handleAiHeaderImageChange = (file: File | null) => {
    if (!file) return;
    const previewUrl = URL.createObjectURL(file);
    if (aiHeaderImagePreviewUrl) {
      URL.revokeObjectURL(aiHeaderImagePreviewUrl);
    }
    setAiHeaderImagePreviewUrl(previewUrl);
    setAiHeaderImageName(file.name);
  };

  const syncAiCarouselCardCount = (nextCount: number) => {
    setAiCarouselCardCount(nextCount);
    setAiCarouselCards((current) => {
      if (current.length === nextCount) return current;
      if (current.length > nextCount) {
        current.slice(nextCount).forEach((card) => {
          if (card.imagePreviewUrl) URL.revokeObjectURL(card.imagePreviewUrl);
        });
        return current.slice(0, nextCount);
      }
      return [...current, ...Array.from({ length: nextCount - current.length }, () => createAiCarouselCardDraft())];
    });
  };

  const updateAiCarouselCard = (cardId: string, updater: (card: AiCarouselCardDraft) => AiCarouselCardDraft) => {
    setAiCarouselCards((current) => current.map((card) => (card.id === cardId ? updater(card) : card)));
  };

  const handleAiCarouselImageChange = (cardId: string, file: File | null) => {
    if (!file) return;
    const previewUrl = URL.createObjectURL(file);
    updateAiCarouselCard(cardId, (card) => {
      if (card.imagePreviewUrl) URL.revokeObjectURL(card.imagePreviewUrl);
      return {
        ...card,
        imagePreviewUrl: previewUrl,
        imageName: file.name,
      };
    });
  };

  const handleCreateTemplate = () => {
    void (async () => {
      if (createDisabled || !user?.id) return;

      setSavingTemplate(true);
      const trimmedBody = messageBody.trim();
      const trimmedHeader = enableHeader ? headerText.trim() : "";
      const trimmedFooter = enableFooter ? footerText.trim() : "";

      if (templateType === "carousel") {
        const invalidCard = carouselCards.find((card) => !isCarouselCardComplete(card));
        if (carouselCards.length < 2 || invalidCard) {
          setSavingTemplate(false);
          toast({
            title: "Carousel template is incomplete",
            description:
              "Add at least 2 cards. Each card needs an uploaded image reference, body text, and complete button details. A local preview image alone is not enough for Meta.",
            variant: "destructive",
          });
          return;
        }
      }

      const validationErrors = validateTemplateForMeta({
        normalizedTemplateName,
        body: trimmedBody,
        category,
        headerEnabled: enableHeader,
        headerText: trimmedHeader,
        footerEnabled: enableFooter,
        footerText: trimmedFooter,
        buttonsEnabled: enableButtons,
        buttonTypes: selectedButtons,
        includeCallPermissionRequest,
      });

      if (validationErrors.length > 0) {
        setSavingTemplate(false);
        toast({
          title: "Template validation failed",
          description: validationErrors[0],
          variant: "destructive",
        });
        return;
      }

      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) {
        setSavingTemplate(false);
        toast({
          title: "Unable to verify session",
          description: sessionError.message,
          variant: "destructive",
        });
        return;
      }

      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        setSavingTemplate(false);
        toast({
          title: "Your session expired",
          description: "Sign in again and retry template creation.",
          variant: "destructive",
        });
        return;
      }

      const components = buildTemplateComponents({
        body: trimmedBody,
        headerEnabled: enableHeader,
        headerText: trimmedHeader,
        footerEnabled: enableFooter,
        footerText: trimmedFooter,
        buttonsEnabled: enableButtons && !includeCallPermissionRequest,
        buttonTypes: includeCallPermissionRequest ? [] : selectedButtons,
        buttonLabels: templateButtonLabels,
        includeCallPermissionRequest,
      });
      const carouselComponents = isCarousel ? buildCarouselTemplateComponents(trimmedBody, carouselCards) : [];
      const templateCategory = isCarousel ? "marketing" : category;

      let error: { message: string } | null = null;
      let successMessage = "The template was saved and synced. Status will update automatically after Meta review.";
      try {
        const structure = buildTemplateStructurePayload({
          name: templateName.trim() || normalizedTemplateName,
          language,
          category: templateCategory,
          components: isCarousel ? carouselComponents : components,
          previousCategory: templateCategory.toUpperCase(),
        });
        const requestBody: Record<string, unknown> = templateType === "carousel"
          ? {
              name: structure.name,
              language: structure.language,
              category: structure.category,
              mainBody: trimmedBody,
              cards: carouselCards.map((card) => ({
                headerHandle: card.headerHandle.trim(),
                bodyText: card.bodyText.trim(),
                buttons: card.buttons.map((button) => ({
                  type: button.type.toLowerCase(),
                  text: button.text.trim(),
                  ...(button.type === "url" ? { url: button.value.trim(), value: button.value.trim() } : {}),
                  ...(button.type === "phone_number"
                    ? { phone_number: button.value.trim(), value: button.value.trim() }
                    : {}),
                })),
              })),
              components: carouselComponents,
              structure,
            }
          : {
              name: templateName.trim() || normalizedTemplateName,
              language,
              category: templateCategory.toUpperCase(),
              components,
            };

        if (shouldUseLocalCampaignBackend()) {
          requestBody.userId = user.id;
          requestBody.userEmail = user.email ?? undefined;
          const response = await fetch("/api/local/create-whatsapp-template", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
          });

          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload?.success === false) {
            error = {
              message: formatTemplateCreateError(payload),
            };
          } else if (payload?.message) {
            successMessage = String(payload.message);
          }
        } else {
          const { data, error: functionError } = await supabase.functions.invoke("create-whatsapp-template", {
            body: requestBody,
          });
          if (functionError || data?.success === false) {
            error = {
              message: formatTemplateCreateError(data, functionError?.message || "Failed to create template"),
            };
          } else if (data?.message) {
            successMessage = String(data.message);
          }
        }
      } catch (requestError) {
        error = {
          message: requestError instanceof Error ? requestError.message : String(requestError),
        };
      }
      setSavingTemplate(false);

      if (error) {
        toast({
          title: "Unable to create template",
          description: error.message,
          variant: "destructive",
        });
        return;
      }

      await refetch();
      await syncTemplatesFromMeta(true);
      await refetch();
      toast({
        title: "Template submitted to Meta",
        description: successMessage,
      });
      setCreateDialogOpen(false);
      resetTemplateForm();
    })();
  };

  return (
    <DashboardLayout>
      <div className="space-y-7 text-[#1f2635]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">WhatsApp Campaigns</h1>
            <p className="mt-2 max-w-4xl text-sm text-[#6b7280]">
              Manage WhatsApp templates, extract contacts, run campaigns, and review completed sends.
            </p>
          </div>
          <ChannelSelect page="campaigns" />
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            const nextTab = value as typeof activeTab;
            setActiveTab(nextTab);
            if (nextTab === "template") {
              navigate("/whatsapp/templates");
              return;
            }
            if (nextTab === "completed") {
              navigate("/whatsapp/campaigns?tab=completed");
              return;
            }
            navigate("/whatsapp/campaigns");
          }}
          className="space-y-6"
        >
          <TabsList className="relative grid h-auto w-full grid-cols-3 rounded-[22px] border border-[#f4f4f5] bg-[#fafafa] p-1">
            <div
              className={`absolute bottom-1 top-1 w-[calc(33.333%-0.333rem)] rounded-[18px] bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)] transition-all duration-300 ease-out ${
                activeTab === "template"
                  ? "left-1"
                  : activeTab === "campaigns"
                    ? "left-[calc(33.333%+0.166rem)]"
                    : "left-[calc(66.666%+0.166rem)]"
              }`}
            />
            <TabsTrigger value="template" className={tabClassName}>
              <FileText className="h-4 w-4" />
              Template
            </TabsTrigger>
            <TabsTrigger value="campaigns" className={tabClassName}>
              <Megaphone className="h-4 w-4" />
              Campaigns
            </TabsTrigger>
            <TabsTrigger value="completed" className={tabClassName}>
              <RefreshCcw className="h-4 w-4" />
              Completed
            </TabsTrigger>
          </TabsList>

          <TabsContent value="template" className="space-y-6">
            <div className="flex items-center justify-between gap-4 overflow-x-auto pb-1">
              <div className="flex min-w-max items-center gap-4">
                {([
                  ["approved", "Approved"],
                  ["pending", "Pending"],
                  ["failed", "Failed"],
                ] as const).map(([status, label]) => {
                  const isActive = templateStatusTab === status;

                  return (
                    <button
                      key={status}
                      type="button"
                      onClick={() => setTemplateStatusTab(status)}
                      className={`whitespace-nowrap rounded-[12px] border px-4 py-2 text-[12px] font-medium transition-colors ${
                        isActive
                          ? "border-[#171717] bg-[#171717] text-white"
                          : "border-[#e4e4e7] bg-white text-[#1f2635] hover:border-[#e4e4e7]"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              <div className="flex min-w-max items-center gap-3">
                <Button
                  onClick={() => {
                    resetTemplateForm();
                    setCreateDialogOpen(true);
                  }}
                  className="h-10 gap-2 rounded-[16px] px-4 text-[13px] font-medium shadow-[0_14px_30px_rgba(23,23,23,0.18)] hover:bg-primary/95"
                >
                  <Plus className="h-4 w-4" />
                  Create Template
                </Button>
              </div>
            </div>

            {templates.length === 0 ? (
              <div className="rounded-[26px] border border-dashed border-[#f4f4f5] bg-white p-7">
                <h2 className="text-[21px] font-semibold tracking-tight text-[#1f2635]">WhatsApp Template</h2>
                <p className="mt-3.5 max-w-4xl text-[15px] leading-7 text-[#6b7280]">
                  Create reusable WhatsApp templates with categories, personalization tags, and approved content blocks.
                </p>
              </div>
            ) : null}

            {templates.length === 0 ? (
              <div className="rounded-[26px] border border-dashed border-[#f4f4f5] bg-white p-8">
                <p className="text-[15px] text-[#7c7694]">No WhatsApp templates yet. Create one and it will appear here.</p>
              </div>
            ) : visibleTemplates.length === 0 ? (
              <div className="rounded-[26px] border border-dashed border-[#f4f4f5] bg-white p-8">
                <p className="text-[15px] text-[#7c7694]">No {templateStatusTab} templates yet.</p>
              </div>
            ) : (
              <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                {visibleTemplates.map((template) => (
                  <div
                    key={template.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openTemplateDetails(template)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openTemplateDetails(template);
                      }
                    }}
                    className="cursor-pointer rounded-2xl border border-border/60 bg-card p-5 shadow-sm transition-[border-color,box-shadow,background-color] hover:border-primary/30 hover:shadow-md min-h-[132px]"
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate text-base font-semibold text-[#1f2635]">{template.name}</h3>
                        </div>
                        <div className="flex items-center gap-2">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild onClick={(event) => event.stopPropagation()}>
                              <Button type="button" variant="ghost" size="icon" className="h-8 w-8">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                              <DropdownMenuItem onClick={() => openTemplateDetails(template)}>
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit details
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                disabled={deletingTemplateId === template.id}
                                onClick={() => handleDeleteTemplate(template)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="campaigns" className="space-y-6">
            <div className="flex items-center justify-between gap-3 overflow-x-auto pb-1">
              <div className="flex min-w-max items-center gap-2.5">
                {campaignFilterOptions.map((option) => {
                  const selected = campaignStatusFilter === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setCampaignStatusFilter(option.value)}
                      className={`whitespace-nowrap rounded-[13px] border px-3.5 py-2 text-[13px] font-medium transition-colors ${
                        selected
                          ? "border-[#171717] bg-[#171717] text-white"
                          : "border-[#e4e4e7] bg-white text-[#1f2635] hover:border-[#e4e4e7]"
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>

              <Button
                onClick={() => setCreateCampaignDialogOpen(true)}
                className="h-11 shrink-0 gap-2 rounded-[15px] bg-[#171717] px-5 text-[13px] font-medium text-white hover:bg-[#171717]"
              >
                <Plus className="h-3.5 w-3.5" />
                New Campaign
              </Button>
            </div>

            {filteredCampaigns.length === 0 ? (
              <div className="rounded-[28px] border border-[#f4f4f5] bg-white px-8 py-10">
                <p className="text-[15px] text-[#7c7694]">No campaigns in this view yet.</p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {filteredCampaigns.map((campaign) => (
                  <div
                    key={campaign.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/whatsapp/campaigns/${campaign.id}`)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        navigate(`/whatsapp/campaigns/${campaign.id}`);
                      }
                    }}
                    className="relative min-h-[136px] rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-md"
                  >
                    <div className="flex flex-col space-y-1.5 p-6 pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="truncate text-base font-semibold tracking-tight">{campaign.name}</h3>
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={(event) => event.stopPropagation()}
                                className="h-8 w-8"
                                aria-label={`More actions for ${campaign.name}`}
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                              <DropdownMenuItem
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openEditCampaignDialog(campaign);
                                }}
                              >
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleDeleteCampaign(campaign);
                                }}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3 p-6 pt-0">
                      {campaign.description ? (
                        <p className="line-clamp-2 text-sm text-muted-foreground">{campaign.description}</p>
                      ) : (
                        <div className="min-h-[20px]" />
                      )}

                      <div className="flex items-center justify-end gap-3">
                      {campaign.status === "draft" || campaign.status === "active" ? (
                        <Button
                          type="button"
                          className="h-10 rounded-[14px] bg-[#171717] px-4 text-[13px] font-semibold text-white shadow-[0_12px_24px_rgba(23,23,23,0.16)] hover:bg-[#171717] disabled:bg-[#d7dce5] disabled:text-[#667085]"
                          disabled={campaign.status === "active" || runningCampaignId === campaign.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleStartCampaign(campaign.id);
                          }}
                        >
                          {runningCampaignId === campaign.id ? "Starting..." : campaign.status === "active" ? "Running" : "Start Campaign"}
                        </Button>
                      ) : null}
                    </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="completed" className="space-y-6">
            {completedCampaigns.length === 0 ? (
              <div className="rounded-[30px] border border-dashed border-[#f4f4f5] bg-white px-8 py-9">
                <p className="text-[15px] text-[#7c7694]">No completed WhatsApp campaigns yet.</p>
              </div>
            ) : (
              <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
                {completedCampaigns.map((campaign) => (
                  <div
                    key={campaign.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/whatsapp/campaigns/${campaign.id}`)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        navigate(`/whatsapp/campaigns/${campaign.id}`);
                      }
                    }}
                    className="cursor-pointer rounded-2xl border border-border/60 bg-card p-5 text-left shadow-sm transition-colors hover:border-primary/30"
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-lg font-semibold">{campaign.name}</h3>
                        <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center rounded-full border border-transparent px-3 py-0.5 text-xs font-medium capitalize ${
                            campaign.status === "completed"
                              ? "bg-primary text-primary-foreground hover:bg-primary/80"
                              : "bg-destructive text-destructive-foreground"
                          }`}
                        >
                          {campaign.status === "completed" ? "Completed" : campaign.status}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={(event) => event.stopPropagation()}
                          className="h-8 w-8"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <div className="inline-flex items-center rounded-full border border-transparent bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground">
                        Accepted by API: {campaign.sentCount}
                        </div>
                        <div className="inline-flex items-center rounded-full border border-transparent bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground">
                        Failed: {campaign.failedCount}
                        </div>
                      </div>
                      <p className="text-xs text-[#7c7694]">
                        Completed means the API accepted all runnable requests. Delivery receipts are not implied here.
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <Dialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open);
          if (!open) resetTemplateForm();
        }}
      >
        <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden border-[#d8dbe4] bg-white p-0 shadow-2xl sm:max-w-[1240px]">
          <DialogHeader className="border-b border-[#e6e9f0] px-6 py-3">
            <div className="flex flex-wrap items-start justify-between gap-4 pr-10">
              <div>
                <DialogTitle className="text-[19px] font-semibold tracking-tight text-[#1f2635]">Create New Template</DialogTitle>
                <DialogDescription className="pt-0.5 text-[13px] text-[#5f697c]">
                  Design a WhatsApp message template
                </DialogDescription>
              </div>

              <div className="relative inline-grid grid-cols-2 overflow-visible rounded-[20px] bg-[#fafafa] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)]">
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.5rem)] rounded-[16px] bg-white shadow-[0_8px_18px_rgba(23,23,23,0.12)] transition-transform duration-300 ease-out ${
                    templateType === "standard" ? "translate-x-0" : "translate-x-[calc(100%+0.5rem)]"
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setTemplateType("standard")}
                  className={`relative z-10 min-w-[128px] rounded-[16px] border px-4 py-2 text-[14px] font-medium transition-colors duration-300 ease-out ${
                    templateType === "standard"
                      ? "border-transparent bg-transparent text-black"
                      : "border-transparent bg-transparent text-black"
                  }`}
                >
                  Standard
                </button>
                <button
                  type="button"
                  onClick={() => setTemplateType("carousel")}
                  className={`relative z-10 min-w-[128px] rounded-[16px] border px-4 py-2 text-[14px] font-medium transition-colors duration-300 ease-out ${
                    templateType === "carousel"
                      ? "border-transparent bg-transparent text-black"
                      : "border-transparent bg-transparent text-black"
                  }`}
                >
                  Carousel
                </button>
              </div>
            </div>
          </DialogHeader>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)] overflow-hidden">
            <div className="min-h-0 overflow-y-auto px-6 py-6">
              <div className="space-y-6 pr-2 pb-6">
                <div className="overflow-hidden rounded-[28px] border border-[#f4f4f5] bg-[linear-gradient(180deg,#fcf8ff_0%,#f8fbff_100%)]">
                  <button
                    type="button"
                    onClick={() => setAiPanelOpen((current) => !current)}
                    className="flex w-full items-center justify-between px-5 py-4 text-left text-[#171717]"
                  >
                    <span className="flex items-center gap-2.5 text-[15px] font-semibold">
                      <Sparkles className="h-4 w-4" />
                      {isCarousel ? "Generate Carousel with AI" : "Generate with AI"}
                    </span>
                    <ChevronDown className={`h-4 w-4 transition-transform ${aiPanelOpen ? "rotate-180" : ""}`} />
                  </button>

                  {aiPanelOpen ? (
                    <div className="space-y-4 border-t border-[#f4f4f5] px-4 py-4">
                      <div className="space-y-2.5">
                        <Label htmlFor="wa-ai-purpose" className="text-[13px] font-extrabold uppercase tracking-[0.06em] text-[#171717]">
                          What Is This Template For? *
                        </Label>
                        <Textarea
                          id="wa-ai-purpose"
                          value={aiPurpose}
                          onChange={(event) => setAiPurpose(event.target.value)}
                          placeholder={isCarousel ? "e.g. Promote a new product collection with 3 shoppable cards" : "e.g. Notify customers that their order is ready for pickup today"}
                          className="min-h-[84px] rounded-[24px] border-[#e4e4e7] bg-white px-4 py-3.5 text-[14px] placeholder:text-[#98a2b3]"
                        />
                      </div>

                      <div className="grid gap-3.5 md:grid-cols-2">
                        <div className="space-y-2.5">
                          <Label className="text-[13px] font-extrabold uppercase tracking-[0.06em] text-[#171717]">Tone</Label>
                          <Select value={aiTone} onValueChange={(value) => setAiTone(value as AiToneOption)}>
                            <SelectTrigger className="h-11 rounded-[22px] border-[#e4e4e7] bg-white px-4 text-[14px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {aiToneOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2.5">
                          <Label className="text-[13px] font-extrabold uppercase tracking-[0.06em] text-[#171717]">Language</Label>
                          <Select value={aiLanguage} onValueChange={setAiLanguage}>
                            <SelectTrigger className="h-11 rounded-[22px] border-[#e4e4e7] bg-white px-4 text-[14px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {aiLanguageOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <div className="space-y-3">
                        <Label className="text-[13px] font-extrabold uppercase tracking-[0.06em] text-[#171717]">
                          Button Types (Max 2 Buttons) *
                        </Label>
                        <div className="flex flex-wrap gap-2.5">
                          {(Object.keys(aiButtonKindLabels) as AiTemplateButtonKind[]).map((buttonType) => {
                            const selected = aiButtonTypes.includes(buttonType);
                            return (
                              <button
                                key={buttonType}
                                type="button"
                                onClick={() => toggleAiButtonType(buttonType)}
                                className={`rounded-[16px] border px-4 py-2 text-[13px] font-semibold transition-all ${
                                  selected
                                    ? "border-[#171717] bg-[#171717] text-white shadow-[0_10px_24px_rgba(23,23,23,0.2)]"
                                    : "border-[#d7dce5] bg-white text-[#364152]"
                                }`}
                              >
                                {aiButtonKindLabels[buttonType]}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {aiButtonTypes.includes("quick_reply") ? (
                        <div className="space-y-2.5">
                          <Label htmlFor="wa-ai-quick-reply" className="text-[13px] font-extrabold uppercase tracking-[0.06em] text-[#171717]">
                            Quick Reply Text *
                          </Label>
                          <Input
                            id="wa-ai-quick-reply"
                            value={aiQuickReplyText}
                            onChange={(event) => setAiQuickReplyText(event.target.value)}
                            placeholder="e.g. Yes, I'm interested"
                            className="h-11 rounded-[22px] border-[#e4e4e7] bg-white px-4 text-[14px] placeholder:text-[#98a2b3]"
                          />
                        </div>
                      ) : null}

                      {aiButtonTypes.includes("url") ? (
                        <div className="space-y-2.5">
                          <Label htmlFor="wa-ai-website-button" className="text-[13px] font-extrabold uppercase tracking-[0.06em] text-[#171717]">
                            Website Button Text
                          </Label>
                          <Input
                            id="wa-ai-website-button"
                            value={aiWebsiteButtonText}
                            onChange={(event) => setAiWebsiteButtonText(event.target.value)}
                            placeholder="e.g. View Offer"
                            className="h-11 rounded-[22px] border-[#e4e4e7] bg-white px-4 text-[14px] placeholder:text-[#98a2b3]"
                          />
                        </div>
                      ) : null}

                      {aiButtonTypes.includes("phone_number") ? (
                        <div className="space-y-2.5">
                          <Label htmlFor="wa-ai-phone-button" className="text-[13px] font-extrabold uppercase tracking-[0.06em] text-[#171717]">
                            Phone Button Text
                          </Label>
                          <Input
                            id="wa-ai-phone-button"
                            value={aiPhoneButtonText}
                            onChange={(event) => setAiPhoneButtonText(event.target.value)}
                            placeholder="e.g. Call Us"
                            className="h-11 rounded-[22px] border-[#e4e4e7] bg-white px-4 text-[14px] placeholder:text-[#98a2b3]"
                          />
                        </div>
                      ) : null}

                      {isCarousel ? (
                        <div className="space-y-4">
                          <div className="space-y-2.5">
                            <Label htmlFor="wa-ai-carousel-count" className="text-[13px] font-extrabold uppercase tracking-[0.06em] text-[#171717]">
                              Number Of Cards: {aiCarouselCardCount}
                            </Label>
                            <input
                              id="wa-ai-carousel-count"
                              type="range"
                              min={2}
                              max={10}
                              step={1}
                              value={aiCarouselCardCount}
                              onChange={(event) => syncAiCarouselCardCount(Number(event.target.value))}
                              className="h-2 w-full cursor-pointer accent-[#171717]"
                            />
                            <div className="flex items-center justify-between text-[12px] font-medium text-[#171717]">
                              <span>2</span>
                              <span>10</span>
                            </div>
                          </div>

                          <div className="space-y-3">
                            <Label className="text-[13px] font-extrabold uppercase tracking-[0.06em] text-[#171717]">
                              Card Images + Topic Hints
                            </Label>
                            <div className="space-y-4">
                              {aiCarouselCards.slice(0, aiCarouselCardCount).map((card, index) => (
                                <div key={card.id} className="border-b border-[#f4f4f5] pb-4 last:border-b-0 last:pb-0">
                                  <div className="flex items-start gap-3">
                                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#f4f4f5] text-[18px] font-bold text-[#171717]">
                                      {index + 1}
                                    </div>
                                    <div className="min-w-0 flex-1 space-y-3">
                                      <label className="flex max-w-[280px] cursor-pointer items-center gap-3 rounded-[18px] border border-dashed border-[#e4e4e7] bg-white px-4 py-3 text-[#98a2b3] transition-colors hover:border-[#171717]">
                                        <Upload className="h-4 w-4 shrink-0" />
                                        <div className="min-w-0">
                                          <div className="truncate text-[14px] font-semibold text-[#98a2b3]">
                                            {card.imageName || "Upload Image *"}
                                          </div>
                                        </div>
                                        <input
                                          type="file"
                                          accept="image/png,image/jpeg,image/jpg,image/webp"
                                          className="sr-only"
                                          onChange={(event) => handleAiCarouselImageChange(card.id, event.target.files?.[0] ?? null)}
                                        />
                                      </label>

                                      {card.imagePreviewUrl ? (
                                        <img src={card.imagePreviewUrl} alt={`Card ${index + 1}`} className="h-28 w-full rounded-[16px] object-cover" />
                                      ) : null}

                                      <Input
                                        value={card.topicHint}
                                        onChange={(event) =>
                                          updateAiCarouselCard(card.id, (current) => ({
                                            ...current,
                                            topicHint: event.target.value,
                                          }))
                                        }
                                        placeholder={`Card ${index + 1} topic hint (optional)...`}
                                        className="h-11 rounded-[22px] border-[#e4e4e7] bg-white px-4 text-[14px] placeholder:text-[#98a2b3]"
                                      />

                                      <div className="rounded-[20px] border border-[#f4f4f5] bg-[#fafafa] p-4">
                                        {aiButtonTypes.map((buttonType) => (
                                          <div key={buttonType} className="space-y-2.5">
                                            <div className="inline-flex rounded-full bg-[#f4f4f5] px-4 py-1 text-[12px] font-extrabold uppercase tracking-[0.06em] text-[#171717]">
                                              {buttonType === "quick_reply" ? "Quick Reply" : buttonType === "url" ? "Website URL" : "Phone Number"}
                                            </div>
                                            <Input
                                              value={card.buttonTexts[buttonType] ?? ""}
                                              onChange={(event) =>
                                                updateAiCarouselCard(card.id, (current) => ({
                                                  ...current,
                                                  buttonTexts: {
                                                    ...current.buttonTexts,
                                                    [buttonType]: event.target.value,
                                                  },
                                                }))
                                              }
                                              placeholder={
                                                buttonType === "quick_reply"
                                                  ? "Quick reply text (max 25 chars) *"
                                                  : buttonType === "url"
                                                    ? "Website button text *"
                                                    : "Phone button text *"
                                              }
                                              className="h-11 rounded-[16px] border-[#e4e4e7] bg-white px-4 text-[14px] placeholder:text-[#98a2b3]"
                                            />
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-4 pt-1">
                          <div className="flex flex-wrap gap-6">
                          <label className="flex items-center gap-3 text-[14px] text-[#171717]">
                            <Checkbox checked={aiIncludeHeader} onCheckedChange={(checked) => setAiIncludeHeader(Boolean(checked))} />
                            Include Header
                          </label>
                          <label className="flex items-center gap-3 text-[14px] text-[#171717]">
                            <Checkbox checked={aiIncludeFooter} onCheckedChange={(checked) => setAiIncludeFooter(Boolean(checked))} />
                            Include Footer
                          </label>
                          </div>

                          {aiIncludeHeader ? (
                            <div className="space-y-2.5">
                              <Label className="text-[13px] font-extrabold uppercase tracking-[0.06em] text-[#171717]">
                                Header Type *
                              </Label>
                              <div className="grid gap-3 md:grid-cols-2">
                                <button
                                  type="button"
                                  onClick={() => setAiHeaderType("text")}
                                  className={`flex min-h-[92px] flex-col items-center justify-center rounded-[20px] border px-4 py-4 text-center transition-all ${
                                    aiHeaderType === "text"
                                      ? "border-[#171717] bg-[#fafafa] text-[#171717] shadow-[0_10px_24px_rgba(23,23,23,0.12)]"
                                      : "border-[#d7dce5] bg-white text-[#667085]"
                                  }`}
                                >
                                  <FileText className="h-6 w-6" />
                                  <span className="mt-2 text-[15px] font-semibold">Text</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setAiHeaderType("image")}
                                  className={`flex min-h-[92px] flex-col items-center justify-center rounded-[20px] border px-4 py-4 text-center transition-all ${
                                    aiHeaderType === "image"
                                      ? "border-[#171717] bg-[#fafafa] text-[#171717] shadow-[0_10px_24px_rgba(23,23,23,0.12)]"
                                      : "border-[#d7dce5] bg-white text-[#667085]"
                                  }`}
                                >
                                  <FileImage className="h-6 w-6" />
                                  <span className="mt-2 text-[15px] font-semibold">Image</span>
                                </button>
                              </div>

                              {aiHeaderType === "image" ? (
                                <div className="space-y-2.5">
                                  <Label className="text-[13px] font-extrabold uppercase tracking-[0.06em] text-[#171717]">
                                    Upload Header Image *
                                  </Label>
                                  <label className="flex cursor-pointer flex-col items-center justify-center rounded-[20px] border border-dashed border-[#d7dce5] bg-white px-5 py-6 text-center transition-colors hover:border-[#a1a1aa]">
                                    {aiHeaderImagePreviewUrl ? (
                                      <img
                                        src={aiHeaderImagePreviewUrl}
                                        alt="Header preview"
                                        className="mb-3 h-32 w-full rounded-[16px] object-cover"
                                      />
                                    ) : (
                                      <div className="mb-3 rounded-full bg-[#f4f4f5] p-3 text-[#171717]">
                                        <Upload className="h-5 w-5" />
                                      </div>
                                    )}
                                    <span className="text-[14px] font-semibold text-[#171717]">
                                      {aiHeaderImagePreviewUrl ? "Replace image" : "Upload image"}
                                    </span>
                                    <span className="mt-1 text-[12px] text-[#667085]">
                                      {aiHeaderImageName || "PNG, JPG up to 5MB"}
                                    </span>
                                    <input
                                      type="file"
                                      accept="image/png,image/jpeg,image/jpg,image/webp"
                                      className="sr-only"
                                      onChange={(event) => handleAiHeaderImageChange(event.target.files?.[0] ?? null)}
                                    />
                                  </label>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      )}

                      <Button
                        type="button"
                        onClick={handleGenerateTemplateWithAi}
                        disabled={generatingWithAi || !aiPurpose.trim()}
                        className="h-11 w-full rounded-[22px] bg-[linear-gradient(90deg,#171717_0%,#171717_50%,#171717_100%)] text-[14px] font-semibold text-white hover:opacity-95 disabled:opacity-60"
                      >
                        <Sparkles className="mr-2 h-4 w-4" />
                        {generatingWithAi ? "Generating..." : isCarousel ? "Generate All Cards" : "Generate Template"}
                      </Button>

                      {isCarousel ? (
                        <p className="text-center text-[13px] text-[#171717]">
                          AI will generate contextual copy for all {aiCarouselCardCount} cards.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className="space-y-2.5">
                  <Label htmlFor="wa-template-name" className="text-[14px] font-semibold text-[#364152]">
                    Template Name *
                  </Label>
                  <Input
                    id="wa-template-name"
                    value={templateName}
                    onChange={(event) => setTemplateName(event.target.value)}
                    placeholder={isCarousel ? "e.g., product_carousel" : "e.g., Order Confirmation or order_confirmation"}
                    className="h-12 rounded-2xl border-[#cfd5df] px-5 text-[15px] placeholder:text-[#98a2b3]"
                  />
                  <p className="text-[12px] text-[#667085]">
                    Will be auto-converted to:{" "}
                    <span className="rounded bg-[#f2f4f7] px-2 py-0.5 font-mono text-[12px]">
                      {normalizedTemplateName || "lowercase_with_underscores"}
                    </span>
                  </p>
                </div>

                {isCarousel ? (
                  <>
                    <div className="space-y-2.5">
                      <Label htmlFor="wa-carousel-body" className="text-[14px] font-semibold text-[#364152]">
                        Main Body Text *
                      </Label>
                      <Textarea
                        id="wa-carousel-body"
                        value={messageBody}
                        onChange={(event) => setMessageBody(event.target.value)}
                        placeholder="This text will appear above all carousel cards..."
                        className="min-h-[132px] rounded-2xl border-[#cfd5df] px-5 py-4 text-[15px] placeholder:text-[#98a2b3]"
                      />
                      <p className="text-[12px] text-[#667085]">This message appears above all cards</p>
                    </div>

                    <div className="border-t border-[#e6e9f0] pt-5">
                      <div className="mb-4 flex items-center justify-between gap-4">
                        <div className="text-[14px] font-semibold text-[#1f2635]">Cards ({carouselCards.length}/10)</div>
                        <Button
                          type="button"
                          onClick={addCarouselCard}
                          disabled={carouselCards.length >= 10}
                          className="h-11 rounded-2xl bg-[#171717] px-5 text-[15px] font-semibold text-white hover:bg-[#171717] disabled:bg-[#d7dce5] disabled:text-[#667085]"
                        >
                          <Plus className="h-4 w-4" />
                          Add Card
                        </Button>
                      </div>

                      <div className="rounded-[24px] border border-[#d7dce5] bg-[#f7f8fb] p-5">
                        <div className="flex items-center gap-3 text-[13px] font-bold uppercase tracking-[0.08em] text-[#667085]">
                          <BadgeCheck className="h-4 w-4 text-[#efb008]" />
                          Completion Checklist
                        </div>
                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          <div className="rounded-2xl border border-dashed border-[#d7dce5] bg-white px-4 py-4 text-[14px] text-[#667085]">
                            <div className="flex items-center gap-2">
                              <Circle className={`h-4 w-4 ${hasCarouselBody ? "fill-[#22c55e] text-[#22c55e]" : "text-[#667085]"}`} />
                              <span className={hasCarouselBody ? "font-medium text-[#1f2635]" : ""}>Main Body Text</span>
                            </div>
                          </div>
                          <div
                            className={`rounded-2xl px-4 py-4 text-[14px] font-medium ${
                              completedCarouselCardCount >= 2 ? "bg-[#ecfdf3] text-[#027a48]" : "bg-[#fff1ef] text-[#d92d20]"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <Circle className={`h-4 w-4 ${completedCarouselCardCount >= 2 ? "fill-[#22c55e] text-[#22c55e]" : "text-[#d92d20]"}`} />
                              Minimum 2 Cards ({Math.min(completedCarouselCardCount, 2)}/2)
                            </div>
                          </div>
                        </div>
                        {carouselCards.length > 0 ? (
                          <div className="mt-4 grid gap-3">
                            {carouselCards.map((card, index) => (
                              <div key={card.id} className="rounded-2xl border border-[#e4e7ec] bg-white px-4 py-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="text-[14px] font-semibold text-[#1f2635]">Card #{index + 1}</p>
                                    <div className="mt-2 flex flex-wrap gap-2 text-[12px] font-semibold uppercase tracking-[0.06em]">
                                      <span className={card.imagePreviewUrl ? "text-[#16a34a]" : "text-[#d92d20]"}>Photo</span>
                                      <span className={card.bodyText.trim() ? "text-[#16a34a]" : "text-[#d92d20]"}>Text</span>
                                      <span className={card.buttons.length > 0 ? "text-[#16a34a]" : "text-[#d92d20]"}>Buttons</span>
                                    </div>
                                  </div>
                                  <div className={`rounded-full px-3 py-1 text-[12px] font-semibold ${isCarouselCardComplete(card) ? "bg-[#ecfdf3] text-[#027a48]" : "bg-[#fff4ed] text-[#c2410c]"}`}>
                                    {isCarouselCardComplete(card) ? "Complete" : "Incomplete"}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>

                      {carouselCards.length === 0 ? (
                        <div className="mt-5 rounded-[24px] border border-dashed border-[#d7dce5] bg-white px-6 py-10 text-center">
                          <p className="text-[15px] font-medium text-[#475467]">No cards added yet</p>
                          <p className="mt-2 text-[14px] text-[#667085]">Click "Add Card" to create your first card</p>
                        </div>
                      ) : (
                        <div className="mt-5 space-y-5">
                          {carouselCards.map((card, index) => (
                            <div key={card.id} className="rounded-[24px] border border-[#d7dce5] bg-[#fbfcff] p-5 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
                              <div className="mb-5 flex items-center justify-between gap-4">
                                <div className="text-[20px] font-semibold text-[#1f2635]">Card #{index + 1}</div>
                                <button type="button" onClick={() => removeCarouselCard(card.id)} className="text-[#f04438] transition-colors hover:text-[#d92d20]">
                                  <X className="h-5 w-5" />
                                </button>
                              </div>

                              <div className="space-y-5">
                                <div className="space-y-2.5">
                                  <div className="flex items-center justify-between gap-4">
                                    <Label className="text-[14px] font-bold uppercase text-[#364152]">Card Image <span className="text-[#f04438]">*</span></Label>
                                    {!card.imagePreviewUrl ? (
                                      <span className="flex items-center gap-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-[#f04438]">
                                        <AlertCircle className="h-3.5 w-3.5" />
                                        Required
                                      </span>
                                    ) : uploadingCarouselCardId === card.id ? (
                                      <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#2563eb]">
                                        Uploading to Meta...
                                      </span>
                                    ) : card.headerHandle.trim() ? (
                                      <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#16a34a]">
                                        Uploaded to Meta
                                      </span>
                                    ) : null}
                                  </div>
                                  <label className="flex cursor-pointer flex-col items-center justify-center rounded-[22px] border border-dashed border-[#aab2c5] bg-white px-6 py-12 text-center hover:border-[#8f99af]">
                                    {card.imagePreviewUrl ? (
                                      <img src={card.imagePreviewUrl} alt={`Card ${index + 1}`} className="mb-4 h-40 w-full rounded-2xl object-cover" />
                                    ) : (
                                      <div className="mb-4 rounded-full bg-[#f2f4f7] p-5 text-[#98a2b3]">
                                        <Upload className="h-8 w-8" />
                                      </div>
                                    )}
                                    <span className="text-[15px] font-semibold text-[#ca8a04]">
                                      {card.imagePreviewUrl ? "Replace image" : "Upload a file"}
                                    </span>
                                    <span className="mt-2 text-[13px] text-[#667085]">
                                      {card.imageName || "PNG, JPG up to 5MB"}
                                    </span>
                                    <input
                                      type="file"
                                      accept="image/png,image/jpeg,image/jpg"
                                      className="hidden"
                                      onChange={(event) => handleCarouselImageChange(card.id, event.target.files?.[0] ?? null)}
                                      disabled={uploadingCarouselCardId === card.id}
                                    />
                                  </label>
                                  {card.imagePreviewUrl && !card.headerHandle.trim() ? (
                                    <p className="text-[12px] text-[#667085]">
                                      The preview image still needs to finish uploading to Meta before this card can be submitted.
                                    </p>
                                  ) : null}
                                </div>

                                <div className="space-y-2.5">
                                  <div className="flex items-center justify-between gap-4">
                                    <Label htmlFor={`wa-card-body-${card.id}`} className="text-[14px] font-semibold text-[#364152]">
                                      Card Body Text *
                                    </Label>
                                    <span className="text-[12px] font-medium text-[#667085]">{card.bodyText.length}/160</span>
                                  </div>
                                  <Input
                                    id={`wa-card-body-${card.id}`}
                                    value={card.bodyText}
                                    maxLength={160}
                                    onChange={(event) =>
                                      updateCarouselCard(card.id, (current) => ({ ...current, bodyText: event.target.value }))
                                    }
                                    placeholder="Enter text for this card..."
                                    className="h-12 rounded-2xl border-[#cfd5df] px-5 text-[15px] placeholder:text-[#98a2b3]"
                                  />
                                </div>

                                <div className="space-y-3 rounded-[20px] border border-[#bfd5ff] bg-[#eef4ff] px-5 py-5">
                                  <div className="font-semibold text-[#1d4ed8]">Important: Button Consistency Required</div>
                                  <p className="text-[13px] leading-6 text-[#3159b7]">
                                    All cards must have the same number and types of buttons. E.g., if Card 1 has [URL, Quick Reply], all other cards must also have [URL, Quick Reply] in the same order.
                                  </p>
                                </div>

                                <div className="space-y-3">
                                  <div className="flex flex-wrap items-center justify-between gap-3">
                                    <Label className="text-[14px] font-semibold text-[#364152]">Buttons *</Label>
                                    <div className="flex flex-wrap gap-2">
                                      <Button type="button" variant="outline" className="h-9 rounded-2xl border-[#cfd5df] bg-white px-3.5 text-[13px]" onClick={() => addCarouselButton(card.id, "quick_reply")} disabled={card.buttons.length >= 2}>
                                        + Quick Reply
                                      </Button>
                                      <Button type="button" variant="outline" className="h-9 rounded-2xl border-[#cfd5df] bg-white px-3.5 text-[13px]" onClick={() => addCarouselButton(card.id, "url")} disabled={card.buttons.length >= 2}>
                                        + URL
                                      </Button>
                                      <Button type="button" variant="outline" className="h-9 rounded-2xl border-[#cfd5df] bg-white px-3.5 text-[13px]" onClick={() => addCarouselButton(card.id, "phone_number")} disabled={card.buttons.length >= 2}>
                                        + Phone
                                      </Button>
                                    </div>
                                  </div>

                                  {card.buttons.length === 0 ? (
                                    <p className="rounded-2xl border border-dashed border-[#d7dce5] px-4 py-5 text-center text-[14px] italic text-[#98a2b3]">
                                      No buttons added
                                    </p>
                                  ) : (
                                    <div className="space-y-3">
                                      {card.buttons.map((button, buttonIndex) => (
                                        <div key={button.id} className="rounded-2xl border border-[#e4e7ec] bg-[#fafafa] p-4">
                                          <div className="mb-3 flex items-center justify-between gap-3">
                                            <div className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[#667085]">
                                              Button {buttonIndex + 1}: {button.type.replace("_", " ")}
                                            </div>
                                            <button type="button" onClick={() => removeCarouselButton(card.id, button.id)} className="text-[#98a2b3] hover:text-[#475467]">
                                              <Trash2 className="h-4 w-4" />
                                            </button>
                                          </div>
                                          <div className="grid gap-3 md:grid-cols-2">
                                            <Input
                                              value={button.text}
                                              onChange={(event) =>
                                                updateCarouselButton(card.id, button.id, (current) => ({ ...current, text: event.target.value }))
                                              }
                                              placeholder="Button label"
                                              className="h-11 rounded-2xl border-[#cfd5df] px-4"
                                            />
                                            {button.type === "quick_reply" ? (
                                              <div className="flex items-center rounded-2xl border border-dashed border-[#d7dce5] px-4 text-[13px] text-[#667085]">
                                                Quick replies do not need a URL or phone number.
                                              </div>
                                            ) : (
                                              <Input
                                                value={button.value}
                                                onChange={(event) =>
                                                  updateCarouselButton(card.id, button.id, (current) => ({ ...current, value: event.target.value }))
                                                }
                                                placeholder={button.type === "url" ? "https://example.com" : "+1 555 123 4567"}
                                                className="h-11 rounded-2xl border-[#cfd5df] px-4"
                                              />
                                            )}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="space-y-2.5">
                      <Label className="text-[14px] font-semibold text-[#364152]">Category *</Label>
                      <Select value={category} onValueChange={setCategory}>
                        <SelectTrigger className="h-12 rounded-2xl border-[#cfd5df] px-5 text-[15px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="utility">Utility (Transactional)</SelectItem>
                          <SelectItem value="marketing">Marketing</SelectItem>
                          <SelectItem value="authentication">Authentication</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {category === "utility" ? (
                      <div className="rounded-2xl border border-[#d7e3ff] bg-[#f5f8ff] px-5 py-4">
                        <label className="flex items-start gap-3 text-[14px] text-[#2648a5]">
                          <Checkbox
                            checked={includeCallPermissionRequest}
                            onCheckedChange={(checked) => {
                              const next = Boolean(checked);
                              setIncludeCallPermissionRequest(next);
                              if (next) {
                                setEnableButtons(false);
                                setSelectedButtons([]);
                              }
                            }}
                          />
                          <span>
                            <span className="block font-semibold text-[#1d4ed8]">Create a call permission request template</span>
                            <span className="mt-1 block text-[12px] leading-5 text-[#4b6baf]">
                              Use this for business-initiated WhatsApp calling permission. The body provides the context and Meta adds the call permission request component.
                            </span>
                          </span>
                        </label>
                      </div>
                    ) : null}

                    <div className="space-y-2.5">
                      <Label className="text-[14px] font-semibold text-[#364152]">Language</Label>
                      <Select value={language} onValueChange={setLanguage}>
                        <SelectTrigger className="h-12 rounded-2xl border-[#cfd5df] px-5 text-[15px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="en_US">en_US</SelectItem>
                          <SelectItem value="en_GB">en_GB</SelectItem>
                          <SelectItem value="hi_IN">hi_IN</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-[12px] text-[#667085]">English (US) - Default</p>
                    </div>

                    <div className="border-t border-[#e6e9f0] pt-5">
                      <div className="mb-4 flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 text-[15px] font-semibold text-[#475467]">
                          <FileImage className="h-4 w-4 text-[#ff4b94]" />
                          Header (Optional)
                        </div>
                        <label className="flex items-center gap-3 text-[15px] text-[#475467]">
                          <Checkbox checked={enableHeader} onCheckedChange={(checked) => setEnableHeader(Boolean(checked))} />
                          Enable Header
                        </label>
                      </div>
                      {enableHeader ? (
                        <div className="space-y-2.5 pl-10">
                          <Label htmlFor="wa-header-text" className="text-[14px] font-semibold text-[#364152]">
                            Header Text *
                          </Label>
                          <Input
                            id="wa-header-text"
                            value={headerText}
                            onChange={(event) => setHeaderText(event.target.value)}
                            placeholder="Short header text shown above the body"
                            className="h-12 rounded-2xl border-[#cfd5df] px-5 text-[15px] placeholder:text-[#98a2b3]"
                          />
                        </div>
                      ) : null}
                    </div>

                    <div className="space-y-2.5">
                      <Label htmlFor="wa-message-body" className="text-[14px] font-semibold text-[#364152]">
                        Message Body *
                      </Label>
                      <Textarea
                        id="wa-message-body"
                        value={messageBody}
                        onChange={(event) => setMessageBody(event.target.value)}
                        placeholder="Enter your message. Type {{ to insert parameters like {{first_name}}, {{phone_number}}, {{email}}"
                        className="min-h-[160px] rounded-2xl border-[#cfd5df] px-5 py-4 text-[15px] placeholder:font-mono placeholder:text-[#98a2b3]"
                      />
                      <p className="text-[12px] text-[#667085]">
                        Type <span className="rounded bg-[#f2f4f7] px-2 py-0.5 font-mono text-[12px]">{"{{"}</span> to insert parameters. Available:
                        {" "}first_name, phone_number, email
                      </p>
                    </div>

                    <div className="border-t border-[#e6e9f0] pt-5">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 text-[15px] font-semibold text-[#475467]">
                          <Download className="h-4 w-4 text-[#667085]" />
                          Footer (Optional)
                        </div>
                        <label className="flex items-center gap-3 text-[15px] text-[#475467]">
                          <Checkbox checked={enableFooter} onCheckedChange={(checked) => setEnableFooter(Boolean(checked))} />
                          Enable Footer
                        </label>
                      </div>
                      {enableFooter ? (
                        <div className="mt-5 space-y-2.5 pl-10">
                          <Label htmlFor="wa-footer-text" className="text-[14px] font-semibold text-[#364152]">
                            Footer Text *
                          </Label>
                          <Textarea
                            id="wa-footer-text"
                            value={footerText}
                            onChange={(event) => setFooterText(event.target.value.slice(0, 60))}
                            placeholder="e.g., Thanks for choosing us!"
                            className="min-h-[112px] rounded-2xl border-[#cfd5df] px-5 py-4 text-[15px] placeholder:text-[#98a2b3]"
                          />
                          <p className="text-[12px] text-[#667085]">Footer text (max 60 characters) - {footerText.length}/60</p>
                        </div>
                      ) : null}
                    </div>

                    <div className="border-t border-[#e6e9f0] pt-5">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 text-[15px] font-semibold text-[#475467]">
                          <MousePointerClick className="h-4 w-4 text-[#3b82f6]" />
                          Buttons (Optional)
                        </div>
                        <label className="flex items-center gap-3 text-[15px] text-[#475467]">
                          <Checkbox
                            checked={enableButtons}
                            disabled={includeCallPermissionRequest}
                            onCheckedChange={(checked) => setEnableButtons(Boolean(checked))}
                          />
                          Enable Buttons
                        </label>
                      </div>
                      {includeCallPermissionRequest ? (
                        <div className="mt-5 pl-10 text-[13px] text-[#667085]">
                          Meta renders the call permission action for this template. Custom template buttons are disabled.
                        </div>
                      ) : enableButtons ? (
                        <div className="mt-5 space-y-4 pl-10">
                          <div className="flex flex-wrap gap-3">
                            {templateButtonOptions.map((buttonOption) => {
                              const isSelected = selectedButtons.includes(buttonOption.type);

                              return (
                                <button
                                  key={buttonOption.type}
                                  type="button"
                                  onClick={() => toggleTemplateButton(buttonOption.type)}
                                  className={`rounded-xl px-5 py-3 text-[14px] font-semibold transition-all ${
                                    isSelected
                                      ? `${buttonOption.chipClassName} ring-2 ring-offset-1`
                                      : "bg-[#f8fafc] text-[#98a2b3]"
                                  }`}
                                >
                                  + {buttonOption.label}
                                </button>
                              );
                            })}
                          </div>
                          <p className="text-center text-[14px] italic text-[#98a2b3]">
                            {selectedButtons.length === 0 ? "No buttons added yet" : `${selectedButtons.length} button${selectedButtons.length === 1 ? "" : "s"} selected`}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  </>
                )}

                {!isCarousel ? (
                  <div className="rounded-3xl border border-[#b2d2ff] bg-[#eaf2ff] px-6 py-6 text-[#2648a5]">
                    <h4 className="flex items-center gap-2 text-[16px] font-semibold">
                      <BadgeCheck className="h-4 w-4" />
                      Meta WhatsApp Template Rules:
                    </h4>
                    <ul className="mt-3.5 space-y-2.5 text-[14px] leading-6">
                      <li>• <strong>Maximum 5 parameters</strong> per template</li>
                      <li>• <strong>Minimum 5 words per parameter</strong> (excluding the parameters themselves)</li>
                      <li>• <strong>Message cannot end with a parameter</strong> - add text after the last parameter</li>
                      <li>• <strong>Minimum 20 characters</strong> total message length</li>
                      <li>• <strong>Approval required:</strong> Templates are reviewed by Meta (usually takes a few hours to 24 hours)</li>
                    </ul>
                  </div>
                ) : null}

              </div>
            </div>

            <div className="bg-[#e5e7eb]" />

            <div className="min-h-0 overflow-y-auto bg-white px-6 py-6">
              <div className={`flex min-h-full flex-col rounded-[18px] p-5 ${isCarousel ? "bg-[#efeadf]" : "bg-[#e8ddd2]"}`}>
                <div className="flex items-center justify-between border-b border-[#d5c7bb] pb-4">
                  <h3 className="text-[16px] font-semibold text-[#364152]">WhatsApp Preview</h3>
                  <button type="button" className="text-[14px] text-[#475467]">Hide</button>
                </div>
                <div className="flex flex-1 items-center justify-center py-6">
                  {isCarousel ? (
                    <div className="flex h-full w-full items-center justify-center rounded-[24px] border border-[#e2dbce] bg-[radial-gradient(circle_at_center,_rgba(126,141,165,0.08)_1px,_transparent_1px)] bg-[length:24px_24px] p-6">
                      {carouselCards.length === 0 ? (
                        <div className="w-full max-w-[620px] space-y-4">
                          {messageBody.trim() ? (
                            <div className="ml-auto max-w-[520px] rounded-[22px] bg-white px-5 py-4 text-[15px] text-[#364152] shadow-[0_8px_20px_rgba(15,23,42,0.08)]">
                              <div className="flex items-end justify-between gap-4">
                                <p className="min-w-0 flex-1 break-words">{messageBody.trim()}</p>
                                <span className="shrink-0 text-[12px] text-[#98a2b3]">
                                  {new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}
                                </span>
                              </div>
                            </div>
                          ) : null}
                          <div className="rounded-[22px] bg-white px-6 py-8 text-center text-[15px] text-[#667085] shadow-[0_8px_20px_rgba(15,23,42,0.08)]">
                            Add cards to view preview
                          </div>
                        </div>
                      ) : (
                        <div className="w-full max-w-[420px] rounded-[28px] bg-[#efe8db] p-4 shadow-[0_10px_30px_rgba(15,23,42,0.08)]">
                          <div className="rounded-[24px] border border-[#e2dbce] bg-[#f7f1e7] p-4">
                            <p className="text-[14px] leading-6 text-[#4b5563]">
                              {messageBody.trim() || "This message appears above all cards"}
                            </p>
                          </div>

                          <div className="mt-4 overflow-hidden rounded-[24px] border border-[#ddd2c2] bg-white shadow-[0_8px_20px_rgba(15,23,42,0.08)]">
                            <div className="h-48 bg-[#f4f4f5]">
                              {activePreviewCard?.imagePreviewUrl ? (
                                <img src={activePreviewCard.imagePreviewUrl} alt="Carousel preview" className="h-full w-full object-cover" />
                              ) : (
                                <div className="flex h-full items-center justify-center text-[#98a2b3]">
                                  <FileImage className="h-12 w-12" />
                                </div>
                              )}
                            </div>
                            <div className="space-y-3 px-4 py-4">
                              <p className="text-[15px] text-[#364152]">
                                {activePreviewCard?.bodyText.trim() || "Card body text..."}
                              </p>
                              {activePreviewCard?.buttons.length ? (
                                <div className="space-y-2 border-t border-[#eef1f5] pt-3">
                                  {activePreviewCard.buttons.map((button) => (
                                    <div key={button.id} className="rounded-xl border border-[#e4e7ec] px-4 py-2 text-center text-[13px] font-medium text-[#475467]">
                                      {button.text.trim() || (button.type === "quick_reply" ? "Quick Reply" : button.type === "url" ? "Visit Website" : "Call Now")}
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </div>

                          <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
                            {carouselCards.map((card, index) => (
                              <div key={card.id} className={`min-w-[88px] rounded-2xl border px-3 py-3 text-center text-[12px] ${card.id === activePreviewCard?.id ? "border-[#171717] bg-white text-[#1f2635]" : "border-[#ddd2c2] bg-[#f8f5ef] text-[#667085]"}`}>
                                <div className="mx-auto mb-2 h-10 rounded-xl bg-[#ede7dc]">
                                  {card.imagePreviewUrl ? (
                                    <img src={card.imagePreviewUrl} alt={`Thumb ${index + 1}`} className="h-full w-full rounded-xl object-cover" />
                                  ) : null}
                                </div>
                                Card {index + 1}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="min-w-[280px] max-w-[92%] rounded-2xl bg-white px-5 py-4 shadow-[0_8px_20px_rgba(15,23,42,0.12)]">
                      {enableHeader && headerText.trim() ? (
                        <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.08em] text-[#667085]">{headerText.trim()}</div>
                      ) : null}
                      <p className="text-[15px] text-[#364152]">
                        {messageBody.trim() || "Your message will appear here..."}
                      </p>
                      {enableFooter && footerText.trim() ? (
                        <div className="mt-3 border-t border-[#eef1f5] pt-3 text-[12px] text-[#667085]">{footerText.trim()}</div>
                      ) : null}
                      {includeCallPermissionRequest ? (
                        <div className="mt-3 border-t border-[#eef1f5] pt-3">
                          <div className="rounded-xl border border-[#d7e3ff] bg-[#f5f8ff] px-4 py-2 text-center text-[13px] font-medium text-[#1d4ed8]">
                            Ask for WhatsApp call permission
                          </div>
                        </div>
                      ) : enableButtons ? (
                        <div className="mt-3 flex flex-col gap-2 border-t border-[#eef1f5] pt-3">
                          {selectedButtons.map((buttonType) => {
                            const buttonOption = templateButtonOptions.find((item) => item.type === buttonType);
                            if (!buttonOption) return null;

                            return (
                              <div
                                key={buttonType}
                                className={`rounded-xl border px-4 py-2 text-center text-[13px] font-medium ${buttonOption.previewClassName}`}
                              >
                                {getTemplateButtonLabel(buttonType, templateButtonLabels)}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-[#e6e9f0] bg-white px-6 py-2">
            <Button variant="outline" className="h-9 rounded-2xl px-4 text-[14px]" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="h-9 rounded-2xl bg-[#171717] px-4 text-[14px] font-semibold text-white hover:bg-[#171717]"
              onClick={handleCreateTemplate}
              disabled={createDisabled || savingTemplate}
            >
              {savingTemplate ? "Creating..." : "Create Template"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(selectedTemplateDetails)}
        onOpenChange={(open) => {
          if (open) return;
          setSelectedTemplateDetails(null);
          setSelectedTemplatePreview(null);
          setTemplatePreviewError(null);
          setLoadingTemplatePreview(false);
        }}
      >
        <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden border-[#d8dbe4] bg-white p-0 shadow-2xl sm:max-w-[920px]">
          <DialogHeader className="border-b border-[#e6e9f0] px-7 py-5">
            <div>
              <DialogTitle className="text-[20px] font-semibold tracking-tight text-[#1f2635]">Edit Template</DialogTitle>
              <DialogDescription className="pt-1 text-[13px] text-[#5f697c]">
                Review the template details and preview.
              </DialogDescription>
            </div>
          </DialogHeader>

          {selectedTemplateDetails ? (
            <div className="min-h-0 overflow-y-auto px-7 py-6">
              <div className="space-y-6">
                <div className="space-y-2">
                  <Label className="text-[14px] font-semibold text-[#364152]">Template Name</Label>
                  <Input value={selectedTemplateDetails.name} readOnly className="h-12 rounded-2xl border-[#cfd5df] px-4 text-[15px]" />
                  <p className="text-[12px] text-[#667085]">Normalized: {selectedTemplateDetails.normalizedName}</p>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-[14px] font-semibold text-[#364152]">Category</Label>
                    <Input
                      value={selectedTemplateDetails.category.charAt(0).toUpperCase() + selectedTemplateDetails.category.slice(1)}
                      readOnly
                      className="h-12 rounded-2xl border-[#cfd5df] px-4 text-[15px]"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-[14px] font-semibold text-[#364152]">Language</Label>
                    <Input value={selectedTemplateDetails.language} readOnly className="h-12 rounded-2xl border-[#cfd5df] px-4 text-[15px]" />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-[14px] font-semibold text-[#364152]">Message</Label>
                  <Textarea
                    value={selectedTemplatePreview?.previewBody ?? selectedTemplateDetails.body}
                    readOnly
                    className="min-h-[220px] rounded-2xl border-[#cfd5df] px-5 py-4 text-[15px] leading-7"
                  />
                  <p className="text-[12px] text-[#667085]">{(selectedTemplatePreview?.previewBody ?? selectedTemplateDetails.body).length} characters</p>
                </div>

                {(getTemplateDetailFooterText(selectedTemplatePreview) || selectedTemplateDetails.footerText) ? (
                  <div className="space-y-2">
                    <Label className="text-[14px] font-semibold text-[#364152]">Footer</Label>
                    <Textarea
                      value={getTemplateDetailFooterText(selectedTemplatePreview) || selectedTemplateDetails.footerText}
                      readOnly
                      className="min-h-[96px] rounded-2xl border-[#cfd5df] px-5 py-4 text-[15px] leading-7"
                    />
                  </div>
                ) : null}

                <div className="rounded-[24px] border border-[#d7e3ff] bg-[#f8fbff] p-5">
                  <div className="mb-3 flex flex-wrap items-center gap-3">
                    <span className="rounded-full border border-[#e5e7eb] bg-white px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-[#8b84a1]">
                      {selectedTemplatePreview?.hasCarousel || selectedTemplateDetails.type === "carousel" ? "Carousel" : "Text"}
                    </span>
                    <span
                      className={`rounded-full border px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.06em] ${
                        selectedTemplateDetails.status === "approved"
                          ? "border-[#b7efc5] bg-[#f0fdf4] text-[#2f855a]"
                          : selectedTemplateDetails.status === "failed"
                            ? "border-[#fecaca] bg-[#fef2f2] text-[#dc2626]"
                            : "border-[#f4f4f5] bg-[#fafafa] text-[#171717]"
                      }`}
                    >
                      {selectedTemplateDetails.status}
                    </span>
                    <span className="text-[13px] text-[#667085]">Created {selectedTemplateDetails.createdAtLabel}</span>
                  </div>
                  {loadingTemplatePreview ? (
                    <div className="flex items-center gap-3 rounded-2xl bg-white px-5 py-4 text-[14px] text-[#667085] shadow-[0_8px_20px_rgba(15,23,42,0.06)]">
                      <RefreshCcw className="h-4 w-4 animate-spin" />
                      Loading Meta preview...
                    </div>
                  ) : templatePreviewError ? (
                    <div className="rounded-2xl border border-[#fecaca] bg-[#fef2f2] px-5 py-4 text-[14px] text-[#b42318]">
                      {templatePreviewError}
                    </div>
                  ) : selectedTemplatePreview?.hasCarousel ? (
                    <div className="space-y-4 rounded-2xl bg-white px-5 py-5 shadow-[0_8px_20px_rgba(15,23,42,0.06)]">
                      {(selectedTemplatePreview.previewBody ?? "").trim() ? (
                        <div className="rounded-2xl border border-[#eef1f5] bg-[#f8fafc] px-4 py-3 text-[15px] leading-7 text-[#364152]">
                          {selectedTemplatePreview.previewBody}
                        </div>
                      ) : null}

                      <div className="grid gap-4 md:grid-cols-2">
                        {selectedTemplatePreview.carouselCards.map((card) => (
                          <div key={`${card.index}-${card.bodyText ?? "card"}`} className="overflow-hidden rounded-[24px] border border-[#e4e7ec] bg-white shadow-[0_8px_20px_rgba(15,23,42,0.05)]">
                            <div className="flex h-44 items-center justify-center bg-[#f4f4f5] text-[#98a2b3]">
                              {card.headerImageUrl ? (
                                <img src={card.headerImageUrl} alt={`Template card ${card.index + 1}`} className="h-full w-full object-cover" />
                              ) : (
                                <div className="flex flex-col items-center gap-2 text-[12px]">
                                  <FileImage className="h-10 w-10" />
                                  <span>{card.headerFormat || "media"} preview unavailable</span>
                                </div>
                              )}
                            </div>
                            <div className="space-y-3 px-4 py-4">
                              <div className="text-[12px] font-semibold uppercase tracking-[0.06em] text-[#98a2b3]">Card {card.index + 1}</div>
                              <p className="text-[15px] leading-7 text-[#364152]">{card.bodyText || "No body text"}</p>
                              {card.buttons.length > 0 ? (
                                <div className="space-y-2 border-t border-[#eef1f5] pt-3">
                                  {card.buttons.map((button, index) => (
                                    <div key={`${button.type ?? "button"}-${index}`} className="rounded-xl border border-[#e4e7ec] px-4 py-2 text-center text-[13px] font-medium text-[#475467]">
                                      {String(button.text ?? "").trim() || String(button.type ?? "Button")}
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-2xl bg-white px-5 py-4 shadow-[0_8px_20px_rgba(15,23,42,0.06)]">
                      {getTemplateDetailHeaderText(selectedTemplatePreview) ? (
                        <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.08em] text-[#667085]">
                          {getTemplateDetailHeaderText(selectedTemplatePreview)}
                        </div>
                      ) : null}
                      {selectedTemplatePreview?.hasHeader && selectedTemplatePreview.headerType !== "text" ? (
                        <div className="mb-4 overflow-hidden rounded-2xl border border-[#eef1f5] bg-[#f4f4f5]">
                          {selectedTemplatePreview.headerImageUrl ? (
                            <img src={selectedTemplatePreview.headerImageUrl} alt="Template header" className="h-52 w-full object-cover" />
                          ) : (
                            <div className="flex h-52 flex-col items-center justify-center gap-2 text-[#98a2b3]">
                              <FileImage className="h-10 w-10" />
                              <span className="text-[13px]">{selectedTemplatePreview.headerType} preview unavailable</span>
                            </div>
                          )}
                        </div>
                      ) : null}
                      <p className="text-[15px] leading-7 text-[#364152]">{selectedTemplatePreview?.previewBody ?? selectedTemplateDetails.body}</p>
                      {(getTemplateDetailFooterText(selectedTemplatePreview) || selectedTemplateDetails.footerText) ? (
                        <div className="mt-3 border-t border-[#eef1f5] pt-3 text-[12px] text-[#667085]">
                          {getTemplateDetailFooterText(selectedTemplatePreview) || selectedTemplateDetails.footerText}
                        </div>
                      ) : null}
                      {getTemplateDetailButtons(selectedTemplatePreview).length > 0 ? (
                        <div className="mt-3 flex flex-col gap-2 border-t border-[#eef1f5] pt-3">
                          {getTemplateDetailButtons(selectedTemplatePreview).map((button, index) => (
                            <div key={`${button.type ?? "button"}-${index}`} className="rounded-xl border border-[#e4e7ec] px-4 py-2 text-center text-[13px] font-medium text-[#475467]">
                              {String(button.text ?? "").trim() || String(button.type ?? "Button")}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-3 border-t border-[#e6e9f0] bg-white px-7 py-4">
            <Button variant="outline" className="h-[46px] rounded-2xl border-[#cfd5df] px-6 text-[14px] font-semibold text-[#344054]" onClick={() => setSelectedTemplateDetails(null)}>
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createCampaignDialogOpen}
        onOpenChange={(open) => {
          setCreateCampaignDialogOpen(open);
          if (!open) resetCampaignForm();
        }}
      >
        <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden border-[#d8dbe4] bg-white p-0 shadow-2xl sm:max-w-[1060px]">
          <DialogHeader className="border-b border-[#e6e9f0] px-7 py-5">
            <div>
              <DialogTitle className="text-[20px] font-semibold tracking-tight text-[#1f2635]">New Campaign</DialogTitle>
              <DialogDescription className="pt-1 text-[13px] text-[#5f697c]">
                {editingCampaignId ? "Edit your WhatsApp campaign details" : "Create a new WhatsApp campaign to reach your audience"}
              </DialogDescription>
            </div>
          </DialogHeader>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)] overflow-hidden">
            <div className="min-h-0 overflow-y-auto px-7 py-6">
              <div className="space-y-5 pb-4">
                <h3 className="text-[17px] font-semibold tracking-tight text-[#1f2635]">Campaign Details</h3>

                <div className="space-y-2">
                  <Label htmlFor="wa-campaign-name" className="text-[14px] font-semibold text-[#364152]">
                    Campaign Name *
                  </Label>
                  <Input
                    id="wa-campaign-name"
                    value={campaignName}
                    onChange={(event) => setCampaignName(event.target.value)}
                    placeholder="Example: January Development Update"
                    className="h-12 rounded-2xl border-[#cfd5df] px-4 text-[15px] placeholder:text-[#98a2b3]"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="wa-campaign-description" className="text-[14px] font-semibold text-[#364152]">
                    Description <span className="text-[#98a2b3]">(Optional)</span>
                  </Label>
                  <Input
                    id="wa-campaign-description"
                    value={campaignDescription}
                    onChange={(event) => setCampaignDescription(event.target.value)}
                    placeholder="Brief description"
                    className="h-12 rounded-2xl border-[#cfd5df] px-4 text-[15px] placeholder:text-[#98a2b3]"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-[14px] font-semibold text-[#364152]">Audience *</Label>
                  <Select
                    value={campaignAudienceId}
                    onValueChange={(value) => {
                      const nextAudience = campaignAudiences.find((audience) => audience.id === value);
                      setCampaignAudienceId(value);
                      setCampaignAudienceName(nextAudience?.name ?? "");
                    }}
                  >
                    <SelectTrigger className="h-12 rounded-2xl border-[#cfd5df] px-4 text-[15px]">
                      <SelectValue placeholder="Select an audience" />
                    </SelectTrigger>
                    <SelectContent>
                      {campaignAudiences.length > 0 ? (
                        campaignAudiences.map((audience) => (
                          <SelectItem key={audience.id} value={audience.id}>
                            {audience.name}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="no-audience" disabled>
                          No audiences available
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="text-[14px] font-semibold text-[#364152]">Message Template *</Label>
                  <Select value={campaignTemplateId} onValueChange={setCampaignTemplateId}>
                    <SelectTrigger className="h-12 rounded-2xl border-[#cfd5df] px-4 text-[15px]">
                      <SelectValue placeholder="Select a template" />
                    </SelectTrigger>
                    <SelectContent>
                    {activeCampaignTemplates.length > 0 ? (
                      activeCampaignTemplates.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          {template.name}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value="no-template" disabled>
                        No active templates available
                      </SelectItem>
                    )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="bg-[#e5e7eb]" />

            <div className="min-h-0 overflow-y-auto bg-white px-7 py-6">
              <div className="flex min-h-full items-center justify-center rounded-[18px] bg-[#e8ddd2] p-5">
                <div className="w-full rounded-[20px] border border-[#dfd1c4] bg-[#e9dfd5] px-6 py-10 text-center">
                  {selectedCampaignTemplate ? (
                    <div className="mx-auto max-w-[360px] rounded-2xl bg-white px-5 py-4 text-left shadow-[0_8px_20px_rgba(15,23,42,0.10)]">
                      <p className="text-[15px] text-[#364152]">{previewMessageBody}</p>
                      {selectedCampaignTemplate.footerText ? (
                        <div className="mt-3 border-t border-[#eef1f5] pt-3 text-[12px] text-[#667085]">
                          {selectedCampaignTemplate.footerText}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-[16px] font-medium text-[#667085]">Select a template to view preview here</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-[#e6e9f0] bg-white px-7 py-4">
            <Button
              variant="outline"
              className="h-[46px] rounded-2xl border-[#cfd5df] px-6 text-[14px] font-semibold text-[#344054]"
              onClick={() => setCreateCampaignDialogOpen(false)}
            >
              Cancel
            </Button>
              {!editingCampaignId ? (
                <Button
                  variant="outline"
                  className="h-[46px] rounded-2xl border-[#cfd5df] bg-white px-6 text-[14px] font-semibold text-[#344054]"
                  onClick={() => handleCreateCampaign(false)}
                >
                  Save as Draft
                </Button>
              ) : null}
            <Button
              className="h-[46px] rounded-2xl bg-[#171717] px-6 text-[14px] font-semibold text-white hover:bg-[#171717] disabled:bg-[#cfd5df] disabled:text-[#667085]"
              disabled={createCampaignDisabled || savingCampaign}
              onClick={() => handleCreateCampaign(!editingCampaignId)}
            >
              {savingCampaign ? "Saving..." : editingCampaignId ? "Save Changes" : "Start Campaign"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
