import appMetaJson from "../app-meta.json";

export type AppMeta = {
  og_title?: string | null;
  og_description?: string | null;
  og_image_url?: string | null;
  favicon_url?: string | null;
  og_video_url?: string | null;
  marketplace_cover_url?: string | null;
};

const APP_HOST_ZONES = ["higgsfield.app", "higgsfield-dev.app"];

export function toOwnAssetUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("/")) return value;

  try {
    const url = new URL(value);
    const isAppHost = APP_HOST_ZONES.some(
      (zone) => url.hostname === zone || url.hostname.endsWith(`.${zone}`),
    );

    return isAppHost ? url.pathname + url.search : value;
  } catch {
    return value;
  }
}

export const appMeta = appMetaJson as AppMeta;
export const appFaviconUrl = toOwnAssetUrl(appMeta.favicon_url);
