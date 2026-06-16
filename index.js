/**
 * plugins/figurinha/index.js
 *
 * Usage modes:
 *   command + attached media              → creates 1 sticker directly
 *   command + replying to media           → creates 1 sticker directly
 *   command + attached media + replying   → creates 2 stickers directly
 *   command (no media)                    → opens session
 *   command create (with open session)    → processes session media
 */

import fs            from "fs";
import path          from "path";
import { execFile }  from "child_process";
import { promisify } from "util";

import { createSticker } from "wa-sticker-formatter";

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────
const DOWNLOADS_DIR    = path.resolve("downloads");
const FFMPEG           = "ffmpeg";
const MAX_STICKER_SIZE = 900 * 1024;
const SESSION_TIMEOUT  = 2 * 60 * 1000;
const MAX_MEDIA        = 30;

// ── Internal state ───────────────────────────────────────────
// { chatId → { author, medias[], timeout } }
const sessions = new Map();

// ── Conversion ────────────────────────────────────────────────
function ensureDir() {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

function cleanup(...files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch { }
  }
}

async function convertToGif(input, output, fps = 12) {
  const filter = [
    `fps=${Math.min(fps, 12)},scale=512:512:flags=lanczos,split[s0][s1]`,
    `[s0]palettegen=max_colors=256:reserve_transparent=1[p]`,
    `[s1][p]paletteuse=dither=bayer`,
  ].join(";");
  await execFileAsync(FFMPEG, ["-i", input, "-filter_complex", filter, "-loop", "0", "-y", output]);
}

async function resizeImage(input, output) {
  await execFileAsync(FFMPEG, ["-i", input, "-vf", "scale=512:512:flags=lanczos", "-y", output]);
}

async function buildSticker(inputPath, isAnimated, t) {
  for (const quality of [80, 60, 40, 20]) {
    const buf = await createSticker(fs.readFileSync(inputPath), {
      pack:       t("pack"),
      author:     t("author"),
      type:       isAnimated ? "FULL" : "STATIC",
      categories: ["🤖"],
      quality,
    });
    if (buf.length <= MAX_STICKER_SIZE) return buf;
  }
  throw new Error(t("error.tooLarge"));
}

/**
 * Converte um objeto { mimetype, data } em sticker e envia.
 * Retorna true se ok, false se falhou.
 */
async function processarUmaMedia(media, isGif, ctx, msg, t) {
  ensureDir();

  const ext        = media.mimetype.split("/")[1];
  const isVideo    = media.mimetype.startsWith("video/");
  const isAnimated = isVideo || isGif;

  const id          = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inputPath   = path.join(DOWNLOADS_DIR, `${id}.${ext}`);
  const gifPath     = path.join(DOWNLOADS_DIR, `${id}-animated.gif`);
  const resizedPath = path.join(DOWNLOADS_DIR, `${id}-scaled.${ext}`);

  try {
    fs.writeFileSync(inputPath, Buffer.from(media.data, "base64"));

    let stickerInput;
    if (isAnimated) {
      await convertToGif(inputPath, gifPath, isVideo ? 12 : 24);
      stickerInput = gifPath;
    } else {
      await resizeImage(inputPath, resizedPath);
      stickerInput = resizedPath;
    }

    const buf = await buildSticker(stickerInput, isAnimated, t);
    await ctx.sendSticker(buf);
    return true;
  } catch (err) {
    ctx.log.error(`Sticker generation error: ${err.message}`);
    await msg.reply(t("error.generic"));
    return false;
  } finally {
    cleanup(inputPath, gifPath, resizedPath);
  }
}

/**
 * Verifica se uma mídia é suportada para sticker.
 */
function isSupported(media, isGif) {
  return (
    media.mimetype?.startsWith("image/") ||
    media.mimetype?.startsWith("video/") ||
    isGif
  );
}

const isGif = (media, msg) =>
  media.mimetype === "image/gif" ||
  (media.mimetype === "video/mp4" && msg.isGif);

// ── Plugin ───────────────────────────────────────────────────
export default async function (ctx) {
  const { msg } = ctx;
  const chatId  = ctx.chat.id;
  const prefix  = ctx.config.get("CMD_PREFIX");
  const { t }   = ctx.i18n.createT(import.meta.url);

  if (msg.is(prefix + "figurinha") || msg.is(prefix + "f")) {
    const session = sessions.get(chatId);
    if (!session) return;
    if (!msg.hasMedia) return;
    if (msg.sender !== session.author) return;

    const media = await msg.downloadMedia();
    if (!media) return;

    const gif = isGif(media, msg);

    if (isSupported(media, gif) && session.medias.length < MAX_MEDIA) {
      session.medias.push({ media, isGif: gif });
    }
    return;
  }

  const sub = msg.args[1];

  // ── figurinha parar ──────────────────────────────────────
  if (sub === "parar") {
    const session = sessions.get(chatId);
    if (!session) {
      await msg.reply(t("session.noneActive"));
      return;
    }

    clearTimeout(session.timeout);
    sessions.delete(chatId);

    await msg.reply(t("session.stopped"));
    return;
  }

  // ── figurinha criar ──────────────────────────────────────
  if (sub === "criar") {
    const session = sessions.get(chatId);

    if (!session) {
      await msg.reply(t("session.noneActive"));
      return;
    }
    if (!session.medias.length) {
      await msg.reply(t("session.noMedia"));
      return;
    }

    clearTimeout(session.timeout);
    await msg.reply(t("session.generating"));

    for (const { media, isGif } of session.medias) {
      await processarUmaMedia(media, isGif, ctx, msg, t);
    }

    await msg.reply(t("session.success"));
    sessions.delete(chatId);
    ctx.utils.emptyFolder(DOWNLOADS_DIR);
    return;
  }

  // ── figurinha com mídia direta ───────────────────────────
  const mediasParaCriar = [];

  if (msg.hasMedia) {
    const media = await msg.downloadMedia();
    if (media) {
      const gif = isGif(media, msg);

      if (isSupported(media, gif)) {
        mediasParaCriar.push({ media, isGif: gif });
      }
    }
  }

  if (msg.hasReply) {
    const quoted = await msg.getReply();
    if (quoted?.hasMedia) {
      const media = await quoted.downloadMedia();
      if (media) {
        const gif = isGif(media, quoted);
        if (isSupported(media, gif)) {
          mediasParaCriar.push({ media, isGif: gif });
        }
      }
    }
  }

  if (mediasParaCriar.length > 0) {
    await msg.reply(t("session.generatingOne"));

    for (const { media, isGif } of mediasParaCriar) {
      await processarUmaMedia(media, isGif, ctx, msg, t);
    }

    ctx.utils.emptyFolder(DOWNLOADS_DIR);
    return;
  }

  // ── figurinha sem mídia → abre sessão ───────────────────
  if (sessions.has(chatId)) {
    await msg.reply(
      `${t("session.alreadyOpen")} \`${prefix}figurinha criar\`.\n` +
        t("session.waitExpire")
    );
    return;
  }

  const timeout = setTimeout(async () => {
    sessions.delete(chatId);
    try {
      await msg.reply(
        `${t("session.expired")} \`${prefix}figurinha\` ${t("session.expiredEnd")}`
      );
    } catch {}
  }, SESSION_TIMEOUT);

  sessions.set(chatId, {
    author: msg.sender,
    medias: [],
    timeout,
  });

  await msg.reply(`${t("session.started")} *${msg.senderName}*!`);
}
