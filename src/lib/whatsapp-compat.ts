const PROJECT_ID = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "";

const missingWhatsappTablesByProject: Record<string, string[]> = {
};

const missingTables = new Set(missingWhatsappTablesByProject[PROJECT_ID] ?? []);

export function supportsWhatsappTable(tableName: string) {
  return !missingTables.has(tableName);
}

export function getWhatsappCompatibilityWarning(tableName: string) {
  if (supportsWhatsappTable(tableName)) return null;
  return `The ${tableName} table is not deployed in this production project yet.`;
}
