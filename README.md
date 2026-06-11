# Figurinha

Sticker creation plugin for Manybot. Convert images, videos, and GIFs into WhatsApp stickers with automatic optimization.

## Features

- **Direct mode**: Send `!figurinha` with attached media or reply to media to create stickers instantly
- **Session mode**: Start a session to collect multiple media files, then generate all stickers at once
- **Automatic optimization**: Resizes images to 512x512, converts videos/GIFs to animated stickers
- **Quality adjustment**: Automatically reduces quality if sticker exceeds 900KB limit
- **Batch processing**: Collect up to 30 media files in a session before generating

## Usage

### Quick mode (single sticker)

```
!figurinha [attached image/video]
!figurinha [reply to media]
```

Creates one sticker immediately from the attached or replied media.

**Preserve transparency**: Send PNG as document to keep the background transparent:
1. Attach as **Document** (not image)
2. Select your `.png` file
3. Send with `!figurinha` command

### Session mode (multiple stickers)

```
!figurinha                          # Start session
[send multiple images/videos/GIFs]  # Collect media
!figurinha criar                    # Generate all stickers
```

### Stop session

```
!figurinha parar                    # Cancel active session
```

## Commands

| Command | Description |
|---------|-------------|
| `!figurinha` | Start new session or create sticker from attached/replied media |
| `!figurinha criar` | Generate stickers from collected session media |
| `!figurinha parar` | Stop and clear active session |

## Requirements

- FFmpeg installed on the system
- Node.js environment with Manybot plugin support

## Dependencies

- `wa-sticker-formatter` - WhatsApp sticker formatting library
- `ffmpeg` - Video/image processing (system dependency)

## Localization

Available in:
- English (`locale/en.json`)
- Portuguese (`locale/pt.json`)
- Spanish (`locale/es.json`)

