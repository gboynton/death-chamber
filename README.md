# Death Chamber

A 90-second trampoline escape game, recreated from a family Apple BASIC game.

## Play

Open `index.html` directly in a browser, or serve this folder as a static site. Audio is embedded in `sound.js`, so it also works without a server after an initial click, tap, or keypress.

- Mouse position sets rotational speed; click to jump.
- On touchscreens, hold one finger to steer and tap a second finger to jump.
- Space jumps; R restarts. The sound button mutes all effects.
- Enter as many rooms as possible in 90 seconds. Each room's opening is 10% smaller.
- Personal bests are stored locally in the current browser.

## Files and sound sources

The app uses plain HTML, Canvas, JavaScript, and Web Audio. No build step or dependencies are required. See [assets/SOURCES.md](assets/SOURCES.md) for sound provenance.

## GitHub Pages

Publish the `main` branch from `/(root)`. The intended live URL is https://gboynton.github.io/death-chamber/.
