// /whatsapp-webhook/<webhook_key>: Meta's WhatsApp webhook for one account (verify GET + inbound messages POST).
// Public by design (Meta calls it); the function finds the account by its random key and checks the verify token.
import { webhooks } from "../../server/edge/registry";

type Ctx = { request: Request; waitUntil: (p: Promise<unknown>) => void };

export const onRequest = async ({ request, waitUntil }: Ctx) => {
  (globalThis as any).EdgeRuntime = { waitUntil };
  const { default: handler } = await webhooks["whatsapp-webhook"]();
  return handler(request);
};
