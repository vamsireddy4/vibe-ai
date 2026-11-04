export type TemplateComponent = {
  type?: string;
  format?: string;
  text?: string;
  example?: {
    header_handle?: string[];
    header_url?: string[];
  };
  buttons?: Array<Record<string, unknown>>;
  cards?: Array<{
    components?: TemplateComponent[];
  }>;
};

export type TemplateParameter = {
  index: number;
  placeholder: string;
  name: string;
};

export type ParsedCarouselCard = {
  index: number;
  hasHeader: boolean;
  headerFormat: string | null;
  headerMediaId: string | null;
  headerImageUrl: string | null;
  bodyText: string | null;
  bodyParameters: TemplateParameter[];
  hasButtons: boolean;
  buttons: Array<Record<string, unknown>>;
};

export type ParsedTemplateStructure = {
  name: string;
  language: string;
  hasHeader: boolean;
  headerType: string | null;
  headerHandleId: string | null;
  headerImageUrl: string | null;
  bodyParameters: TemplateParameter[];
  hasCarousel: boolean;
  carouselCards: ParsedCarouselCard[];
  previewBody: string;
  components: TemplateComponent[];
};

export function extractBodyParameterMatches(bodyText: string): string[] {
  let matches: string[] = bodyText.match(/\{\{\s*\d+\s*\}\}/g) || [];
  if (matches.length === 0) {
    const broadMatches = bodyText.match(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g) || [];
    matches = broadMatches.filter((match) => match.length < 40);
  }
  return matches;
}

export function buildTemplateParameters(bodyText: string) {
  return extractBodyParameterMatches(bodyText).map((match, idx) => {
    const content = match.replace(/\{\{|\}\}|\s/g, "");
    const isNumeric = /^\d+$/.test(content);
    return {
      index: isNumeric ? Number.parseInt(content, 10) : idx + 1,
      placeholder: match,
      name: content,
    };
  });
}

export function parseMetaTemplateStructure(template: Record<string, unknown>): ParsedTemplateStructure {
  const components = Array.isArray(template.components) ? template.components as TemplateComponent[] : [];

  const structure: ParsedTemplateStructure = {
    name: String(template.name ?? ""),
    language: String(template.language ?? "en_US"),
    hasHeader: false,
    headerType: null,
    headerHandleId: null,
    headerImageUrl: null,
    bodyParameters: [],
    hasCarousel: false,
    carouselCards: [],
    previewBody: "",
    components,
  };

  const headerComponent = components.find((component) => String(component.type ?? "").trim().toUpperCase() === "HEADER");
  if (headerComponent?.format) {
    const format = String(headerComponent.format).trim().toLowerCase();
    if (["image", "video", "document"].includes(format)) {
      structure.hasHeader = true;
      structure.headerType = format;
      structure.headerHandleId = headerComponent.example?.header_handle?.[0] ?? null;
      structure.headerImageUrl = headerComponent.example?.header_url?.[0] ?? null;
    }
  }

  const carouselComponent = components.find((component) => String(component.type ?? "").trim().toUpperCase() === "CAROUSEL");
  if (carouselComponent && Array.isArray(carouselComponent.cards)) {
    structure.hasCarousel = true;
    structure.carouselCards = carouselComponent.cards.map((card, index) => {
      const cardComponents = Array.isArray(card.components) ? card.components : [];
      const cardHeader = cardComponents.find((component) => String(component.type ?? "").trim().toUpperCase() === "HEADER");
      const cardBody = cardComponents.find((component) => String(component.type ?? "").trim().toUpperCase() === "BODY");
      const cardButtons = cardComponents.find((component) => String(component.type ?? "").trim().toUpperCase() === "BUTTONS");
      const cardBodyText = String(cardBody?.text ?? "").trim();

      return {
        index,
        hasHeader: Boolean(cardHeader),
        headerFormat: cardHeader?.format ? String(cardHeader.format).trim().toLowerCase() : null,
        headerMediaId: cardHeader?.example?.header_handle?.[0] ?? null,
        headerImageUrl: cardHeader?.example?.header_url?.[0] ?? null,
        bodyText: cardBodyText || null,
        bodyParameters: cardBodyText ? buildTemplateParameters(cardBodyText) : [],
        hasButtons: Boolean(cardButtons),
        buttons: Array.isArray(cardButtons?.buttons) ? cardButtons?.buttons : [],
      };
    });
  }

  const bodyComponent = components.find((component) => String(component.type ?? "").trim().toUpperCase() === "BODY");
  const bodyText = String(bodyComponent?.text ?? "").trim();
  if (bodyText) {
    structure.previewBody = bodyText;
    structure.bodyParameters = buildTemplateParameters(bodyText);
  }

  return structure;
}
