import crypto from "node:crypto";

const DEFAULT_MODEL = "gpt-image-2.5-sunburst-2026-09-08";
const MAX_BODY_BYTES = 3_500_000;
const MAX_PIXELS = 8_294_400;
const MIN_PIXELS = 655_360;
const MAX_EDGE = 3840;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 4;

const buckets = new Map();

function allowedOrigins() {
  return new Set(
    (
      process.env.CLOUD_PRO_ALLOWED_ORIGINS ??
      "https://nikoju1977.github.io"
    )
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function corsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;

  const allowed = allowedOrigins();
  if (allowed.has(origin)) return origin;

  try {
    const url = new URL(origin);
    if (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname.endsWith(".vercel.app")
    ) {
      return origin;
    }
  } catch {
    // Origine mal formée.
  }
  return null;
}

function setCors(req, res) {
  const origin = corsOrigin(req);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Ultravision-Token, X-Ultravision-Width, X-Ultravision-Height, X-Ultravision-Mode",
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function sameSecret(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

function rateAllowed(req) {
  const now = Date.now();
  const key = clientIp(req);
  const current = buckets.get(key);
  if (!current || now - current.startedAt > WINDOW_MS) {
    buckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= MAX_REQUESTS_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

async function readBody(req) {
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    throw Object.assign(
      new Error("Image Cloud Pro trop lourde."),
      { statusCode: 413 },
    );
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw Object.assign(
        new Error("Image Cloud Pro trop lourde."),
        { statusCode: 413 },
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function numericHeader(req, name) {
  const raw = req.headers[name];
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function sanitizeSize(req) {
  let width = numericHeader(req, "x-ultravision-width");
  let height = numericHeader(req, "x-ultravision-height");

  if (
    width <= 0 ||
    height <= 0 ||
    width > MAX_EDGE ||
    height > MAX_EDGE ||
    width * height > MAX_PIXELS ||
    width * height < MIN_PIXELS ||
    Math.max(width, height) / Math.min(width, height) > 3
  ) {
    throw Object.assign(
      new Error("Dimensions Cloud Pro non prises en charge."),
      { statusCode: 400 },
    );
  }

  width = Math.max(16, Math.round(width / 16) * 16);
  height = Math.max(16, Math.round(height / 16) * 16);

  while (width * height > MAX_PIXELS) {
    if (width >= height) width -= 16;
    else height -= 16;
  }

  return { width, height };
}

function fileExtension(type) {
  if (type === "image/png") return "png";
  if (type === "image/jpeg") return "jpg";
  return "webp";
}

const RESTORE_PROMPT = `
Perform a faithful professional photo restoration of the supplied reference image.

NON-NEGOTIABLE PRESERVATION:
- Preserve the exact subject identity, facial identity, pose, anatomy, composition, camera viewpoint, perspective, framing, object count, object positions, geometry, and scene layout.
- Preserve all readable text, logos, labels, signs, symbols, and numbers exactly as present. If text is unreadable, do not invent wording.
- Do not add, remove, replace, relocate, beautify, stylize, redesign, or reinterpret any person, object, background element, clothing, architecture, vegetation, vehicle, or sign.
- Do not alter age, facial proportions, body proportions, hairstyle, expression, ethnicity, or distinctive marks.
- Keep colors natural and faithful to the reference. Do not apply cinematic grading.

RESTORATION ONLY:
- Reduce compression artifacts, ringing, chroma noise, sensor noise, mild blur, and low-quality resampling artifacts.
- Recover natural edge definition and plausible photographic micro-texture only where supported by visible evidence.
- Keep skin, hair, fabric, foliage, text, straight lines, gradients, and fine repeating patterns natural.
- Avoid plastic skin, oversharpening, halos, staircase edges, invented pores, invented hair strands, or synthetic texture.
- Maintain realistic photographic optics and local contrast.

The goal is restoration, not re-creation. When evidence is ambiguous, preserve the reference instead of guessing.
`.trim();

async function callOpenAI(input, type, size) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw Object.assign(
      new Error("OPENAI_API_KEY absente du serveur."),
      { statusCode: 503 },
    );
  }

  const model =
    process.env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_MODEL;
  const quality =
    process.env.OPENAI_IMAGE_QUALITY?.trim() || "xhigh";

  const form = new FormData();
  form.append("model", model);
  form.append("prompt", RESTORE_PROMPT);
  form.append("quality", quality);
  form.append("size", `${size.width}x${size.height}`);
  form.append("output_format", "png");
  form.append("background", "auto");
  form.append(
    "image[]",
    new Blob([input], { type }),
    `ultravision-source.${fileExtension(type)}`,
  );

  const response = await fetch(
    "https://api.openai.com/v1/images/edits",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    },
  );

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ??
      `OpenAI Image API HTTP ${response.status}`;
    throw Object.assign(new Error(message), {
      statusCode:
        response.status >= 400 && response.status < 500
          ? 422
          : 502,
    });
  }

  const base64 = payload?.data?.[0]?.b64_json;
  if (typeof base64 !== "string" || !base64) {
    throw Object.assign(
      new Error("OpenAI n'a renvoyé aucune image."),
      { statusCode: 502 },
    );
  }

  return {
    bytes: Buffer.from(base64, "base64"),
    model,
    quality,
    requestId: response.headers.get("x-request-id") ?? "",
  };
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Méthode non autorisée." }));
    return;
  }

  const origin = req.headers.origin;
  if (origin && !corsOrigin(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Origine refusée." }));
    return;
  }

  const expectedToken = process.env.CLOUD_PRO_ACCESS_TOKEN ?? "";
  const suppliedToken = String(
    req.headers["x-ultravision-token"] ?? "",
  );
  if (
    !expectedToken ||
    !sameSecret(suppliedToken, expectedToken)
  ) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "Token Cloud Pro invalide ou serveur non configuré.",
      }),
    );
    return;
  }

  if (!rateAllowed(req)) {
    res.statusCode = 429;
    res.setHeader("Retry-After", "600");
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error:
          "Limite Cloud Pro atteinte. Réessaie dans quelques minutes.",
      }),
    );
    return;
  }

  const contentType = String(
    req.headers["content-type"] ?? "",
  )
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(
      contentType,
    )
  ) {
    res.statusCode = 415;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "Format Cloud Pro non pris en charge.",
      }),
    );
    return;
  }

  try {
    const size = sanitizeSize(req);
    const input = await readBody(req);
    if (input.length < 128) {
      throw Object.assign(
        new Error("Image d'entrée vide ou invalide."),
        { statusCode: 400 },
      );
    }

    const result = await callOpenAI(
      input,
      contentType,
      size,
    );

    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Ultravision-Model", result.model);
    res.setHeader("X-Ultravision-Quality", result.quality);
    if (result.requestId) {
      res.setHeader(
        "X-Ultravision-Request-Id",
        result.requestId,
      );
    }
    res.end(result.bytes);
  } catch (reason) {
    const status =
      Number(reason?.statusCode) || 500;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      JSON.stringify({
        error:
          reason instanceof Error
            ? reason.message
            : "Erreur Cloud Pro inconnue.",
      }),
    );
  }
}
