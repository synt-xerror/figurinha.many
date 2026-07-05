export const guardOptions = {
  timeout: false,
  cooldown: false,
  jitter:  false,
  typing:  false,
};

import fs           from "fs";
import path         from "path";
import { execFile }  from "child_process";
import { promisify } from "util";

import { createSticker } from "wa-sticker-formatter";

const execFileAsync = promisify(execFile);

const DOWNLOADS_DIR    = path.resolve("downloads");
const FFMPEG           = "ffmpeg";
const MAX_STICKER_SIZE = 900 * 1024;
const SESSION_TIMEOUT  = 2 * 60 * 1000;
const MAX_MEDIA        = 30;

const sessions = new Map();

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

function classifyError(err, t) {
  const m = err.message ?? "";
  if (m === t("error.tooLarge") || /900\s*KB/i.test(m)) return t("error.tooLarge");
  if (/invalid|corrupt|moov|codec|decode|unsupported/i.test(m))  return t("error.invalidFormat");
  return t("error.conversionFailed");
}

async function buildSticker(inputPath, isAnimated, t, senderName, stickerAuthor) {
  for (const quality of [80, 60, 40, 20]) {
    const buf = await createSticker(fs.readFileSync(inputPath), {
      pack:       senderName,
      author:      stickerAuthor,
      type:       isAnimated ? "FULL" : "STATIC",
      categories: ["🤖"],
      quality,
    });
    if (buf.length <= MAX_STICKER_SIZE) return buf;
  }
  throw new Error(t("error.tooLarge"));
}

function isGifMedia(media, isGif) {
  return (
    media.mimetype === "image/gif" ||
    (media.mimetype === "video/mp4" && isGif)
  );
}

function isSupported(media, gif) {
  return (
    media.mimetype?.startsWith("image/") ||
    media.mimetype?.startsWith("video/") ||
    gif
  );
}

async function processarUmaMedia(media, gif, ctx, t, stickerName, stickerAuthor) {
  ensureDir();

  const ext        = media.mimetype.split("/")[1];
  const isAnimated = media.mimetype.startsWith("video/") || gif;

  const id          = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inputPath   = path.join(DOWNLOADS_DIR, `${id}.${ext}`);
  const gifPath     = path.join(DOWNLOADS_DIR, `${id}-animated.gif`);
  const resizedPath = path.join(DOWNLOADS_DIR, `${id}-scaled.${ext}`);

  try {
    fs.writeFileSync(inputPath, Buffer.from(media.data, "base64"));

    let stickerInput;
    if (isAnimated) {
      await convertToGif(inputPath, gifPath, 12);
      stickerInput = gifPath;
    } else {
      await resizeImage(inputPath, resizedPath);
      stickerInput = resizedPath;
    }

    const buf = await buildSticker(stickerInput, isAnimated, t, stickerName, stickerAuthor);
    await ctx.send.sticker(buf);
    return { ok: true };
  } catch (err) {
    ctx.log.error(`Sticker error: ${err.message}`);
    return { ok: false, reason: classifyError(err, t) };
  } finally {
    cleanup(inputPath, gifPath, resizedPath);
  }
}

export default async function (ctx) {
  // Evita auto-gatilho e loops infinitos no processamento de texto/mídia
  if (ctx.msg.fromMe) return;

  const { msg, chat } = ctx;
  const { t }         = ctx.i18n.createT(import.meta.url);
  const prefix        = ctx.config.get("CMD_PREFIX");
  const chatId        = chat.id;
  const fName         = ctx.config.get("FIG_NAME", null)   || `${msg.senderName}\n`;
  const fAuthor       = ctx.config.get("FIG_AUTHOR", null) || `\nManyBot\nmanybot.stxerr.dev`;

  const isCmd = msg.is("figurinha") || msg.is("f");

  // ── coleta de mídia em sessão aberta ─────────────────────
  if (!isCmd && msg.hasMedia && sessions.has(chatId)) {
    const session = sessions.get(chatId);
    if (msg.sender !== session.author) return;

    const media = await msg.downloadMedia();
    if (!media) return;

    const gif = isGifMedia(media, msg.isGif);
    if (isSupported(media, gif) && session.medias.length < MAX_MEDIA) {
      session.medias.push({ media, isGif: gif });
    }
    return;
  }

  if (!isCmd) return;

  const sub = msg.args[0];

  // ── figurinha parar ──────────────────────────────────────
  if (sub === "parar") {
    const session = sessions.get(chatId);
    if (!session) {
      await ctx.msg.reply.text(t("session.noneActive", { command: prefix + "f" }));
      return;
    }
    clearTimeout(session.timeout);
    sessions.delete(chatId);
    await ctx.msg.reply.text(t("session.stopped"));
    return;
  }

  // ── figurinha criar ──────────────────────────────────────
  if (sub === "criar") {
    const session = sessions.get(chatId);
    if (!session) {
      await ctx.msg.reply.text(t("session.noneActive", { command: prefix + "f" }));
      return;
    }
    if (!session.medias.length) {
      await ctx.msg.reply.text(t("session.noMedia"));
      return;
    }
  
    clearTimeout(session.timeout);
    sessions.delete(chatId);
  
    await ctx.msg.reply.text(t("session.generating"));
  
    // Processamento pesado do lote enviado para a fila gerenciada pelo kernel
    ctx.download.enqueue(
      async () => {
        const results = [];
        for (const { media, isGif } of session.medias) {
          results.push(await processarUmaMedia(media, isGif, ctx, t, fName, fAuthor));
        }

        const ok   = results.filter(r => r.ok).length;
        const fail = results.filter(r => !r.ok).length;
        const summary = `✅ ${ok} ${t("session.created")}, ❌ ${fail} ${t("session.failed")}`;

        if (fail > 0) {
          const lines = results
            .map((r, i) => !r.ok ? `• ${i + 1}. ${r.reason}` : null)
            .filter(Boolean)
            .join("\n");
          await ctx.send.text(`${summary}\n\n${t("session.failDetail")}\n${lines}`);
        } else {
          await ctx.send.text(summary);
        }
        ctx.utils.emptyFolder(DOWNLOADS_DIR);
      },
      async (err) => {
        ctx.log.error(`Erro ao processar lote: ${err.message}`);
        await ctx.send.text(t("error.conversionFailed"));
      }
    );
    return;
  }

  // ── figurinha com mídia direta ───────────────────────────
  const mediasParaCriar = [];

  if (msg.hasMedia) {
    const media = await msg.downloadMedia();
    if (media) {
      const gif = isGifMedia(media, msg.isGif);
      if (isSupported(media, gif)) mediasParaCriar.push({ media, isGif: gif });
    }
  }

  if (msg.hasReply) {
    const quoted = await msg.getReply();
    if (quoted?.hasMedia) {
      const media = await quoted.downloadMedia();
      if (media) {
        const gif = isGifMedia(media, quoted.isGif ?? false);
        if (isSupported(media, gif)) mediasParaCriar.push({ media, isGif: gif });
      }
    }
  }

  if (mediasParaCriar.length > 0) {
    await ctx.msg.reply.text(t("session.generatingOne"));

    // Mídias imediatas também passam pela fila para não bloquear o Event Loop
    ctx.download.enqueue(
      async () => {
        for (const { media, isGif } of mediasParaCriar) {
          const result = await processarUmaMedia(media, isGif, ctx, t, fName, fAuthor);
          if (!result.ok) await ctx.msg.reply.text(`❌ ${result.reason}`);
        }
        ctx.utils.emptyFolder(DOWNLOADS_DIR);
      },
      async (err) => {
        ctx.log.error(`Erro ao criar figurinha direta: ${err.message}`);
        await ctx.msg.reply.text(t("error.conversionFailed"));
      }
    );
    return;
  }

  // ── figurinha sem mídia → abre sessão ───────────────────
  if (sessions.has(chatId)) {
    await ctx.msg.reply.text(
      `${t("session.alreadyOpen", { command: prefix + "f criar"})}`
    );
    return;
  }

  const timeout = setTimeout(async () => {
    sessions.delete(chatId);
    try {
      await ctx.send.text(
        `${t("session.expired")} \`${prefix}figurinha\` ${t("session.expiredEnd")}`
      );
    } catch {}
  }, SESSION_TIMEOUT);

  sessions.set(chatId, {
    author: msg.sender,
    medias: [],
    timeout,
  });

  await ctx.msg.reply.text(t("session.started", { command: prefix + "f criar" }));
}
