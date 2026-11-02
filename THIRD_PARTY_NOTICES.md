# Third-party software in Backstage

Backstage's own code is under the MIT license (see LICENSE). The installed app also contains:

## FFmpeg
- Used as a separate program to read, cut and make videos (it is not linked into Backstage).
- License: GNU General Public License v3 or later. The full license text is installed next to the program as `ffmpeg.LICENSE` (in `resources/app.asar.unpacked/node_modules/ffmpeg-static/`).
- Binary from [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) 5.3.0 (release b6.1.1). FFmpeg source code: https://ffmpeg.org/download.html and the build details in that project.

## Mediabunny
- Reads video and audio for playback and smart cut.
- License: Mozilla Public License 2.0. Source: https://github.com/Vanilagy/mediabunny (license text in `renderer/vendor/mediabunny.LICENSE.txt`).

## Electron
- The app framework (includes Chromium and Node.js, each under their own licenses, listed in `LICENSES.chromium.html` in the install folder).
- License: MIT. https://github.com/electron/electron

## electron-updater
- Installs updates from this repository's releases.
- License: MIT. https://github.com/electron-userland/electron-builder
