import { createMediaClient } from "@higgsfield/fnf/media";
import { createProfileClient } from "@higgsfield/fnf/profile";
import { createWorkflowPlatformAdapter } from "@higgsfield/fnf/workflow-platform";

/**
 * Server-only FNF clients. Workflow Platform attaches the current app/user
 * identity to `fnf.internal`; browser code must use the RPC/upload bridges.
 */
export function createServerFnf() {
  const adapter = createWorkflowPlatformAdapter({
    baseUrl: "https://fnf.internal",
  });

  return {
    adapter,
    media: createMediaClient({ mediaAdapter: adapter }),
    profile: createProfileClient({ profileAdapter: adapter }),
  };
}
