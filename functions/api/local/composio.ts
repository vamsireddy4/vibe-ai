import { composioHandle } from "../../../server/composio";
import { sharedRoute } from "../../../server/pages";

export const onRequest = sharedRoute((body, id, origin, env) => composioHandle(body, id, origin, env.COMPOSIO_API_KEY ?? ""));
