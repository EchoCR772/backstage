# Backstage

Trim, edit and share your game clips. Backstage finds your NVIDIA (ShadowPlay / Instant Replay), Discord and Encore clips by itself, groups them by game, and lets you trim one and paste it straight into Discord. Formerly called Clip Editor.

## Download
Get the latest **Backstage-Setup-x.y.z.exe** from [Releases](https://github.com/EchoCR772/backstage/releases/latest) and run it. If you had Clip Editor, Backstage replaces it and keeps your names, trims and settings.

Windows will probably say "Windows protected your PC" the first time, because the app isn't code-signed. Click **More info**, then **Run anyway**. After that the app tells you when an update is ready and installs it itself.

## What it does
- Library of your NVIDIA, Discord and Encore clips, by game, with previews on hover
- Trim: a quick Discord-style trim, saved as you go; the original file is never touched
- Edit: text, shapes, pictures, zoom, blur, crop, drawing, added music and volume changes on a full timeline
- Mute or turn down the game, your mic, or each person in a Discord call separately
- Copy Video (then Ctrl+V in Discord), drag a clip into Discord, or Export a file, also under 20 MB for Discord
- Fast exports at the original quality: plain trims only re-encode the frames around the cut points
- Rename clips inside the app; copies and exports use the name

Windows 10/11, 64-bit. Uses the graphics card for video when it can (NVIDIA, AMD or Intel).

## Building
```
npm install
npm start                # run from source
npx electron-builder --win nsis
```
Tests: see [tests/README.md](tests/README.md).

## License
MIT (see [LICENSE](LICENSE)). Third-party parts, including FFmpeg (GPL), are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
